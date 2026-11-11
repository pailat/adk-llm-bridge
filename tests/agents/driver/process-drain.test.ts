/**
 * A process that exited does not keep its run open. Once the CLI has exited,
 * its stdout and stderr are read until EOF, or until they stay idle for
 * 500 ms; a pipe that stays silent is cut within 5 s of the exit plus the
 * idle window, and a consumer that is behind is never cut. A grandchild that still holds a pipe
 * (a background task, an MCP server) is not waited for, and is not killed by
 * this rule. What the process wrote before it exited is read in full.
 */

import { describe, expect, test } from "bun:test";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { collectTail, readLines } from "../../../src/agents/driver/lines.js";
import {
  type DriverSubprocess,
  type SpawnRuntime,
  spawnSubprocess,
} from "../../../src/agents/driver/spawn.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The grandchild outlives every bound below, so a read that ends within them
// was ended by the drain rule, not by the grandchild.
const GRANDCHILD_S = 4;
const HANG_MS = 3_000;
const DRAIN_BOUND_MS = 1_500;
const OUTPUT_BYTES = 200 * 1024;

// Literal scripts. The first holds only stderr, the second holds both pipes.
const HOLDS_STDERR = `(sleep ${GRANDCHILD_S}; echo late >&2) >/dev/null & head -c ${OUTPUT_BYTES} /dev/zero | tr '\\000' x; echo; exit 0`;
const HOLDS_BOTH = `(sleep ${GRANDCHILD_S}; echo late) & head -c ${OUTPUT_BYTES} /dev/zero | tr '\\000' x; echo; exit 0`;

const runtimes: Array<[string, SpawnRuntime]> = [
  ["default runtime", {}],
  ["node path", { bun: null }],
];

/** Reads a stream with a 1 ms delay per chunk, so a stop mid-read would cut it. */
async function readSlowly(
  stream: ReadableStream<Uint8Array> | null,
): Promise<number> {
  let bytes = 0;
  if (!stream) return bytes;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    await sleep(1);
  }
  return bytes;
}

async function runScript(script: string, runtime: SpawnRuntime) {
  const child = spawnSubprocess("/bin/sh", ["-c", script], {}, runtime);
  let exitedAt = 0;
  const exited = child.exited.then((code) => {
    exitedAt = performance.now();
    return code;
  });
  const stderrLines: string[] = [];
  const reads = Promise.all([
    readSlowly(child.stdout),
    collectTail(child.stderr, stderrLines),
  ]).then(([bytes]) => ({ bytes, endedAt: performance.now() }));
  try {
    const winner = await Promise.race([
      reads.then((value) => ({ kind: "done" as const, value })),
      sleep(HANG_MS).then(() => ({ kind: "hang" as const })),
    ]);
    return { winner, exitedAt, code: await exited, stderrLines };
  } finally {
    child.killGroup?.("SIGKILL");
    child.kill("SIGKILL");
  }
}

describe.skipIf(process.platform === "win32")(
  "reads end after the process exited",
  () => {
    for (const [name, runtime] of runtimes) {
      describe(name, () => {
        test("a grandchild holding stderr: both reads end within the bound, no output is cut", async () => {
          const run = await runScript(HOLDS_STDERR, runtime);
          expect(run.winner.kind).toBe("done");
          if (run.winner.kind !== "done") return;
          expect(run.code).toBe(0);
          expect(run.winner.value.endedAt - run.exitedAt).toBeLessThan(
            DRAIN_BOUND_MS,
          );
          // 200 KiB of x and one newline, all of it read before the stop.
          expect(run.winner.value.bytes).toBe(OUTPUT_BYTES + 1);
        });

        test("a grandchild holding stdout and stderr: both reads end within the bound, no output is cut", async () => {
          const run = await runScript(HOLDS_BOTH, runtime);
          expect(run.winner.kind).toBe("done");
          if (run.winner.kind !== "done") return;
          expect(run.winner.value.endedAt - run.exitedAt).toBeLessThan(
            DRAIN_BOUND_MS,
          );
          expect(run.winner.value.bytes).toBe(OUTPUT_BYTES + 1);
        });

        test("a process with no grandchild ends its reads at EOF, with all output", async () => {
          const run = await runScript(
            `head -c ${OUTPUT_BYTES} /dev/zero | tr '\\000' x; echo err >&2; exit 0`,
            runtime,
          );
          expect(run.winner.kind).toBe("done");
          if (run.winner.kind !== "done") return;
          expect(run.winner.value.bytes).toBe(OUTPUT_BYTES);
          expect(run.stderrLines).toEqual(["err"]);
        });
      });
    }
  },
);

const BACKLOG_LINES = 400;
const LINE_DELAY_MS = 20;
const FINAL_MARKER = "final-marker-line";
// About 200 B per line, then a marker, then exit: the output is all in the
// pipe (or the stream buffer) when the process exits, long before the
// consumer has read it.
const PRINTS_BACKLOG = `i=0; while [ $i -lt ${BACKLOG_LINES} ]; do printf '%0200d\\n' $i; i=$((i+1)); done; echo ${FINAL_MARKER}; exit 0`;

describe.skipIf(process.platform === "win32")(
  "a slow consumer keeps what the process wrote before it exited",
  () => {
    for (const [name, runtime] of runtimes) {
      test(`${name}: every line is read, the last one too, past the 5 s window`, async () => {
        const child = spawnSubprocess(
          "/bin/sh",
          ["-c", PRINTS_BACKLOG],
          {},
          runtime,
        );
        const lines: string[] = [];
        const startedAt = performance.now();
        try {
          for await (const line of readLines(child.stdout)) {
            lines.push(line);
            await sleep(LINE_DELAY_MS);
          }
        } finally {
          child.killGroup?.("SIGKILL");
          child.kill("SIGKILL");
        }
        // The consumer outlasted the post-exit max window.
        expect(performance.now() - startedAt).toBeGreaterThan(5_000);
        expect(lines.length).toBe(BACKLOG_LINES + 1);
        expect(lines.at(-1)).toBe(FINAL_MARKER);
      }, 30_000);
    }
  },
);

describe.skipIf(process.platform === "win32")(
  "a CLI driver run ends when its process exits",
  () => {
    test("the Claude CLI run completes with exit 0 while a grandchild holds stderr", async () => {
      const script = `(sleep ${GRANDCHILD_S}; echo late >&2) >/dev/null & echo '{"type":"result","subtype":"success","result":"ok","is_error":false}'; exit 0`;
      let child: DriverSubprocess | undefined;
      const driver = new ClaudeCliDriver({
        spawn: () => {
          child = spawnSubprocess("/bin/sh", ["-c", script], {});
          return child;
        },
        env: {},
      });
      const events: ExternalAgentEvent[] = [];
      const run = (async () => {
        for await (const event of driver.run({
          provider: CLAUDE_PROVIDER,
          context: {} as never,
        })) {
          events.push(event);
        }
      })();
      try {
        const winner = await Promise.race([
          run.then(() => "done" as const),
          sleep(2_000).then(() => "hang" as const),
        ]);
        expect(winner).toBe("done");
        expect(events.at(-1)).toMatchObject({
          type: "completed",
          exitCode: 0,
        });
      } finally {
        child?.killGroup?.("SIGKILL");
        child?.kill("SIGKILL");
      }
    });
  },
);
