/**
 * `fx ask --json` prints ONE JSON object when the run ends. These tests feed
 * the driver the real objects fx printed (fixtures/, from the fx 0.0.16 probe)
 * and variations of them. No real fx runs.
 */
import { describe, expect, test } from "bun:test";
import { FxCliDriver } from "../../../src/agents/driver/fx-cli.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { FX_PROVIDER } from "../../../src/agents/provider/fx.js";
import { withDeadline } from "../helpers.js";
import {
  baseConfig,
  collect,
  errorsOf,
  FX_MODEL_ID,
  FX_SUCCESS,
  fixture,
  hangingProcess,
  makeRequest,
  printingSpawn,
} from "./helpers.js";

const request = (overrides: Parameters<typeof makeRequest>[1] = {}) =>
  makeRequest(FX_PROVIDER, overrides);

async function runWith(
  stdout: string,
  exit = 0,
  stderr = "",
): Promise<ExternalAgentEvent[]> {
  const fake = printingSpawn(stdout, exit, stderr);
  return collect(
    new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(request()),
  );
}

const json = (value: unknown) => `${JSON.stringify(value)}\n`;
const types = (events: ExternalAgentEvent[]) => events.map((e) => e.type);
/** The trimmed `output` text of a fixture. */
const fixtureOutput = (name: string) =>
  (JSON.parse(fixture(name)) as { output: string }).output.trim();
const completedOf = (events: ExternalAgentEvent[]) =>
  events.at(-1) as Extract<ExternalAgentEvent, { type: "completed" }>;

describe("success", () => {
  test("the real probe object gives started, output, completed", async () => {
    const events = await runWith(json(FX_SUCCESS));
    expect(types(events)).toEqual(["started", "output", "completed"]);
    expect(events[0]).toMatchObject({ type: "started", providerId: "fx" });
    expect(events[1]).toMatchObject({ type: "output", content: "ok" });
    const completed = events[2] as Extract<
      ExternalAgentEvent,
      { type: "completed" }
    >;
    expect(completed.exitCode).toBe(0);
    expect(completed.model).toBe(FX_MODEL_ID);
    expect(completed.numTurns).toBe(0);
    expect(completed.usage).toMatchObject({
      inputTokens: 18782,
      outputTokens: 4,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 18778,
    });
    // fx reports no dollars.
    expect(completed.usage).not.toHaveProperty("totalCostUsd");
  });

  test("a read-only tool run (fixture) pairs the replayed tool events", async () => {
    const events = await runWith(fixture("read-file.json"));
    expect(types(events)).toEqual([
      "started",
      "tool_call",
      "tool_result",
      "output",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      type: "tool_call",
      name: "read_file",
      callId: "fx-tool-0",
      metadata: { fx: { replayed: true, status: "success" } },
    });
    expect(events[2]).toMatchObject({
      type: "tool_result",
      name: "read_file",
      callId: "fx-tool-0",
      metadata: { fx: { replayed: true, status: "success" } },
    });
    expect((events[2] as { error?: string }).error).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      exitCode: 0,
      numTurns: 1,
      usage: { inputTokens: 37530, cacheReadInputTokens: 36990 },
    });
  });

  test("an empty final_output falls back to output", async () => {
    const events = await runWith(
      json({ ...FX_SUCCESS, final_output: "", output: "from output" }),
    );
    expect(events.find((e) => e.type === "output")).toMatchObject({
      content: "from output",
    });
  });

  test("tool calls with success and error status are paired, in order", async () => {
    const events = await runWith(
      json({
        ...FX_SUCCESS,
        tool_calls: [
          { name: "read_file", status: "success" },
          { name: "shell", status: "error" },
        ],
      }),
    );
    const tools = events.filter(
      (e) => e.type === "tool_call" || e.type === "tool_result",
    );
    expect(
      tools.map((e) => [e.type, (e as { callId?: string }).callId]),
    ).toEqual([
      ["tool_call", "fx-tool-0"],
      ["tool_result", "fx-tool-0"],
      ["tool_call", "fx-tool-1"],
      ["tool_result", "fx-tool-1"],
    ]);
    expect(tools[2]).toMatchObject({ name: "shell" });
    expect(tools[3]).toMatchObject({
      name: "shell",
      error: expect.any(String),
      metadata: { fx: { replayed: true, status: "error" } },
    });
    expect((tools[1] as { error?: string }).error).toBeUndefined();
  });

  test("a null usage counter is left out, never 0", async () => {
    const events = await runWith(
      json({
        ...FX_SUCCESS,
        usage: { input_tokens: null, output_tokens: 7 },
      }),
    );
    const usage = (
      events.at(-1) as Extract<ExternalAgentEvent, { type: "completed" }>
    ).usage;
    expect(usage).toMatchObject({ outputTokens: 7 });
    expect(usage).not.toHaveProperty("inputTokens");
    expect(usage).not.toHaveProperty("cacheReadInputTokens");
  });

  test("an empty model leaves completed.model unset", async () => {
    const events = await runWith(json({ ...FX_SUCCESS, model: "" }));
    expect(events.at(-1)).not.toHaveProperty("model");
  });

  test("a non-JSON line gives a recoverable warning, then the normal result", async () => {
    const events = await runWith(`warming up\n${json(FX_SUCCESS)}`);
    expect(errorsOf(events)).toEqual([
      expect.objectContaining({
        code: "FX_CLI_NON_JSON_LINE",
        recoverable: true,
      }),
    ]);
    expect(events.some((e) => e.type === "output")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
  });

  test("a result line followed by two junk lines is used, with one warning per junk line", async () => {
    const events = await runWith(`${json(FX_SUCCESS)}junk one\njunk two\n`);
    expect(
      errorsOf(events).map((e) => [e.code, e.recoverable, e.message]),
    ).toEqual([
      ["FX_CLI_NON_JSON_LINE", true, expect.stringContaining("junk one")],
      ["FX_CLI_NON_JSON_LINE", true, expect.stringContaining("junk two")],
    ]);
    expect(events.find((e) => e.type === "output")).toMatchObject({
      content: "ok",
    });
    expect(completedOf(events)).toMatchObject({
      exitCode: 0,
      model: FX_MODEL_ID,
    });
  });

  test("the driver reports the resolved model it trusts", () => {
    expect(new FxCliDriver(baseConfig()).reportsResolvedModel).toBe(true);
  });
});

describe("failures", () => {
  test("NonInteractivePermissionRequired (fixture): tool events, usage, then the error", async () => {
    const events = await runWith(
      fixture("permission-required.json"),
      1,
      fixture("permission-required.stderr.txt"),
    );
    // A failed run has no answer: the fx text rides in the error.
    expect(types(events)).toEqual([
      "started",
      "tool_call",
      "tool_result",
      "error",
      "completed",
    ]);
    expect(events[2]).toMatchObject({
      type: "tool_result",
      name: "write_file",
      error: expect.any(String),
      metadata: { fx: { replayed: true, status: "error" } },
    });
    const [error] = errorsOf(events);
    expect(error?.code).toBe("FX_CLI_PERMISSION_REQUIRED");
    expect(error?.recoverable).toBe(false);
    expect(error?.message).toContain("workspace-write");
    expect(error?.message).toContain("That action did not run");
    expect(error?.message).not.toContain("nothing ran");
    expect(error?.message).toContain("allowUnsandboxedShell");
    expect(error?.message).toContain("full-access");
    expect(error?.message).toContain("blocked action: Writing file");
    expect(error?.message).toEndWith(
      ` fx output: ${fixtureOutput("permission-required.json")}`,
    );
    const completed = events.at(-1) as Extract<
      ExternalAgentEvent,
      { type: "completed" }
    >;
    expect(completed.exitCode).toBe(1);
    expect(completed.usage).toMatchObject({
      inputTokens: 18746,
      outputTokens: 350,
    });
    // The empty model of a failed run is not reported.
    expect(completed).not.toHaveProperty("model");
  });

  test("a shell tool call with extra keys and an object error (fixture)", async () => {
    const events = await runWith(
      fixture("shell-permission-required.json"),
      1,
      fixture("shell-permission-required.stderr.txt"),
    );
    expect(types(events)).toEqual([
      "started",
      "tool_call",
      "tool_result",
      "error",
      "completed",
    ]);
    expect(events[1]).toMatchObject({ type: "tool_call", name: "shell" });
    const result = events[2] as { error?: string; name: string };
    expect(result.name).toBe("shell");
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain("rejected");
    const [error] = errorsOf(events);
    expect(error?.code).toBe("FX_CLI_PERMISSION_REQUIRED");
    expect(error?.recoverable).toBe(false);
    expect(error?.message).toContain(
      "blocked action: Running touch touched.txt",
    );
    expect(error?.message).toEndWith(
      ` fx output: ${fixtureOutput("shell-permission-required.json")}`,
    );
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
  });

  test("the permission error message never carries the child env", async () => {
    const fake = printingSpawn(
      fixture("permission-required.json"),
      1,
      fixture("permission-required.stderr.txt"),
    );
    const events = await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn })).run(
        request({
          credential: {
            kind: "env",
            env: { AI_GATEWAY_API_KEY: "SECRET-KEY" },
          },
        }),
      ),
    );
    expect(errorsOf(events)[0]?.message).not.toContain("SECRET-KEY");
  });

  test("model_not_found only in output (fixture): INVALID_REQUEST, not recoverable", async () => {
    const events = await runWith(
      fixture("model-not-found.json"),
      1,
      fixture("model-not-found.stderr.txt"),
    );
    const [error] = errorsOf(events);
    expect(error?.code).toBe("INVALID_REQUEST");
    // "HTTP 502" must not make it a retryable transport error.
    expect(error?.recoverable).toBe(false);
    expect(error?.message).toContain("model_not_found");
    expect(error?.message).toContain("anthropic/does-not-exist");
    expect(error?.message).toBe(error?.message.trim());
    const completed = events.at(-1) as Extract<
      ExternalAgentEvent,
      { type: "completed" }
    >;
    expect(completed.exitCode).toBe(1);
    expect(completed.usage ?? {}).not.toHaveProperty("inputTokens");
    expect(completed.usage ?? {}).not.toHaveProperty("outputTokens");
    expect(errorsOf(events)).toHaveLength(1);
  });

  test("auth_failure is AUTH_ERROR and not recoverable", async () => {
    const events = await runWith(
      json({
        ...FX_SUCCESS,
        exit_code: 1,
        final_output: "",
        output: "Authentication failed: invalid AI_GATEWAY_API_KEY",
        auth_failure: {
          source: "AI_GATEWAY_API_KEY",
          reason: "invalid or expired key",
          http_status: 401,
        },
      }),
      1,
    );
    expect(errorsOf(events)[0]).toMatchObject({
      code: "AUTH_ERROR",
      recoverable: false,
    });
  });

  test("recovery.need quota is QUOTA_EXHAUSTED and not recoverable", async () => {
    const events = await runWith(
      json({
        ...FX_SUCCESS,
        exit_code: 1,
        final_output: "",
        output: "quota exhausted",
        recovery: {
          state: "need_user",
          attempt: 1,
          message: "Your quota is exhausted",
          need: "quota",
        },
      }),
      1,
    );
    expect(errorsOf(events)[0]).toMatchObject({
      code: "QUOTA_EXHAUSTED",
      recoverable: false,
    });
  });

  for (const need of ["content_filter", "rejected", "too_long"]) {
    test(`recovery.need ${need} is INVALID_REQUEST and not recoverable`, async () => {
      const events = await runWith(
        json({
          ...FX_SUCCESS,
          exit_code: 1,
          final_output: "",
          output: "refused",
          recovery: {
            state: "need_user",
            attempt: 1,
            message: `fx needs the user: ${need}`,
            need,
          },
        }),
        1,
      );
      expect(errorsOf(events)[0]).toMatchObject({
        code: "INVALID_REQUEST",
        recoverable: false,
      });
    });
  }

  test("a failure the classifier does not know falls back to FX_CLI_ERROR", async () => {
    const events = await runWith(
      json({
        ...FX_SUCCESS,
        exit_code: 1,
        final_output: "",
        output: "the flux capacitor misaligned",
        model: "",
      }),
      1,
    );
    expect(errorsOf(events)).toHaveLength(1);
    expect(errorsOf(events)[0]).toMatchObject({
      code: "FX_CLI_ERROR",
      message: expect.stringContaining("flux capacitor"),
    });
  });

  test("exit 1 with usage text on stderr and no JSON is FX_CLI_EXIT with the stderr tail", async () => {
    const events = await runWith(
      "",
      1,
      "fx ask: unknown flag --bogus\nUsage: fx ask [options] [prompt]\n",
    );
    expect(types(events)).toEqual(["started", "error", "completed"]);
    expect(errorsOf(events)[0]?.code).toBe("FX_CLI_EXIT");
    expect(errorsOf(events)[0]?.message).toContain("unknown flag --bogus");
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
  });

  test("exit 0 with no JSON is FX_CLI_NO_RESULT", async () => {
    const events = await runWith("just some text\n", 0);
    expect(errorsOf(events).map((e) => e.code)).toContain("FX_CLI_NO_RESULT");
    expect(errorsOf(events).some((e) => e.code === "FX_CLI_EXIT")).toBe(false);
  });

  test("exit 0 with empty stdout is FX_CLI_NO_RESULT", async () => {
    const events = await runWith("", 0);
    expect(errorsOf(events)[0]?.code).toBe("FX_CLI_NO_RESULT");
  });
});

describe("a failed run has no answer", () => {
  test("an error-named failure emits no output event; its text rides in the error", async () => {
    const events = await runWith(
      json({
        ...FX_SUCCESS,
        exit_code: 1,
        error: "Boom",
        output: "it broke badly\n",
        final_output: "partial answer",
        model: "",
      }),
      1,
    );
    expect(events.some((e) => e.type === "output")).toBe(false);
    expect(errorsOf(events)).toHaveLength(1);
    expect(errorsOf(events)[0]?.message).toContain("Boom");
    expect(errorsOf(events)[0]?.message).toContain("it broke badly");
    expect(completedOf(events).exitCode).toBe(1);
  });

  test("the permission error appends the fx output, cut to the message limit", async () => {
    const long = "y".repeat(10_000);
    const events = await runWith(
      json({
        ...FX_SUCCESS,
        exit_code: 1,
        error: "NonInteractivePermissionRequired",
        output: `  ${long}  \n`,
        final_output: "",
        model: "",
      }),
      1,
    );
    expect(events.some((e) => e.type === "output")).toBe(false);
    const [error] = errorsOf(events);
    expect(error?.code).toBe("FX_CLI_PERMISSION_REQUIRED");
    expect(error?.message).toContain(" fx output: yyyy");
    expect(error?.message).not.toContain("y".repeat(4097));
    expect(error?.message.startsWith("fx needed an approval")).toBe(true);

    // With no fx text there is nothing to append.
    const blank = await runWith(
      json({
        ...FX_SUCCESS,
        exit_code: 1,
        error: "NonInteractivePermissionRequired",
        output: "  \n",
        final_output: "",
        model: "",
      }),
      1,
    );
    expect(blank.some((e) => e.type === "output")).toBe(false);
    expect(errorsOf(blank)[0]?.message).not.toContain("fx output:");
  });

  // Process exit 0 with a result that is not a clean success.
  const notSuccess: Array<[string, Record<string, unknown>, string]> = [
    ["exit_code: 1", { exit_code: 1 }, "ok"],
    ['exit_code: "1"', { exit_code: "1" }, "exit_code"],
    ["exit_code: null", { exit_code: null }, "exit_code"],
    [
      "exit_code: 0 with error: Something",
      { exit_code: 0, error: "Something" },
      "Something",
    ],
  ];
  for (const [name, patch, names] of notSuccess) {
    test(`process exit 0 with ${name} is one error, no output, exitCode 1`, async () => {
      const events = await runWith(json({ ...FX_SUCCESS, ...patch }), 0);
      expect(types(events)).toEqual(["started", "error", "completed"]);
      expect(errorsOf(events)).toHaveLength(1);
      expect(errorsOf(events)[0]?.message).toContain(names);
      expect(completedOf(events).exitCode).toBe(1);
    });
  }

  for (const exit_code of ['"1"', "null"]) {
    test(`a result whose only problem is exit_code ${exit_code} is FX_CLI_ERROR, not recoverable`, async () => {
      const events = await runWith(
        json({ ...FX_SUCCESS, exit_code: JSON.parse(exit_code) }),
        0,
      );
      expect(errorsOf(events)[0]).toMatchObject({
        code: "FX_CLI_ERROR",
        recoverable: false,
        message: expect.stringContaining("exit_code"),
      });
    });
  }

  test("completed.exitCode is the process exit when non-zero, else a non-zero JSON exit_code, else 1", async () => {
    const jsonOnly = await runWith(json({ ...FX_SUCCESS, exit_code: 2 }), 0);
    expect(completedOf(jsonOnly).exitCode).toBe(2);
    const processOnly = await runWith(json(FX_SUCCESS), 3);
    expect(errorsOf(processOnly)).toHaveLength(1);
    expect(processOnly.some((e) => e.type === "output")).toBe(false);
    expect(completedOf(processOnly).exitCode).toBe(3);
    const neither = await runWith(
      json({ ...FX_SUCCESS, exit_code: 0, error: "Something" }),
      0,
    );
    expect(completedOf(neither).exitCode).toBe(1);
    const both = await runWith(json({ ...FX_SUCCESS, exit_code: 2 }), 3);
    expect(completedOf(both).exitCode).toBe(3);
    // A clean success is still a success.
    const clean = await runWith(json(FX_SUCCESS), 0);
    expect(types(clean)).toEqual(["started", "output", "completed"]);
    expect(completedOf(clean).exitCode).toBe(0);
  });
});

describe("abort", () => {
  test("aborting kills the process (SIGTERM) and ends without completed", async () => {
    const fake = hangingProcess();
    const controller = new AbortController();
    const iterator = new FxCliDriver(baseConfig({ spawn: fake.spawn as never }))
      .run(request({ abortSignal: controller.signal }))
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: "started" });

    controller.abort();
    const rest: ExternalAgentEvent[] = [];
    await withDeadline(
      (async () => {
        while (true) {
          const next = await iterator.next();
          if (next.done) return;
          rest.push(next.value);
        }
      })(),
      2000,
      "run did not end after abort",
    );
    expect(fake.state.kills).toBe(1);
    expect(rest.some((e) => e.type === "completed")).toBe(false);
  });

  test("an already-aborted signal never spawns", async () => {
    const fake = hangingProcess();
    const events = await collect(
      new FxCliDriver(baseConfig({ spawn: fake.spawn as never })).run(
        request({ abortSignal: AbortSignal.abort() }),
      ),
    );
    expect(fake.state.spawned).toBe(0);
    expect(events.some((e) => e.type === "completed")).toBe(false);
  });
});
