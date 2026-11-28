/**
 * Runs the test suite several times in a row and reports the tests that
 * failed in any run. Releases are gated on 20 consecutive green runs on Linux.
 *
 * Usage: `bun scripts/flake-audit.ts [--runs N] [bun test args...]`. Each run's
 * full output goes to `$FLAKE_AUDIT_DIR` (default: a new temporary directory).
 * Exits 1 when any run is red.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One suite run: its exit code and the names of the tests that failed. */
export interface RunResult {
  run: number;
  exitCode: number;
  failed: string[];
}

/** What the runs add up to. */
export interface AuditSummary {
  runs: number;
  green: number;
  ok: boolean;
  /** Each failing test with the runs it failed in, most failures first. */
  flaky: { name: string; runs: number[] }[];
  /** Red runs that reported no failing test (a crash or an unhandled error). */
  redWithoutFailures: number[];
}

/** The names on the `(fail)` lines of a `bun test` report. */
export function failedTests(output: string): string[] {
  const names: string[] = [];
  for (const match of output.matchAll(
    /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm,
  )) {
    if (match[1] !== undefined) names.push(match[1]);
  }
  return names;
}

export function summarize(results: RunResult[]): AuditSummary {
  const byName = new Map<string, number[]>();
  for (const { run, failed } of results) {
    for (const name of new Set(failed)) {
      byName.set(name, [...(byName.get(name) ?? []), run]);
    }
  }
  const green = results.filter((r) => r.exitCode === 0).length;
  return {
    runs: results.length,
    green,
    ok: green === results.length,
    flaky: [...byName]
      .map(([name, runs]) => ({ name, runs }))
      .sort((a, b) => b.runs.length - a.runs.length),
    redWithoutFailures: results
      .filter((r) => r.exitCode !== 0 && r.failed.length === 0)
      .map((r) => r.run),
  };
}

export function parseArgs(argv: string[]): {
  runs: number;
  testArgs: string[];
} {
  const testArgs = [...argv];
  let runs = 20;
  const at = testArgs.indexOf("--runs");
  if (at !== -1) {
    const value = Number(testArgs[at + 1]);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error("--runs takes a positive integer");
    }
    runs = value;
    testArgs.splice(at, 2);
  }
  return { runs, testArgs };
}

if (import.meta.main) {
  const { runs, testArgs } = parseArgs(process.argv.slice(2));
  const dir =
    process.env.FLAKE_AUDIT_DIR ?? mkdtempSync(join(tmpdir(), "flake-audit-"));
  mkdirSync(dir, { recursive: true });
  const results: RunResult[] = [];
  for (let run = 1; run <= runs; run++) {
    const started = performance.now();
    const proc = Bun.spawnSync([process.execPath, "test", ...testArgs], {
      stdout: "pipe",
      stderr: "pipe",
    });
    // bun test writes the report to stderr.
    const output = proc.stdout.toString() + proc.stderr.toString();
    writeFileSync(join(dir, `run-${run}.log`), output);
    const result = {
      run,
      exitCode: proc.exitCode ?? 1,
      failed: failedTests(output),
    };
    results.push(result);
    const seconds = ((performance.now() - started) / 1000).toFixed(0);
    console.log(
      `run ${run}/${runs}: ${result.exitCode === 0 ? "green" : "RED"} in ${seconds} s` +
        (result.failed.length ? ` (${result.failed.join("; ")})` : ""),
    );
  }
  const summary = summarize(results);
  console.log(`\n${summary.green}/${summary.runs} runs green. Logs: ${dir}`);
  for (const { name, runs: failedIn } of summary.flaky) {
    console.log(`  ${name}: failed in runs ${failedIn.join(", ")}`);
  }
  if (summary.redWithoutFailures.length) {
    console.log(
      `  red without a failing test: runs ${summary.redWithoutFailures.join(", ")}`,
    );
  }
  process.exit(summary.ok ? 0 : 1);
}
