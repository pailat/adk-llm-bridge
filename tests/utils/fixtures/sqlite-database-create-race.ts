/**
 * Run with `bun test <this file>` in a child process, never in the main run:
 * it replaces `node:fs` for the whole process.
 *
 * Plays another process that creates the database file in the moment
 * between the helper's check of the path and its exclusive create. The
 * replaced `lstatSync` reports the path as missing once, after putting
 * something there, so the create fails with `EEXIST` and the helper has to
 * look again.
 */
import { expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const real = { ...fs };
let armed: { path: string; plant: (path: string) => void } | undefined;

mock.module("node:fs", () => ({
  ...real,
  lstatSync: (path: fs.PathLike, ...rest: unknown[]) => {
    if (armed !== undefined && path === armed.path) {
      const { plant } = armed;
      armed = undefined;
      plant(String(path));
      throw Object.assign(new Error(`ENOENT: ${String(path)}`), {
        code: "ENOENT",
      });
    }
    return (real.lstatSync as (...args: unknown[]) => unknown)(path, ...rest);
  },
}));

const { openSqliteDatabase } = await import(
  "../../../src/utils/sqlite-database.js"
);

class Failure extends Error {
  constructor(
    readonly failure: string,
    message: string,
  ) {
    super(message);
  }
}

function attempt(plant: (path: string) => void): {
  error: unknown;
  path: string;
  dir: string;
} {
  const dir = real.mkdtempSync(join(tmpdir(), "sqlite-create-race-"));
  const path = join(dir, "d.db");
  armed = { path, plant };
  try {
    openSqliteDatabase({
      path,
      fail: (failure, message) => new Failure(failure, message),
    }).close();
    return { error: undefined, path, dir };
  } catch (error) {
    return { error, path, dir };
  } finally {
    armed = undefined;
  }
}

test("a symbolic link planted between the check and the create is refused, and its target is left alone", () => {
  const outside = real.mkdtempSync(join(tmpdir(), "sqlite-create-race-out-"));
  const target = join(outside, "target");
  real.writeFileSync(target, "not yours");
  const { error, dir } = attempt((path) => real.symlinkSync(target, path));
  try {
    expect(error).toBeInstanceOf(Failure);
    expect((error as Failure).failure).toBe("unsafe_path");
    expect(real.readFileSync(target, "utf8")).toBe("not yours");
  } finally {
    real.rmSync(dir, { recursive: true, force: true });
    real.rmSync(outside, { recursive: true, force: true });
  }
});

test("a directory planted between the check and the create is refused", () => {
  const { error, dir } = attempt((path) => real.mkdirSync(path));
  try {
    expect(error).toBeInstanceOf(Failure);
    expect((error as Failure).failure).toBe("unsafe_path");
  } finally {
    real.rmSync(dir, { recursive: true, force: true });
  }
});

test("a regular file created by the other process is opened", () => {
  const { error, path, dir } = attempt((p) =>
    real.closeSync(real.openSync(p, "wx", 0o600)),
  );
  try {
    expect(error).toBeUndefined();
    expect(real.lstatSync(path).isFile()).toBe(true);
  } finally {
    real.rmSync(dir, { recursive: true, force: true });
  }
});
