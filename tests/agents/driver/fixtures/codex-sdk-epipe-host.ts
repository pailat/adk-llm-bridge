/**
 * A host process for the Codex SDK stdin fault tests. It runs one Codex turn
 * against a stub binary and reports what the host saw, so a test can observe
 * an uncaught exception that would otherwise end the test runner itself.
 *
 * Usage: `<runtime> codex-sdk-epipe-host.ts <leg> <stub> <promptBytes> <abortMs> [mode]`.
 * - `driver` (Bun): a full `CodexSdkDriver` run, with the stub as
 *   `codexPathOverride`. Reports the error codes and the exit code.
 * - `sdk` (Bun or Node): a `Codex` client from `@openai/codex-sdk` with
 *   `containCodexSdkClient` applied, loaded from its source file under Bun,
 *   and from a bundle of it (`CODEX_EXEC_MODULE`) under Node, which cannot
 *   resolve the source's `.js` import specifiers.
 *   Reports what the turn threw.
 * `abortMs` > 0 aborts the turn after that many milliseconds. With mode
 * `break` (`sdk` leg) the host stops reading the turn after its first event
 * and aborts `abortMs` after that, while the child still runs.
 * The `sdk` leg also reports `tailMs`: the time from the turn's last event to
 * the end of the turn (a normal run must not wait for its input to settle).
 * `events` counts the events the turn yielded before it ended.
 * Prints one JSON line:
 * `{ codes, exitCode, thrown, message, uncaught, elapsedMs, tailMs, events }`.
 */

const [leg, stub, promptBytes, abortMs, mode = "run"] = process.argv.slice(2);
const uncaught: string[] = [];
process.on("uncaughtException", (error: Error & { code?: unknown }) => {
  uncaught.push(String(error.code ?? error.message));
});

const prompt = "x".repeat(Number(promptBytes));
const controller = new AbortController();
if (mode === "run" && Number(abortMs) > 0) {
  setTimeout(() => controller.abort(), Number(abortMs));
}
const started = Date.now();
const report: {
  codes: string[];
  exitCode?: number;
  thrown?: string;
  message?: string;
  uncaught: string[];
  elapsedMs?: number;
  tailMs?: number;
  events: number;
} = { codes: [], uncaught, events: 0 };

if (leg === "driver") {
  const agents = await import(
    new URL("../../../../src/agents/index.ts", import.meta.url).href
  );
  const driver = new agents.CodexSdkDriver({
    codexPathOverride: stub,
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
  });
  const request = {
    provider: agents.CODEX_PROVIDER,
    agent: { name: "codex" },
    context: {
      agent: { name: "codex" },
      session: { state: {}, events: [] },
      userContent: { role: "user", parts: [{ text: prompt }] },
    },
    permissions: { mode: "read-only", allowNetwork: true },
    abortSignal: controller.signal,
  };
  for await (const event of driver.run(request)) {
    if (event.type === "error") report.codes.push(String(event.code));
    else if (event.type !== "completed") report.events++;
    if (event.type === "completed") report.exitCode = event.exitCode;
  }
} else {
  const { Codex } = await import("@openai/codex-sdk");
  const { containCodexSdkClient } = await import(
    process.env.CODEX_EXEC_MODULE ??
      new URL(
        "../../../../src/agents/driver/codex-sdk-exec.ts",
        import.meta.url,
      ).href
  );
  const client = new Codex({
    codexPathOverride: stub,
    env: { PATH: "/usr/bin:/bin" },
  });
  containCodexSdkClient(client);
  try {
    const { events } = await client
      .startThread()
      .runStreamed(prompt, { signal: controller.signal });
    let lastEventAt = Date.now();
    for await (const _event of events) {
      lastEventAt = Date.now();
      report.events++;
      if (mode === "break") {
        setTimeout(() => controller.abort(), Number(abortMs));
        break;
      }
    }
    report.tailMs = Date.now() - lastEventAt;
  } catch (error) {
    const failure = error as Error & { code?: unknown };
    report.thrown = String(failure.code ?? failure.name);
    report.message = String(failure.message).slice(0, 200);
  }
}

// Give a late stream error time to surface before reporting.
await new Promise((done) => setTimeout(done, 300));
report.elapsedMs = Date.now() - started;
console.log(JSON.stringify(report));
process.exit(0);
