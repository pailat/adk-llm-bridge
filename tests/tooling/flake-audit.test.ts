import { describe, expect, test } from "bun:test";
import {
  failedTests,
  parseArgs,
  summarize,
} from "../../scripts/flake-audit.js";

describe("flake audit", () => {
  test("failedTests reads the (fail) lines of a bun test report", () => {
    const output = [
      "tests/acme/widget.test.ts:",
      "(pass) Acme widget > renders [0.10ms]",
      "(fail) Acme widget > saves the order [5003.12ms]",
      "  ^ this test timed out after 5000ms.",
      "(fail) Acme ledger > totals",
      " 1 pass",
      " 2 fail",
    ].join("\n");
    expect(failedTests(output)).toEqual([
      "Acme widget > saves the order",
      "Acme ledger > totals",
    ]);
  });

  test("summarize counts green runs and how often each test failed", () => {
    const summary = summarize([
      { run: 1, exitCode: 0, failed: [] },
      { run: 2, exitCode: 1, failed: ["Acme widget > saves the order"] },
      { run: 3, exitCode: 1, failed: ["Acme widget > saves the order"] },
      { run: 4, exitCode: 1, failed: [] },
    ]);
    expect(summary.green).toBe(1);
    expect(summary.runs).toBe(4);
    expect(summary.ok).toBe(false);
    expect(summary.flaky).toEqual([
      { name: "Acme widget > saves the order", runs: [2, 3] },
    ]);
    // A red run without a (fail) line (a crash, an unhandled error) still
    // counts as red.
    expect(summary.redWithoutFailures).toEqual([4]);
  });

  test("summarize is ok only when every run is green", () => {
    const summary = summarize([
      { run: 1, exitCode: 0, failed: [] },
      { run: 2, exitCode: 0, failed: [] },
    ]);
    expect(summary).toMatchObject({ ok: true, green: 2, runs: 2, flaky: [] });
  });

  test("parseArgs defaults to 20 runs and passes the rest to bun test", () => {
    expect(parseArgs([])).toEqual({ runs: 20, testArgs: [] });
    expect(parseArgs(["--runs", "3", "tests/utils"])).toEqual({
      runs: 3,
      testArgs: ["tests/utils"],
    });
    expect(() => parseArgs(["--runs", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--runs"])).toThrow(/positive integer/);
  });
});
