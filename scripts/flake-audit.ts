/**
 * Runs the test suite several times in a row and reports the tests that
 * failed in any run. Releases are gated on 20 consecutive green runs on Linux.
 *
 * Usage: `bun scripts/flake-audit.ts [--runs N] [bun test args...]`. Each run's
 * full output goes to a new directory: under `$FLAKE_AUDIT_DIR` when set, in
 * the temporary directory otherwise. A run that has not exited after
 * `$FLAKE_AUDIT_RUN_TIMEOUT_S` seconds (default 900) is stopped and counted as
 * red. Exits 1 when any run is red.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One suite run: its exit code and the names of the tests that failed. */
export interface RunResult {
  run: number;
  exitCode: number;
  /** The run was stopped because it did not exit in time. */
  timedOut: boolean;
  failed: string[];
}

/** What the runs add up to. */
export interface AuditSummary {
  runs: number;
  green: number;
  ok: boolean;
  /**
   * Each failing test with the runs it failed in, most failures first.
   * `everyRun` marks a test that failed in every run: a steady failure, not
   * a flaky one.
   */
  failing: { name: string; runs: number[]; everyRun: boolean }[];
  /** Red runs that reported no failing test (a crash or an unhandled error). */
  redWithoutFailures: number[];
  /** Runs stopped because they did not exit in time. */
  timedOut: number[];
}

const FILE_HEADER = /^(\S.*\.[cm]?[jt]sx?):$/;
const FAIL_LINE = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/;
// Bun may repeat every `(fail)` line in a closing "N tests failed:" block.
const REPEAT_BLOCK = /^\s*\d+ tests? failed:$/;

/**
 * The failing tests of a plain (uncoloured) `bun test` report, each named
 * `<file> > <describe> > <test>` and listed once.
 */
export function failedTests(output: string): string[] {
  const names = new Set<string>();
  let file: string | undefined;
  for (const line of output.split("\n")) {
    if (REPEAT_BLOCK.test(line)) break;
    const header = FILE_HEADER.exec(line);
    if (header) {
      file = header[1];
      continue;
    }
    const fail = FAIL_LINE.exec(line);
    if (fail?.[1] !== undefined) {
      names.add(file ? `${file} > ${fail[1]}` : fail[1]);
    }
  }
  return [...names];
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
    failing: [...byName]
      .map(([name, runs]) => ({
        name,
        runs,
        everyRun: runs.length === results.length,
      }))
      .sort((a, b) => b.runs.length - a.runs.length),
    redWithoutFailures: results
      .filter((r) => r.exitCode !== 0 && !r.timedOut && r.failed.length === 0)
      .map((r) => r.run),
    timedOut: results.filter((r) => r.timedOut).map((r) => r.run),
  };
}

export function parseArgs(argv: string[]): {
  runs: number;
  testArgs: string[];
} {
  const testArgs: string[] = [];
  let runs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    let value: string | undefined;
    if (arg === "--runs") {
      value = argv[++i] ?? "";
    } else if (arg.startsWith("--runs=")) {
      value = arg.slice("--runs=".length);
    } else {
      testArgs.push(arg);
      continue;
    }
    if (runs !== undefined) throw new Error("--runs may be given only once");
    const count = Number(value);
    if (value === "" || !Number.isInteger(count) || count < 1) {
      throw new Error("--runs takes a positive integer");
    }
    runs = count;
  }
  return { runs: runs ?? 20, testArgs };
}

/** A new, empty log directory for one audit. */
export function logDir(env: Record<string, string | undefined>): string {
  const base = env.FLAKE_AUDIT_DIR || tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "flake-audit-"));
}

/**
 * Runs one command to completion or until `timeoutMs`, with colour off so
 * the report keeps its plain `(fail)` lines. Bun writes the report to
 * stderr; the output is stdout, then stderr from a new line.
 */
export function runSuite(
  cmd: string[],
  options: {
    timeoutMs: number;
    env?: Record<string, string | undefined>;
  },
): { exitCode: number; timedOut: boolean; output: string } {
  const { FORCE_COLOR: _forced, ...parentEnv } = options.env ?? process.env;
  const env = { ...parentEnv, NO_COLOR: "1" };
  const proc = Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env,
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  const glue = stdout === "" || stdout.endsWith("\n") ? "" : "\n";
  return {
    exitCode: proc.exitCode ?? 1,
    timedOut: proc.exitedDueToTimeout === true,
    output: stdout + glue + stderr,
  };
}

if (import.meta.main) {
  const { runs, testArgs } = parseArgs(process.argv.slice(2));
  const timeoutMs = Number(process.env.FLAKE_AUDIT_RUN_TIMEOUT_S || 900) * 1000;
  const dir = logDir(process.env);
  const results: RunResult[] = [];
  for (let run = 1; run <= runs; run++) {
    const started = performance.now();
    const { exitCode, timedOut, output } = runSuite(
      [process.execPath, "test", ...testArgs],
      { timeoutMs },
    );
    writeFileSync(join(dir, `run-${run}.log`), output);
    const result: RunResult = {
      run,
      exitCode: timedOut ? 1 : exitCode,
      timedOut,
      failed: failedTests(output),
    };
    results.push(result);
    const seconds = ((performance.now() - started) / 1000).toFixed(0);
    const notes = [
      ...(timedOut ? [`timed out after ${timeoutMs / 1000} s`] : []),
      ...result.failed,
    ];
    console.log(
      `run ${run}/${runs}: ${result.exitCode === 0 ? "green" : "RED"} in ${seconds} s` +
        (notes.length ? ` (${notes.join("; ")})` : ""),
    );
  }
  const summary = summarize(results);
  console.log(`\n${summary.green}/${summary.runs} runs green. Logs: ${dir}`);
  for (const { name, runs: failedIn, everyRun } of summary.failing) {
    console.log(
      everyRun
        ? `  ${name}: failed in every run`
        : `  ${name}: failed in runs ${failedIn.join(", ")} (flaky)`,
    );
  }
  if (summary.timedOut.length) {
    console.log(`  timed out: runs ${summary.timedOut.join(", ")}`);
  }
  if (summary.redWithoutFailures.length) {
    console.log(
      `  red without a failing test: runs ${summary.redWithoutFailures.join(", ")}`,
    );
  }
  process.exit(summary.ok ? 0 : 1);
}
