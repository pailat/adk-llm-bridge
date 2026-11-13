/**
 * A host that handles Ctrl-C with `process.once("SIGINT", ...)` (or
 * `process.on`) while a CLI runs keeps control: Node and Bun drop a `once` wrapper before they call it,
 * so the bridge must not read "no other listener" as "re-raise and end the
 * host". The host drains and exits 0. Fake CLI only (`/bin/sleep`).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withDeadline } from "../helpers.js";

const POSIX = process.platform !== "win32";
const SPAWN_MODULE = resolve(
  import.meta.dir,
  "../../../src/agents/driver/spawn.ts",
);
const dir = mkdtempSync(join(tmpdir(), "adk-host-once-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NODE = (() => {
  const found = spawnSync(
    "node",
    ["-e", "process.stdout.write(process.execPath)"],
    { encoding: "utf8" },
  );
  return found.status === 0 && found.stdout ? found.stdout : undefined;
})();

type Host = { label: string; bin: string; forceNodeSpawn: boolean };
const HOSTS: Host[] = [
  {
    label: "Bun host, Bun spawn",
    bin: process.execPath,
    forceNodeSpawn: false,
  },
  {
    label: "Bun host, Node spawn",
    bin: process.execPath,
    forceNodeSpawn: true,
  },
  ...(NODE ? [{ label: "Node host", bin: NODE, forceNodeSpawn: false }] : []),
];

/**
 * @param when - Register the host's listener before the CLI starts (the
 * bridge's hooks are installed after it) or after.
 * @param method - `process.once` or `process.on`.
 */
function writeHost(
  host: Host,
  when: "before" | "after",
  index: number,
  method: "once" | "on" = "once",
): string {
  const native = host.bin !== process.execPath;
  const file = join(
    dir,
    `host-${index}-${method}-${when}.${native ? "mts" : "ts"}`,
  );
  const listen = [
    `process.${method}('SIGINT', () => {`,
    "  console.log('abort requested');",
    "  setTimeout(() => { console.log('DRAINED ' + (cliDone ? 'cli-ended' : 'cli-alive')); process.exit(0); }, 300);",
    "});",
  ].join("\n");
  writeFileSync(
    file,
    [
      `import { spawnSubprocess } from ${JSON.stringify(SPAWN_MODULE)};`,
      "let cliDone = false;",
      when === "before" ? listen : "",
      `const child = spawnSubprocess("/bin/sleep", ["5"], { env: { PATH: "/bin:/usr/bin" } }, ${host.forceNodeSpawn ? "{ bun: null }" : "{}"});`,
      "child.exited.then(() => { cliDone = true; }, () => { cliDone = true; });",
      when === "after" ? listen : "",
      "setTimeout(() => process.kill(process.pid, 'SIGINT'), 200);",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  return file;
}

async function runHost(
  host: Host,
  file: string,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  out: string;
}> {
  const child = spawn(host.bin, [file], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  child.stdout?.on("data", (chunk) => {
    out += String(chunk);
  });
  return withDeadline(
    new Promise((done) => {
      child.once("exit", (code, signal) => done({ code, signal, out }));
    }),
    10_000,
  );
}

let index = 0;
for (const host of HOSTS) {
  describe.if(POSIX)(`process.once SIGINT host (${host.label})`, () => {
    for (const when of ["before", "after"] as const) {
      test(`listener registered ${when} the CLI starts: the host drains and exits 0`, async () => {
        const result = await runHost(host, writeHost(host, when, index++));
        expect(result.out).toContain("abort requested");
        expect(result.out).toContain("DRAINED cli-ended");
        expect(result.signal).toBeNull();
        expect(result.code).toBe(0);
      });
    }

    test("a process.on listener runs once per signal: the bridge does not re-raise", async () => {
      const result = await runHost(
        host,
        writeHost(host, "before", index++, "on"),
      );
      expect(result.out.match(/abort requested/g)).toHaveLength(1);
      expect(result.out).toContain("DRAINED cli-ended");
      expect(result.code).toBe(0);
    });
  });
}
