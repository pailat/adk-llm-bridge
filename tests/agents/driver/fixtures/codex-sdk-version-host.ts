/**
 * Runs `CodexSdkDriver` turns with the installed `@openai/codex-sdk` version
 * reported as the first argument, in its own process so the module mock
 * cannot leak into other tests. The client is a real SDK client.
 *
 * Usage: `bun codex-sdk-version-host.ts <version|none> [allow] [stub] [runs]`.
 * - `none` reports a version the driver cannot read.
 * - `allow` builds the driver with `allowUncontainedCodexSdk: true`;
 *   `truthy` with the string `"true"` instead.
 * - `stub` is the codex binary (default `/opt/codex`, which never starts).
 * - `runs` is the number of turns on one driver (default 1).
 * Prints one JSON line: `{ codes, message, turns, execRuns, exitCodes,
 * warnings, contained, sameExec }`.
 */

import { mock } from "bun:test";
import { setLogger } from "@google/adk";

const [versionArg, allow, stub = "/opt/codex", runs = "1"] =
  process.argv.slice(2);
const version = versionArg === "none" ? undefined : versionArg;
const execModule = new URL(
  "../../../../src/agents/driver/codex-sdk-exec.ts",
  import.meta.url,
).pathname;
const real = { ...(await import(execModule)) };
// Bun updates the module's namespace in place, so keep the real function.
const contain = real.containCodexSdkClient;
mock.module(execModule, () => ({
  ...real,
  installedCodexSdkVersion: () => version,
  containCodexSdkClient: (client: unknown) =>
    contain(client, { sdkVersion: version }),
}));

const warnings: string[] = [];
const noop = () => {};
setLogger({
  log: noop,
  debug: noop,
  info: noop,
  error: noop,
  setLogLevel: noop,
  warn: (message: unknown) => {
    warnings.push(/\] \[([^\]\s]+)\]/.exec(String(message))?.[1] ?? "");
  },
});

const { Codex } = await import("@openai/codex-sdk");
const agents = await import(
  new URL("../../../../src/agents/index.ts", import.meta.url).href
);

let turns = 0;
let execRuns = 0;
const client = new Codex({
  codexPathOverride: stub,
  env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
});
const sdkExec = (
  client as unknown as { exec: { run: (...args: never[]) => unknown } }
).exec;
const sdkRun = sdkExec.run.bind(sdkExec);
sdkExec.run = (...args: never[]) => {
  execRuns++;
  return sdkRun(...args);
};
const startThread = client.startThread.bind(client);
client.startThread = (...args: Parameters<typeof startThread>) => {
  turns++;
  return startThread(...args);
};
const driver = new agents.CodexSdkDriver({
  sdk: client,
  ...(allow === "allow" ? { allowUncontainedCodexSdk: true } : {}),
  // A truthy value that is not `true`, as an env-driven host might pass.
  ...(allow === "truthy" ? { allowUncontainedCodexSdk: "true" } : {}),
});
const report: {
  codes: string[];
  message?: string;
  turns: number;
  execRuns: number;
  exitCodes: number[];
  warnings: string[];
  contained: boolean;
  sameExec: boolean;
} = {
  codes: [],
  turns: 0,
  execRuns: 0,
  exitCodes: [],
  warnings,
  contained: false,
  sameExec: false,
};
for (let run = 0; run < Number(runs); run++) {
  for await (const event of driver.run({
    provider: agents.CODEX_PROVIDER,
    agent: { name: "codex" },
    context: {
      agent: { name: "codex" },
      session: { state: {}, events: [] },
      userContent: { role: "user", parts: [{ text: "go" }] },
    },
    permissions: { mode: "read-only", allowNetwork: true },
  })) {
    if (event.type === "error") {
      report.codes.push(String(event.code));
      report.message = String(event.message);
    }
    if (event.type === "completed") report.exitCodes.push(event.exitCode);
  }
}
const exec = (client as unknown as { exec: unknown }).exec;
report.turns = turns;
report.execRuns = execRuns;
report.contained = exec instanceof real.ContainedCodexExec;
report.sameExec = exec === sdkExec;
console.log(JSON.stringify(report));
