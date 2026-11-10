/**
 * The per-run private temp directory together with the Windows-safe launch
 * (interpreter + entry, host-owned cwd, chdir preload): the Claude CLI
 * driver's spawn merges three environments, and the run's temp directory must
 * reach the Claude process on every launch route and be removed on every exit
 * path, including a spawn that throws.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ClaudeCliDriver,
  type ClaudeCliSpawnOptions,
} from "../../../src/agents/driver/claude-cli.js";
import { AGENT_CWD_ENV } from "../../../src/agents/driver/launch.js";
import { BatchCommandRefusedError } from "../../../src/agents/driver/spawn.js";
import type {
  ExternalAgentEvent,
  ExternalAgentRunRequest,
} from "../../../src/agents/index.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

const NODE = execFileSync("node", ["-p", "process.execPath"], {
  encoding: "utf8",
}).trim();

// Host-owned: next to this file, not in a temp directory the driver treats
// as agent-writable (an entry there is refused).
const scratch = realpathSync.native(
  mkdtempSync(join(import.meta.dir, ".host-scratch-rf-")),
);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
function dir(name: string): string {
  const path = join(scratch, `${name}-${counter++}`);
  mkdirSync(path, { recursive: true });
  return path;
}

const INIT = { type: "system", subtype: "init", model: "claude-test" };
const RESULT = {
  type: "result",
  subtype: "success",
  result: "done",
  session_id: "s-1",
};

function request(workingDirectory: string): ExternalAgentRunRequest {
  return {
    provider: CLAUDE_PROVIDER,
    context: {} as ExternalAgentRunRequest["context"],
    instruction: "Report the temp directory.",
    workingDirectory,
    permissions: { mode: "ask", allowNetwork: true },
  };
}

async function collect(
  events: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const out: ExternalAgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/**
 * A fake Claude CLI entry: records what it sees of the run's temp directory
 * while it runs, then prints an init and a result line.
 */
function fakeClaudeEntry(where: string): { entry: string; record: string } {
  const entry = join(where, "fake-claude.cjs");
  const record = join(where, "record.json");
  writeFileSync(
    entry,
    [
      'const fs = require("node:fs");',
      "const root = process.env.CLAUDE_CODE_TMPDIR ?? null;",
      "const tmp = process.env.TMPDIR ?? null;",
      "const mode = (p) => { try { return fs.statSync(p).mode & 0o777; } catch { return null; } };",
      `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ root, tmp, rootMode: root && mode(root), tmpMode: tmp && mode(tmp), cwd: process.cwd(), agentCwdVar: process.env.${AGENT_CWD_ENV} ?? null }));`,
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(INIT)}\n${JSON.stringify(RESULT)}\n`)});`,
    ].join("\n"),
  );
  return { entry, record };
}

describe("the run's private temp directory on every Claude CLI route", () => {
  if (process.platform === "win32") return;

  test("interpreter + entry (host cwd, chdir preload): the real Node process sees the private TMPDIR, then it is removed", async () => {
    const work = dir("work");
    const { entry, record } = fakeClaudeEntry(dir("host"));
    const events = await collect(
      new ClaudeCliDriver({
        env: { PATH: "/usr/bin:/bin" },
        interpreter: NODE,
        entry,
      } as never).run(request(work)),
    );

    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
    const seen = JSON.parse(readFileSync(record, "utf8"));
    // RF reached the process through the WINRUN launch.
    expect(seen.root).toStartWith("/");
    expect(seen.tmp).toBe(join(seen.root, `claude-${process.getuid?.()}`));
    expect(seen.rootMode).toBe(0o700);
    expect(seen.tmpMode).toBe(0o700);
    // WINRUN still holds: the preload moved into the workspace and removed
    // its variable, so RF's env did not displace the launch env.
    expect(seen.cwd).toBe(realpathSync(work));
    expect(seen.agentCwdVar).toBeNull();
    // Disposed after the run.
    expect(existsSync(seen.root)).toBe(false);
  });

  test("credential env cannot override the launch variable or the private temp directory", async () => {
    const work = dir("work");
    const { entry } = fakeClaudeEntry(dir("host"));
    let seen: ClaudeCliSpawnOptions | undefined;
    let args: readonly string[] = [];
    await collect(
      new ClaudeCliDriver({
        env: { PATH: "/usr/bin:/bin" },
        interpreter: NODE,
        entry,
        spawn: (
          _command: string,
          a: readonly string[],
          options: ClaudeCliSpawnOptions,
        ) => {
          seen = options;
          args = a;
          return {
            stdout: [
              `${JSON.stringify(INIT)}\n`,
              `${JSON.stringify(RESULT)}\n`,
            ],
            stderr: [],
            exited: Promise.resolve(0),
          };
        },
      } as never).run({
        ...request(work),
        // A provider whose credential allowlist names the launch and temp
        // variables: credential env is the one host-controlled source that
        // reaches the merge, and it must lose to both.
        provider: {
          ...CLAUDE_PROVIDER,
          envAllowlist: [
            ...(CLAUDE_PROVIDER.envAllowlist ?? []),
            AGENT_CWD_ENV,
            "TMPDIR",
            "CLAUDE_CODE_TMPDIR",
          ],
        } as never,
        credential: {
          kind: "env",
          env: {
            [AGENT_CWD_ENV]: "/elsewhere",
            TMPDIR: "/tmp",
            CLAUDE_CODE_TMPDIR: "/tmp",
          },
        } as never,
      }),
    );
    expect(args[0]).toBe("--import");
    expect(seen?.cwd).toBe(realpathSync(join(entry, "..")));
    expect(seen?.env?.[AGENT_CWD_ENV]).toBe(work);
    expect(seen?.env?.CLAUDE_CODE_TMPDIR).toBeDefined();
    expect(seen?.env?.TMPDIR).toBe(
      join(
        seen?.env?.CLAUDE_CODE_TMPDIR as string,
        `claude-${process.getuid?.()}`,
      ),
    );
    expect(existsSync(seen?.env?.CLAUDE_CODE_TMPDIR as string)).toBe(false);
  });

  for (const [name, error, code] of [
    [
      "batch refusal",
      new BatchCommandRefusedError("claude resolved to claude.cmd"),
      "EXTERNAL_AGENT_BATCH_COMMAND_REFUSED",
    ],
    [
      "missing binary",
      Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
      undefined,
    ],
  ] as const) {
    test(`a spawn that throws (${name}) still removes the temp directory`, async () => {
      let root: string | undefined;
      const events = await collect(
        new ClaudeCliDriver({
          env: { PATH: "/bin" },
          spawn: (
            _command: string,
            _args: readonly string[],
            options: ClaudeCliSpawnOptions,
          ) => {
            root = options.env?.CLAUDE_CODE_TMPDIR;
            expect(existsSync(root as string)).toBe(true);
            throw error;
          },
        } as never).run(request(dir("work"))),
      );
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
      if (code) {
        expect(events.some((e) => (e as { code?: string }).code === code)).toBe(
          true,
        );
      }
      expect(root).toBeDefined();
      expect(existsSync(root as string)).toBe(false);
    });
  }
});
