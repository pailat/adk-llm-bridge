/**
 * How `ContainedCodexExec.run` ends a turn when the process misbehaves: a
 * spawn that fails, an `error` on its stdout or stderr, a process that
 * ignores SIGTERM, and a grandchild that keeps the output pipe open after
 * Codex exited. Each bound is an explicit race, so a hang is a failed
 * assertion and not a test timeout.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ContainedCodexExec } from "../../../src/agents/driver/codex-sdk-exec.js";
import { waitUntil } from "../helpers.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const HANG_MS = 2_000;

type Outcome =
  | { kind: "done"; lines: string[] }
  | { kind: "error"; error: unknown; lines: string[] }
  | { kind: "hang"; lines: string[] };

/** Runs one turn; resolves with how it ended, or `hang` after `limitMs`. */
async function runTurn(
  exec: ContainedCodexExec,
  limitMs = HANG_MS,
): Promise<Outcome> {
  const lines: string[] = [];
  const turn = (async (): Promise<Outcome> => {
    try {
      for await (const line of exec.run({ input: "hi" })) lines.push(line);
      return { kind: "done", lines };
    } catch (error) {
      return { kind: "error", error, lines };
    }
  })();
  return Promise.race([
    turn,
    sleep(limitMs).then((): Outcome => ({ kind: "hang", lines })),
  ]);
}

const fields = (executablePath: string) => ({
  executablePath,
  pathDirs: [],
  envOverride: { PATH: "/usr/bin:/bin" },
  configOverrides: undefined,
  rawConfigOverrides: undefined,
});

describe.skipIf(process.platform === "win32")(
  "a spawn that fails ends the turn with its error",
  () => {
    test("a missing executable rejects with ENOENT", async () => {
      const outcome = await runTurn(
        new ContainedCodexExec(fields("/nonexistent/codex")),
      );
      expect(outcome.kind).toBe("error");
      if (outcome.kind !== "error") return;
      expect((outcome.error as NodeJS.ErrnoException).code).toBe("ENOENT");
    });

    test("a directory as the executable rejects with EACCES", async () => {
      const dir = mkdtempSync(join(tmpdir(), "codex-exec-dir-"));
      try {
        const outcome = await runTurn(new ContainedCodexExec(fields(dir)));
        expect(outcome.kind).toBe("error");
        if (outcome.kind !== "error") return;
        expect((outcome.error as NodeJS.ErrnoException).code).toBe("EACCES");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

/** A child whose streams and events the test drives. */
function scriptedChild() {
  const stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    write: () => true,
    end: () => undefined,
    destroy() {
      stdin.destroyed = true;
    },
  });
  const kills: Array<NodeJS.Signals | number | undefined> = [];
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    killed: false,
    kill: (signal?: NodeJS.Signals | number) => {
      kills.push(signal);
      return true;
    },
  });
  const exit = (code: number) => {
    child.exitCode = code;
    child.emit("exit", code, null);
  };
  return { child, stdin, exit, kills };
}

describe("an error on the child's stdout or stderr stays in the turn", () => {
  test("a stderr error is swallowed and the turn finishes normally", async () => {
    const { child, stdin, exit } = scriptedChild();
    const exec = new ContainedCodexExec(fields("/opt/codex"), {
      spawn: () => child as never,
    });
    const turn = runTurn(exec);
    await sleep(10);
    stdin.emit("finish");
    // With no listener this emit throws, which is an uncaught error on a
    // real stream.
    expect(() =>
      child.stderr.emit("error", new Error("stderr broke")),
    ).not.toThrow();
    child.stdout.write('{"type":"x"}\n');
    exit(0);
    child.stdout.end();
    const outcome = await turn;
    expect(outcome).toEqual({ kind: "done", lines: ['{"type":"x"}'] });
  });

  test("a stdout error rejects the turn with it", async () => {
    const { child, stdin } = scriptedChild();
    const exec = new ContainedCodexExec(fields("/opt/codex"), {
      spawn: () => child as never,
    });
    const turn = runTurn(exec);
    await sleep(10);
    stdin.emit("finish");
    const failure = new Error("stdout broke");
    expect(() => child.stdout.emit("error", failure)).not.toThrow();
    const outcome = await turn;
    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(outcome.error).toBe(failure);
  });
});

describe("a child that ignores SIGTERM is killed", () => {
  test("SIGKILL follows the grace after a turn that ended early", async () => {
    const { child, exit, kills } = scriptedChild();
    const exec = new ContainedCodexExec(fields("/opt/codex"), {
      spawn: () => child as never,
      killGraceMs: 50,
    });
    const iterator = exec.run({ input: "hi" });
    const first = iterator.next();
    await sleep(10);
    child.stdout.write('{"type":"x"}\n');
    expect((await first).value).toBe('{"type":"x"}');
    await iterator.return(undefined);
    expect(kills).toEqual([undefined]);
    const escalated = await waitUntil(() => kills.includes("SIGKILL"), 1_000);
    expect(escalated).toBe(true);
    expect(kills).toEqual([undefined, "SIGKILL"]);
    exit(137);
  });

  test("no SIGKILL once the child exited within the grace", async () => {
    const { child, exit, kills } = scriptedChild();
    const exec = new ContainedCodexExec(fields("/opt/codex"), {
      spawn: () => child as never,
      killGraceMs: 50,
    });
    const iterator = exec.run({ input: "hi" });
    const first = iterator.next();
    await sleep(10);
    child.stdout.write('{"type":"x"}\n');
    await first;
    await iterator.return(undefined);
    exit(143);
    await sleep(200);
    expect(kills).toEqual([undefined]);
  });
});

describe.skipIf(process.platform === "win32")("real processes", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-exec-process-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const stub = (name: string, script: string) => {
    const path = join(dir, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
    return path;
  };
  // Ignores SIGTERM and never stops by itself. The loop (not one long
  // sleep) leaves no stray process behind once the shell is killed.
  const ignoresTerm = stub(
    "ignores-term",
    "#!/bin/sh\ntrap '' TERM\ncat > /dev/null\nprintf '%s\\n' '{\"type\":\"x\"}'\nwhile :; do sleep 0.2; done\n",
  );
  // Prints one line and exits 0 while a grandchild holds the stdout pipe.
  const leavesGrandchild = stub(
    "leaves-grandchild",
    "#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '{\"type\":\"x\"}'\n(sleep 4) &\nexit 0\n",
  );

  test("a child that ignores SIGTERM is gone within the grace plus 1 s", async () => {
    let pid: number | undefined;
    const exec = new ContainedCodexExec(fields(ignoresTerm), {
      spawn: (command, args, options) => {
        const child: ChildProcess = nodeSpawn(command, args, options);
        pid = child.pid;
        return child;
      },
      killGraceMs: 300,
    });
    const iterator = exec.run({ input: "hi" });
    const first = await Promise.race([
      iterator.next(),
      sleep(5_000).then(() => "timeout" as const),
    ]);
    expect(first).toMatchObject({ value: '{"type":"x"}' });
    await iterator.return(undefined);
    const alive = () => {
      try {
        process.kill(pid as number, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(typeof pid).toBe("number");
    expect(await waitUntil(() => !alive(), 300 + 1_000)).toBe(true);
  });

  test("a grandchild holding stdout after Codex exited does not hold the turn", async () => {
    const started = performance.now();
    const outcome = await runTurn(
      new ContainedCodexExec(fields(leavesGrandchild)),
      3_000,
    );
    expect(outcome).toEqual({ kind: "done", lines: ['{"type":"x"}'] });
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});
