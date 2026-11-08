import { afterEach, beforeEach } from "bun:test";

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
