import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  failedTests,
  logDir,
  parseArgs,
  runSuite,
  summarize,
} from "../../scripts/flake-audit.js";

const scratch = mkdtempSync(join(tmpdir(), "flake-audit-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("flake audit", () => {
  test("failedTests reads the (fail) lines with the file they belong to", () => {
    const output = [
      "tests/acme/widget.test.ts:",
      "(pass) Acme widget > renders [0.10ms]",
      "(fail) Acme widget > saves the order [5003.12ms]",
      "  ^ this test timed out after 5000ms.",
      "tests/acme/ledger.test.ts:",
      "(fail) Acme ledger > totals",
      " 1 pass",
      " 2 fail",
    ].join("\n");
    expect(failedTests(output)).toEqual([
      "tests/acme/widget.test.ts > Acme widget > saves the order",
      "tests/acme/ledger.test.ts > Acme ledger > totals",
    ]);
  });

  test("failedTests keeps same-named tests in different files apart", () => {
    const output = [
      "tests/providers/acme-a.test.ts:",
      "(fail) connect > rejects without key [1.00ms]",
      "tests/providers/acme-b.test.ts:",
      "(fail) connect > rejects without key [1.00ms]",
    ].join("\n");
    expect(failedTests(output)).toEqual([
      "tests/providers/acme-a.test.ts > connect > rejects without key",
      "tests/providers/acme-b.test.ts > connect > rejects without key",
    ]);
  });

  test("failedTests names each failure once when Bun repeats them at the end", () => {
    const output = [
      "tests/acme/widget.test.ts:",
      "(fail) Acme widget > saves the order [5003.12ms]",
      "",
      "1 tests failed:",
      "(fail) Acme widget > saves the order [5003.12ms]",
      " 0 pass",
      " 1 fail",
    ].join("\n");
    expect(failedTests(output)).toEqual([
      "tests/acme/widget.test.ts > Acme widget > saves the order",
    ]);
  });

  test("summarize counts green runs and how often each test failed", () => {
    const summary = summarize([
      { run: 1, exitCode: 0, timedOut: false, failed: [] },
      { run: 2, exitCode: 1, timedOut: false, failed: ["Acme widget > saves"] },
      { run: 3, exitCode: 1, timedOut: false, failed: ["Acme widget > saves"] },
      { run: 4, exitCode: 1, timedOut: false, failed: [] },
      { run: 5, exitCode: 1, timedOut: true, failed: [] },
    ]);
    expect(summary.green).toBe(1);
    expect(summary.runs).toBe(5);
    expect(summary.ok).toBe(false);
    expect(summary.failing).toEqual([
      { name: "Acme widget > saves", runs: [2, 3], everyRun: false },
    ]);
    // A red run without a (fail) line (a crash, an unhandled error) still
    // counts as red; a run that hit the time limit is listed on its own.
    expect(summary.redWithoutFailures).toEqual([4]);
    expect(summary.timedOut).toEqual([5]);
  });

  test("summarize tells a test that failed in every run from a flaky one", () => {
    const summary = summarize([
      {
        run: 1,
        exitCode: 1,
        timedOut: false,
        failed: ["Acme > broken", "Acme > flaky"],
      },
      { run: 2, exitCode: 1, timedOut: false, failed: ["Acme > broken"] },
    ]);
    expect(summary.failing).toEqual([
      { name: "Acme > broken", runs: [1, 2], everyRun: true },
      { name: "Acme > flaky", runs: [1], everyRun: false },
    ]);
  });

  test("summarize is ok only when every run is green", () => {
    const summary = summarize([
      { run: 1, exitCode: 0, timedOut: false, failed: [] },
      { run: 2, exitCode: 0, timedOut: false, failed: [] },
    ]);
    expect(summary).toMatchObject({ ok: true, green: 2, runs: 2, failing: [] });
  });

  test("parseArgs defaults to 20 runs and passes the rest to bun test", () => {
    expect(parseArgs([])).toEqual({ runs: 20, testArgs: [] });
    expect(parseArgs(["--runs", "3", "tests/utils"])).toEqual({
      runs: 3,
      testArgs: ["tests/utils"],
    });
    expect(parseArgs(["--runs=5", "tests/utils"])).toEqual({
      runs: 5,
      testArgs: ["tests/utils"],
    });
    expect(() => parseArgs(["--runs", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--runs"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--runs=x"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--runs", "2", "--runs=3"])).toThrow(/once/);
  });

  test("logDir makes a fresh directory for each audit, also under FLAKE_AUDIT_DIR", () => {
    const base = join(scratch, "logs");
    const first = logDir({ FLAKE_AUDIT_DIR: base });
    writeFileSync(join(first, "run-7.log"), "old audit");
    const second = logDir({ FLAKE_AUDIT_DIR: base });
    expect(second).not.toBe(first);
    expect(second.startsWith(base)).toBe(true);
    expect(existsSync(join(second, "run-7.log"))).toBe(false);
    // An empty value counts as unset.
    expect(logDir({ FLAKE_AUDIT_DIR: "" }).startsWith(tmpdir())).toBe(true);
  });

  test("runSuite stops a run that never exits and keeps its output", () => {
    const result = runSuite(
      [
        process.execPath,
        "-e",
        "console.log('acme started'); setInterval(() => {}, 1000);",
      ],
      { timeoutMs: 500 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("acme started");
  });

  test("runSuite names failing tests even when the parent forces colour", () => {
    const dir = join(scratch, "suite");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "acme.test.ts"),
      [
        'import { expect, test } from "bun:test";',
        'test("acme writes without a newline", () => {',
        '  process.stdout.write("x");',
        "  expect(1).toBe(2);",
        "});",
      ].join("\n"),
    );
    const result = runSuite([process.execPath, "test", dir], {
      timeoutMs: 60_000,
      env: { ...process.env, FORCE_COLOR: "1" },
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).not.toContain("\x1b[");
    expect(failedTests(result.output)).toHaveLength(1);
    expect(failedTests(result.output)[0]).toEndWith(
      "acme.test.ts > acme writes without a newline",
    );
  });
});
