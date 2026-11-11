/**
 * The driver bounds the stdout line it parses. An fx result
 * is one JSON line; a line over the bound is not parsed and is refused with a
 * typed error. The bound is 8 MiB, fx's own ACP message limit.
 */
import { describe, expect, test } from "bun:test";
import * as fxCli from "../../../src/agents/driver/fx-cli.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { FX_PROVIDER } from "../../../src/agents/provider/fx.js";
import {
  baseConfig,
  collect,
  errorsOf,
  FX_SUCCESS,
  makeRequest,
  recordingSpawn,
} from "./helpers.js";

const MIB = 1024 * 1024;
const LIMIT = 8 * MIB;

const request = () => makeRequest(FX_PROVIDER);
const types = (events: ExternalAgentEvent[]) => events.map((e) => e.type);

async function runChunks(chunks: readonly string[], exit = 0) {
  const fake = recordingSpawn(chunks, exit);
  return collect(
    new fxCli.FxCliDriver(baseConfig({ spawn: fake.spawn })).run(request()),
  );
}

/** A valid fx result line (without the newline) of exactly `length` characters. */
function resultLineOf(length: number): string {
  const empty = JSON.stringify({ ...FX_SUCCESS, pad: "" });
  return JSON.stringify({
    ...FX_SUCCESS,
    pad: "a".repeat(length - empty.length),
  });
}

describe("bounded stdout line", () => {
  test("FX_CLI_MAX_LINE_CHARS is 8 MiB", () => {
    expect(fxCli.FX_CLI_MAX_LINE_CHARS).toBe(LIMIT);
  });

  test("a line longer than the bound is not parsed: FX_CLI_RESULT_TOO_LARGE, exitCode 1, no output", async () => {
    const events = await runChunks([`{${"a".repeat(LIMIT + 9)}\n`], 0);
    expect(types(events)).toEqual(["started", "error", "completed"]);
    const [error] = errorsOf(events);
    expect(error?.code).toBe("FX_CLI_RESULT_TOO_LARGE");
    expect(error?.recoverable).toBe(false);
    // The message names the bound (8 MiB = 8388608) and never holds the line.
    expect(error?.message).toMatch(/8388608|8 MiB|8MiB/);
    expect(error?.message.length).toBeLessThan(10_000);
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
  });

  test("the bound holds when the line arrives in many chunks", async () => {
    const chunk = "a".repeat(MIB);
    const events = await runChunks([
      `{${chunk}`,
      ...Array.from({ length: 8 }, () => chunk),
      "\n",
    ]);
    expect(errorsOf(events)).toHaveLength(1);
    expect(errorsOf(events)[0]?.code).toBe("FX_CLI_RESULT_TOO_LARGE");
    expect(events.some((e) => e.type === "output")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 1 });
  });

  test("the bound is inclusive: exactly the bound is read, one character more is refused", async () => {
    const atBound = resultLineOf(LIMIT);
    expect(atBound.length).toBe(LIMIT);
    const read = await runChunks([`${atBound}\n`]);
    expect(types(read)).toEqual(["started", "output", "completed"]);

    const over = await runChunks([`${resultLineOf(LIMIT + 1)}\n`]);
    expect(errorsOf(over).map((e) => e.code)).toEqual([
      "FX_CLI_RESULT_TOO_LARGE",
    ]);
    expect(over.some((e) => e.type === "output")).toBe(false);
  });
});
