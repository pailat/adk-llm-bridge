import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Variables that tell Codex code where a credential or binary is. A
 * developer's shell often sets some of them; CI sets none.
 */
export const HERMETIC_CODEX_ENV_KEYS = [
  "CODEX_HOME",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_EXECUTABLE",
  "CODEX_CLI_PATH",
] as const;

const HERMETIC_KEYS = ["HOME", "PATH", ...HERMETIC_CODEX_ENV_KEYS] as const;

/** The empty directories {@link withHermeticCodexEnv} points the env at. */
export interface HermeticCodexDirs {
  /** `HOME`: has no `.codex` directory. */
  home: string;
  /** `CODEX_HOME`: empty, so no `auth.json`. */
  codexHome: string;
  /** The only `PATH` entry: empty, so no `codex` binary. */
  bin: string;
}

/**
 * Runs `fn` as on a machine with no Codex setup, whatever the real one has:
 * `HOME` and `CODEX_HOME` are new empty directories, `PATH` is one empty
 * directory and the other {@link HERMETIC_CODEX_ENV_KEYS} are unset. The
 * environment is restored and the directories removed afterwards, even when
 * `fn` throws.
 *
 * @param options.unset - More variables to unset inside `fn`, such as the
 *   ones an example module reads when it is imported.
 *
 * @remarks
 * `PATH` holds no system tools inside `fn`, so `fn` must not spawn any.
 */
export async function withHermeticCodexEnv<T>(
  fn: (dirs: HermeticCodexDirs) => T | Promise<T>,
  options: { unset?: readonly string[] } = {},
): Promise<T> {
  const keys = [...HERMETIC_KEYS, ...(options.unset ?? [])];
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hermetic-codex-")));
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    const dirs: HermeticCodexDirs = {
      home: join(root, "home"),
      codexHome: join(root, "codex-home"),
      bin: join(root, "bin"),
    };
    for (const dir of Object.values(dirs)) mkdirSync(dir);

    for (const key of keys) delete process.env[key];
    process.env.HOME = dirs.home;
    process.env.CODEX_HOME = dirs.codexHome;
    process.env.PATH = dirs.bin;
    return await fn(dirs);
  } finally {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Registers `beforeEach`/`afterEach` hooks that snapshot the given
 * environment variables, delete them for a clean slate, and restore their
 * original values (or absence) after each test.
 *
 * Call inside a `describe` block (or at file top level).
 */
export function useCleanEnv(keys: readonly string[]): void {
  let snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    snapshot = {};
    for (const key of keys) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      const value = snapshot[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
