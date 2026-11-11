import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  isSqliteBusyError,
  type OpenSqliteDatabaseOptions,
  openSqliteDatabase,
  type SqliteDatabaseHandle,
  type SqliteMigration,
  type SqliteOpenFailure,
} from "../../src/utils/sqlite-database.js";
import {
  describeChild,
  isBun,
  moduleSpecifier,
  preloadArgs,
  quietFlags,
} from "./fixtures/runtime.js";

class TestFailure extends Error {
  constructor(
    readonly failure: SqliteOpenFailure,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

const fail: OpenSqliteDatabaseOptions["fail"] = (failure, message, cause) =>
  new TestFailure(failure, message, cause);

const dirs: string[] = [];
const handles: SqliteDatabaseHandle[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-database-"));
  dirs.push(dir);
  return dir;
}

function open(
  options: Partial<OpenSqliteDatabaseOptions> & { path: string },
): SqliteDatabaseHandle {
  const db = openSqliteDatabase({ fail, ...options });
  handles.push(db);
  return db;
}

function failureOf(run: () => unknown): TestFailure {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TestFailure);
    return error as TestFailure;
  }
  throw new Error("expected the call to fail");
}

function pragma(db: SqliteDatabaseHandle, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

afterEach(() => {
  for (const db of handles.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed by the test.
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("openSqliteDatabase: creating the file", () => {
  // Skipped on Windows: POSIX modes.
  test.skipIf(process.platform === "win32")(
    "creates a missing file with mode 0600 and its directory with 0700, whatever the umask",
    () => {
      const root = tempDir();
      const previous = process.umask(0);
      try {
        const path = join(root, "a", "b", "data.db");
        open({ path }).exec("CREATE TABLE t (x)");
        expect(mode(path)).toBe(0o600);
        expect(mode(join(root, "a", "b"))).toBe(0o700);
      } finally {
        process.umask(previous);
      }
    },
  );

  // Skipped on Windows: POSIX modes.
  test.skipIf(process.platform === "win32")(
    "keeps the mode of a file that already exists when links are followed",
    () => {
      const path = join(tempDir(), "data.db");
      writeFileSync(path, "");
      execFileSync("chmod", ["640", path]);
      open({ path, symlinks: "follow" });
      expect(mode(path)).toBe(0o640);
    },
  );

  // Skipped on Windows: POSIX modes.
  test.skipIf(process.platform === "win32")(
    "sets an existing file that others can read to 0600, and its -wal and -shm with it",
    () => {
      const dir = tempDir();
      const path = join(dir, "data.db");
      writeFileSync(path, "");
      writeFileSync(`${path}-wal`, "");
      execFileSync("chmod", ["644", path, `${path}-wal`]);
      const db = open({ path });
      db.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)");
      expect(mode(path)).toBe(0o600);
      expect(mode(`${path}-wal`)).toBe(0o600);
      expect(mode(`${path}-shm`)).toBe(0o600);
      db.close();
    },
  );

  test("refuses a database whose directory is a symbolic link and creates nothing through it", () => {
    const dir = tempDir();
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(dir, "link"));
    expect(() => open({ path: join(dir, "link", "data.db") })).toThrow(
      /symbolic link/,
    );
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  // Skipped under Node: the fixture replaces `node:fs` with `mock.module` of `bun:test`.
  test.skipIf(!isBun)(
    "checks again what another process created between the check and the create",
    () => {
      // The race needs a replaced node:fs, so it runs in its own process.
      const fixture = join(
        import.meta.dir,
        "fixtures",
        "sqlite-database-create-race.ts",
      );
      const result = Bun.spawnSync([process.execPath, "test", fixture], {
        cwd: join(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = result.stdout.toString() + result.stderr.toString();
      expect({ exitCode: result.exitCode, output }).toMatchObject({
        exitCode: 0,
      });
      expect(output).toMatch(/\b3 pass\b/);
      expect(output).toMatch(/\b0 fail\b/);
    },
    20000,
  );

  test("refuses a schema version marker that is not a whole number", () => {
    const path = join(tempDir(), "data.db");
    const db = open({ path });
    db.migrate("component", [{ version: 1, sql: "CREATE TABLE t (x)" }]);
    db.exec("UPDATE adk_llm_bridge_schema_versions SET version = 'v2-beta'");
    expect(() => db.schemaVersion("component")).toThrow(
      /unreadable schema version/,
    );
    expect(() =>
      db.migrate("component", [{ version: 1, sql: "CREATE TABLE t (x)" }]),
    ).toThrow(/unreadable schema version/);
    db.close();
  });

  test("opens a database file that already holds data", () => {
    const path = join(tempDir(), "data.db");
    const first = open({ path });
    first.exec("CREATE TABLE t (x); INSERT INTO t VALUES (7)");
    first.close();
    expect(open({ path }).prepare("SELECT x FROM t").get()).toEqual({ x: 7 });
  });

  test("keeps a :memory: database off the disk", () => {
    const cwd = tempDir();
    const before = process.cwd();
    process.chdir(cwd);
    try {
      const db = open({ path: ":memory:" });
      db.exec("CREATE TABLE t (x)");
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      process.chdir(before);
    }
  });

  test("rejects a relative path as invalid_option without creating anything", () => {
    const cwd = tempDir();
    const before = process.cwd();
    process.chdir(cwd);
    try {
      expect(failureOf(() => open({ path: "rel/data.db" })).failure).toBe(
        "invalid_option",
      );
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      process.chdir(before);
    }
  });

  test("reports a file that is not a database as not_a_database", () => {
    const path = join(tempDir(), "data.db");
    writeFileSync(
      path,
      "this is plain text and not a SQLite database file".repeat(8),
    );
    expect(failureOf(() => open({ path })).failure).toBe("not_a_database");
  });
});

describe("openSqliteDatabase: symbolic links and special files", () => {
  test("rejects a symbolic link to a file when symlinks is reject, and leaves the target alone", () => {
    const dir = tempDir();
    const target = join(dir, "target.db");
    const seed = open({ path: target });
    seed.exec("CREATE TABLE t (x)");
    seed.close();
    const before = readFileSync(target);
    const link = join(dir, "link.db");
    symlinkSync(target, link);
    expect(failureOf(() => open({ path: link })).failure).toBe("unsafe_path");
    expect(Buffer.compare(readFileSync(target), before)).toBe(0);
  });

  test("rejects by default (no symlinks option)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "target.db"), "");
    symlinkSync(join(dir, "target.db"), join(dir, "link.db"));
    expect(failureOf(() => open({ path: join(dir, "link.db") })).failure).toBe(
      "unsafe_path",
    );
  });

  test("rejects a dangling symbolic link and never creates its target", () => {
    const dir = tempDir();
    const target = join(dir, "missing.db");
    const link = join(dir, "link.db");
    symlinkSync(target, link);
    expect(
      failureOf(() => open({ path: link, symlinks: "reject" })).failure,
    ).toBe("unsafe_path");
    expect(existsSync(target)).toBe(false);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test("rejects a directory at the path", () => {
    const dir = tempDir();
    const path = join(dir, "data.db");
    mkdirSync(path);
    expect(failureOf(() => open({ path })).failure).toBe("unsafe_path");
  });

  // Skipped on Windows: Windows has no FIFOs.
  test.skipIf(process.platform === "win32")(
    "rejects a FIFO at the path without blocking",
    () => {
      const dir = tempDir();
      const path = join(dir, "data.db");
      execFileSync("mkfifo", [path]);
      expect(failureOf(() => open({ path })).failure).toBe("unsafe_path");
    },
  );

  for (const symlinks of ["follow", "reject"] as const) {
    for (const dirMode of [0o700, 0o600]) {
      const label = `symlinks ${symlinks}, directory mode ${dirMode.toString(8)}`;
      test(`rejects a directory at the path (${label})`, () => {
        const dir = tempDir();
        const path = join(dir, "data.db");
        mkdirSync(path);
        chmodSync(path, dirMode);
        const failure = failureOf(() => open({ path, symlinks }));
        expect(failure.failure).toBe("unsafe_path");
        expect(failure.message).toContain("is not a regular file");
      });

      // Skipped on Windows: Windows has no FIFOs.
      test.skipIf(process.platform === "win32")(
        `rejects a FIFO at the path without blocking (${label})`,
        () => {
          const dir = tempDir();
          const path = join(dir, "data.db");
          execFileSync("mkfifo", ["-m", dirMode.toString(8), path]);
          const failure = failureOf(() => open({ path, symlinks }));
          expect(failure.failure).toBe("unsafe_path");
          expect(failure.message).toContain("is not a regular file");
        },
      );
    }
  }

  for (const suffix of ["-wal", "-shm"]) {
    test(`rejects a symbolic link at the ${suffix} companion file`, () => {
      const dir = tempDir();
      const path = join(dir, "data.db");
      const seed = open({ path });
      seed.exec("CREATE TABLE t (x)");
      seed.close();
      const decoy = join(dir, "decoy");
      writeFileSync(decoy, "");
      rmSync(path + suffix, { force: true });
      symlinkSync(decoy, path + suffix);
      const failure = failureOf(() => open({ path }));
      expect(failure.failure).toBe("unsafe_path");
      expect(failure.message).toContain(`has a symbolic link at ${suffix}`);
      expect(readFileSync(decoy).length).toBe(0);
    });
  }

  for (const suffix of ["-wal", "-shm"]) {
    for (const companionMode of [0o755, 0o600]) {
      for (const kind of ["directory", "fifo"] as const) {
        // Skipped on Windows for a FIFO only: Windows has no FIFOs. The
        // directory case runs there; only chmod and the mode check are POSIX.
        test.skipIf(kind === "fifo" && process.platform === "win32")(
          `rejects a ${kind} at the ${suffix} companion file without blocking (mode ${companionMode.toString(8)})`,
          () => {
            const dir = tempDir();
            const path = join(dir, "data.db");
            const seed = open({ path });
            seed.exec("CREATE TABLE t (x)");
            seed.close();
            rmSync(path + suffix, { force: true });
            if (kind === "directory") {
              mkdirSync(path + suffix);
              if (process.platform !== "win32") {
                chmodSync(path + suffix, companionMode);
              }
            } else {
              execFileSync("mkfifo", [
                "-m",
                companionMode.toString(8),
                path + suffix,
              ]);
            }
            const failure = failureOf(() => open({ path, symlinks: "reject" }));
            expect(failure.failure).toBe("unsafe_path");
            expect(failure.message).toContain(
              "companion that is not a regular file",
            );
            if (process.platform !== "win32") {
              expect(mode(path + suffix)).toBe(companionMode);
            }
          },
        );
      }
    }
  }

  test("rejects a dangling symbolic link at a companion file when the database is missing", () => {
    const dir = tempDir();
    const target = join(dir, "elsewhere");
    symlinkSync(target, join(dir, "data.db-wal"));
    expect(failureOf(() => open({ path: join(dir, "data.db") })).failure).toBe(
      "unsafe_path",
    );
    expect(existsSync(target)).toBe(false);
  });

  test("follows a symbolic link to an existing file when symlinks is follow", () => {
    const dir = tempDir();
    const target = join(dir, "target.db");
    const link = join(dir, "link.db");
    const seed = open({ path: target });
    seed.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1)");
    seed.close();
    symlinkSync(target, link);
    const db = open({ path: link, symlinks: "follow" });
    db.exec("INSERT INTO t VALUES (2)");
    db.close();
    expect(
      open({ path: target }).prepare("SELECT count(*) AS n FROM t").get(),
    ).toEqual({ n: 2 });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});

describe("openSqliteDatabase: symlinks follow edge cases", () => {
  // Skipped on Windows: POSIX modes.
  test.skipIf(process.platform === "win32")(
    "creates the target of a dangling link with mode 0600",
    () => {
      const dir = tempDir();
      const target = join(dir, "made.db");
      const link = join(dir, "link.db");
      symlinkSync(target, link);
      open({ path: link, symlinks: "follow" });
      expect(existsSync(target)).toBe(true);
      expect(mode(target)).toBe(0o600);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    },
  );

  test("rejects a link to a directory", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "d"));
    symlinkSync(join(dir, "d"), join(dir, "link.db"));
    expect(
      failureOf(() => open({ path: join(dir, "link.db"), symlinks: "follow" }))
        .failure,
    ).toBe("unsafe_path");
  });

  // Skipped on Windows: Windows has no FIFOs.
  test.skipIf(process.platform === "win32")(
    "rejects a link to a FIFO without blocking",
    () => {
      const dir = tempDir();
      execFileSync("mkfifo", [join(dir, "fifo")]);
      symlinkSync(join(dir, "fifo"), join(dir, "link.db"));
      expect(
        failureOf(() =>
          open({ path: join(dir, "link.db"), symlinks: "follow" }),
        ).failure,
      ).toBe("unsafe_path");
    },
  );
});

describe("openSqliteDatabase: options and pragmas", () => {
  test("sets WAL and reads back the busy timeout it was given", () => {
    const db = open({ path: join(tempDir(), "d.db"), busyTimeoutMs: 1234 });
    expect(String(pragma(db, "journal_mode")).toLowerCase()).toBe("wal");
    expect(pragma(db, "busy_timeout")).toBe(1234);
  });

  test("defaults to a 5000 ms busy timeout and synchronous NORMAL", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    expect(pragma(db, "busy_timeout")).toBe(5000);
    expect(pragma(db, "synchronous")).toBe(1);
  });

  test("sets synchronous FULL when asked", () => {
    const db = open({ path: join(tempDir(), "d.db"), synchronous: "full" });
    expect(pragma(db, "synchronous")).toBe(2);
  });

  test("accepts the limits 0 and 2147483647 for the busy timeout", () => {
    expect(
      pragma(
        open({ path: join(tempDir(), "a.db"), busyTimeoutMs: 0 }),
        "busy_timeout",
      ),
    ).toBe(0);
    expect(
      pragma(
        open({ path: join(tempDir(), "b.db"), busyTimeoutMs: 2147483647 }),
        "busy_timeout",
      ),
    ).toBe(2147483647);
  });

  for (const bad of [
    -1,
    1.5,
    2147483648,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    test(`rejects busyTimeoutMs ${String(bad)} as invalid_option before creating anything`, () => {
      const root = tempDir();
      const path = join(root, "sub", "d.db");
      expect(failureOf(() => open({ path, busyTimeoutMs: bad })).failure).toBe(
        "invalid_option",
      );
      expect(existsSync(join(root, "sub"))).toBe(false);
    });
  }

  test("throws exactly the error options.fail returns", () => {
    const mine = new Error("mine");
    let seen: SqliteOpenFailure | undefined;
    let caught: unknown;
    try {
      openSqliteDatabase({
        path: join(tempDir(), "d.db"),
        busyTimeoutMs: -5,
        fail: (failure) => {
          seen = failure;
          return mine;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(seen).toBe("invalid_option");
    expect(caught).toBe(mine);
  });

  test("sets the busy timeout with a PRAGMA too, for a DatabaseSync that ignores its timeout option", () => {
    // Node 22 releases before 22.16 have no `timeout` option on DatabaseSync
    // and drop it silently; only the PRAGMA sets the timeout there.
    const sqlite = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string, options?: object) => object;
    };
    const Real = sqlite.DatabaseSync;
    sqlite.DatabaseSync = class extends Real {
      constructor(path: string) {
        super(path);
      }
    };
    try {
      const db = open({ path: join(tempDir(), "d.db"), busyTimeoutMs: 1234 });
      expect(pragma(db, "busy_timeout")).toBe(1234);
    } finally {
      sqlite.DatabaseSync = Real;
    }
  });

  test("waits for the busy timeout while opening a rollback-journal file that another connection locks", () => {
    // Switching to WAL needs a lock. With the constructor option ignored (as
    // on Node 22 before 22.16), the PRAGMA has to be set before that switch,
    // or opening reports busy at once instead of waiting.
    const path = join(tempDir(), "d.db");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (
        path: string,
        options?: object,
      ) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    const seed = new DatabaseSync(path);
    seed.exec("PRAGMA journal_mode = DELETE");
    seed.exec("CREATE TABLE t (x)");
    seed.close();
    const locker = new DatabaseSync(path);
    locker.exec("BEGIN EXCLUSIVE");
    const sqlite = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string, options?: object) => object;
    };
    const Real = sqlite.DatabaseSync;
    sqlite.DatabaseSync = class extends Real {
      constructor(file: string) {
        super(file);
      }
    };
    try {
      const started = performance.now();
      let error: unknown;
      try {
        open({ path, busyTimeoutMs: 400 });
      } catch (caught) {
        error = caught;
      }
      const waited = performance.now() - started;
      expect(error).toBeDefined();
      expect(isSqliteBusyError(error)).toBe(true);
      expect(waited).toBeGreaterThanOrEqual(300);
      expect(waited).toBeLessThan(5000);
    } finally {
      sqlite.DatabaseSync = Real;
      locker.exec("ROLLBACK");
      locker.close();
    }
  });

  test("close can be called twice", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    db.close();
    expect(() => db.close()).not.toThrow();
  });
});

describe("node:sqlite is loaded only by the helper, and lazily", () => {
  test("no other file under src references node:sqlite", () => {
    // Walked in code: Windows has no `grep`.
    const found: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/["']node:sqlite["']/.test(readFileSync(full, "utf8"))) {
          found.push(full);
        }
      }
    };
    const src = join(import.meta.dir, "../../src");
    walk(src);
    expect(
      found.map((path) => relative(src, path).split(sep).join("/")),
    ).toEqual(["utils/sqlite-database.ts"]);
  });

  test("the helper has no static import of node:sqlite", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/utils/sqlite-database.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /(import|export)[^;]*from\s*["']node:sqlite["']/,
    );
    expect(source).not.toMatch(/(^|\n)\s*import\s*["']node:sqlite["']/);
    expect(source).toMatch(/createRequire\(/);
  });

  test("the helper does not load node:sqlite when the module is evaluated", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../src/utils/sqlite-database.ts"),
      "utf8",
    );
    // Top-level statements start at column 0; the loader's own call sits
    // inside its function body, which is indented.
    const topLevel = source
      .split("\n")
      .filter((line) => /^\S/.test(line) && !line.startsWith("//"))
      .filter((line) => !line.startsWith("function loadNodeSqlite"));
    expect(
      topLevel.filter((line) => /loadNodeSqlite\(|createRequire\(/.test(line)),
    ).toEqual([]);
  });

  test("importing the helper, the Claude session store or the agents entry never requires node:sqlite; opening does", () => {
    // A child process whose preload makes every require of node:sqlite
    // throw: an import that loads it fails, and opening a database (the
    // control) must report it as unavailable.
    const dir = tempDir();
    const preload = join(dir, "block-node-sqlite.mjs");
    writeFileSync(
      preload,
      `import Module from "node:module";
const blocked = (id) => id === "node:sqlite" || id === "sqlite";
const load = Module._load;
Module._load = function (request, ...rest) {
  if (blocked(request)) throw new Error("node:sqlite was required");
  return load.call(this, request, ...rest);
};
const create = Module.createRequire;
Module.createRequire = function (...args) {
  const inner = create.apply(this, args);
  return Object.assign((id) => {
    if (blocked(id)) throw new Error("node:sqlite was required");
    return inner(id);
  }, inner);
};
`,
    );
    const src = join(import.meta.dir, "../../src");
    const script = join(dir, "child.mjs");
    writeFileSync(
      script,
      `const helper = await import(${JSON.stringify(moduleSpecifier(join(src, "utils/sqlite-database.ts")))});
await import(${JSON.stringify(moduleSpecifier(join(src, "agents/session-store/sqlite/index.ts")))});
await import(${JSON.stringify(moduleSpecifier(join(src, "agents/index.ts")))});
console.log("imported");
try {
  helper.openSqliteDatabase({ path: ":memory:", fail: (failure) => new Error(failure) });
  console.log("opened");
} catch (error) {
  console.log("open failed: " + error.message);
}
`,
    );
    const result = Bun.spawnSync(
      [process.execPath, ...quietFlags, ...preloadArgs(preload), script],
      { stdout: "pipe", stderr: "pipe" },
    );
    const captured = {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
    expect(
      captured,
      describeChild("sqlite preload", {
        ...captured,
        signal: result.signalCode,
      }),
    ).toEqual({
      exitCode: 0,
      stdout: "imported\nopen failed: unavailable\n",
      stderr: "",
    });
  }, 20000);
});

describe("SqliteDatabaseHandle.transaction", () => {
  test("commits and returns the value of the body", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    db.exec("CREATE TABLE t (x)");
    const value = db.transaction(() => {
      db.exec("INSERT INTO t VALUES (1)");
      return "done";
    });
    expect(value).toBe("done");
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 1 });
  });

  test("rolls back when the body throws and rethrows the same error", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    db.exec("CREATE TABLE t (x)");
    const boom = new Error("boom");
    let caught: unknown;
    try {
      db.transaction(() => {
        db.exec("INSERT INTO t VALUES (1)");
        throw boom;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(boom);
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
    // The connection is usable and holds no transaction.
    db.transaction(() => db.exec("INSERT INTO t VALUES (2)"));
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 1 });
  });

  test("keeps the first error when SQLite already rolled the transaction back", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    db.exec("CREATE TABLE t (x)");
    const first = new Error("first");
    let caught: unknown;
    try {
      db.transaction(() => {
        db.exec("INSERT INTO t VALUES (1)");
        db.exec("ROLLBACK");
        throw first;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(first);
  });

  test("rolls back a failing statement inside the body", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    db.exec("CREATE TABLE t (x UNIQUE)");
    expect(() =>
      db.transaction(() => {
        db.exec("INSERT INTO t VALUES (1)");
        db.exec("INSERT INTO t VALUES (1)");
      }),
    ).toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
  });

  test("takes the write lock up front (BEGIN IMMEDIATE)", () => {
    const path = join(tempDir(), "d.db");
    const a = open({ path, busyTimeoutMs: 0 });
    const b = open({ path, busyTimeoutMs: 0 });
    a.exec("CREATE TABLE t (x)");
    let inner: unknown;
    a.transaction(() => {
      try {
        b.transaction(() => undefined);
      } catch (error) {
        inner = error;
      }
    });
    expect(isSqliteBusyError(inner)).toBe(true);
  });
});

describe("migrate step numbering", () => {
  test("refuses steps that do not start at 1 or skip a number", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    expect(() =>
      db.migrate("c", [{ version: 2, sql: "CREATE TABLE a (x)" }], "table"),
    ).toThrow(/numbered 1, 2, 3/);
    expect(() =>
      db.migrate(
        "c",
        [
          { version: 1, sql: "CREATE TABLE a (x)" },
          { version: 3, sql: "CREATE TABLE b (x)" },
        ],
        "table",
      ),
    ).toThrow(/numbered 1, 2, 3/);
    expect(db.schemaVersion("c", "table")).toBe(0);
  });
});

describe("migrate with a current schema", () => {
  test("takes no write lock, so another writer's open transaction does not block it", () => {
    const path = join(tempDir(), "current.db");
    const steps = [{ version: 1, sql: "CREATE TABLE t (x)" }];
    const first = open({ path, busyTimeoutMs: 0 });
    first.migrate("c", steps, "table");
    const writer = open({ path, busyTimeoutMs: 0 });
    writer.exec("BEGIN IMMEDIATE");
    const second = open({ path, busyTimeoutMs: 0 });
    expect(second.migrate("c", steps, "table")).toEqual({ from: 1, to: 1 });
    writer.exec("ROLLBACK");
  });
});

describe("migrate with a current schema and lockWhenCurrent", () => {
  test("takes the write lock, so another writer's open transaction blocks it", () => {
    const path = join(tempDir(), "current.db");
    const steps = [{ version: 1, sql: "CREATE TABLE t (x)" }];
    const first = open({ path, busyTimeoutMs: 0 });
    first.migrate("c", steps, "table");
    const writer = open({ path, busyTimeoutMs: 0 });
    writer.exec("BEGIN IMMEDIATE");
    const second = open({ path, busyTimeoutMs: 0 });
    expect(() =>
      second.migrate("c", steps, "table", { lockWhenCurrent: true }),
    ).toThrow();
    writer.exec("ROLLBACK");
    expect(
      second.migrate("c", steps, "table", { lockWhenCurrent: true }),
    ).toEqual({ from: 1, to: 1 });
  });
});

describe("migrate and schemaVersion", () => {
  const steps: SqliteMigration[] = [
    { version: 1, sql: "CREATE TABLE one (x); INSERT INTO one VALUES (1)" },
    { version: 2, sql: "CREATE TABLE two (x); INSERT INTO two VALUES (1)" },
    { version: 3, sql: "ALTER TABLE two ADD COLUMN y" },
  ];

  const count = (db: SqliteDatabaseHandle, table: string): number =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

  test("a fresh database goes from 0 to the last version (table storage)", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    expect(db.schemaVersion("c", "table")).toBe(0);
    expect(db.migrate("c", steps, "table")).toEqual({ from: 0, to: 3 });
    expect(db.schemaVersion("c", "table")).toBe(3);
    expect(count(db, "one")).toBe(1);
    expect(pragma(db, "user_version")).toBe(0);
  });

  test("table storage is the default", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    db.migrate("c", steps);
    expect(db.schemaVersion("c")).toBe(3);
    expect(db.schemaVersion("c", "table")).toBe(3);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name = ?")
        .get("adk_llm_bridge_schema_versions"),
    ).toEqual({ name: "adk_llm_bridge_schema_versions" });
  });

  test("user_version storage keeps the version in PRAGMA user_version and creates no table", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    expect(db.migrate("c", steps, "user_version")).toEqual({ from: 0, to: 3 });
    expect(pragma(db, "user_version")).toBe(3);
    expect(db.schemaVersion("c", "user_version")).toBe(3);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name = ?")
        .get("adk_llm_bridge_schema_versions"),
    ).toBeUndefined();
  });

  test("a partial database runs only the missing steps, once", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    expect(db.migrate("c", steps.slice(0, 1), "table")).toEqual({
      from: 0,
      to: 1,
    });
    expect(db.migrate("c", steps, "table")).toEqual({ from: 1, to: 3 });
    expect(db.migrate("c", steps, "table")).toEqual({ from: 3, to: 3 });
    expect(count(db, "one")).toBe(1);
    expect(count(db, "two")).toBe(1);
  });

  test("a version stored in an earlier process is not run again after reopening", () => {
    const path = join(tempDir(), "d.db");
    const first = open({ path });
    first.migrate("c", steps, "user_version");
    first.close();
    const second = open({ path });
    expect(second.migrate("c", steps, "user_version")).toEqual({
      from: 3,
      to: 3,
    });
    expect(count(second, "one")).toBe(1);
  });

  test("all steps run in one transaction: a failing step leaves nothing behind", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    const broken: SqliteMigration[] = [
      steps[0] as SqliteMigration,
      { version: 2, sql: "THIS IS NOT SQL" },
    ];
    expect(() => db.migrate("c", broken, "table")).toThrow();
    expect(db.schemaVersion("c", "table")).toBe(0);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'one'").get(),
    ).toBeUndefined();
    expect(db.migrate("c", steps, "table")).toEqual({ from: 0, to: 3 });
  });

  test("refuses a stored version newer than the last step and rewrites nothing (table storage)", () => {
    const path = join(tempDir(), "d.db");
    const db = open({ path });
    db.migrate("c", steps, "table");
    const failure = failureOf(() =>
      db.migrate("c", steps.slice(0, 2), "table"),
    );
    expect(failure.failure).toBe("schema_unsupported");
    expect(db.schemaVersion("c", "table")).toBe(3);
    expect(count(db, "two")).toBe(1);
  });

  test("refuses a stored version newer than the last step and rewrites nothing (user_version)", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    db.migrate("c", steps, "user_version");
    const failure = failureOf(() =>
      db.migrate("c", steps.slice(0, 1), "user_version"),
    );
    expect(failure.failure).toBe("schema_unsupported");
    expect(pragma(db, "user_version")).toBe(3);
    expect(count(db, "two")).toBe(1);
  });

  for (const bad of ["0.5", "-1"]) {
    test(`refuses a stored table version of ${bad} as unreadable and rewrites nothing`, () => {
      const db = open({ path: join(tempDir(), "d.db") });
      db.migrate("c", steps, "table");
      db.exec(
        `UPDATE adk_llm_bridge_schema_versions SET version = ${bad} WHERE component = 'c'`,
      );
      const failure = failureOf(() => db.migrate("c", steps, "table"));
      expect(failure.failure).toBe("schema_unsupported");
      expect(failure.message).toContain("unreadable schema version");
      expect(
        db
          .prepare(
            "SELECT version FROM adk_llm_bridge_schema_versions WHERE component = 'c'",
          )
          .get(),
      ).toEqual({ version: Number(bad) });
      expect(count(db, "one")).toBe(1);
    });
  }

  test("refuses user_version -1 as unreadable and leaves the file unchanged", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    db.exec("PRAGMA user_version = -1");
    const failure = failureOf(() => db.migrate("c", steps, "user_version"));
    expect(failure.failure).toBe("schema_unsupported");
    expect(failure.message).toContain("unreadable schema version");
    expect(pragma(db, "user_version")).toBe(-1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'one'").get(),
    ).toBeUndefined();
  });

  test("components keep separate versions in one file", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    db.migrate("a", [{ version: 1, sql: "CREATE TABLE a1 (x)" }], "table");
    db.migrate(
      "b",
      [
        { version: 1, sql: "CREATE TABLE b1 (x)" },
        { version: 2, sql: "CREATE TABLE b2 (x)" },
      ],
      "table",
    );
    expect(db.schemaVersion("a", "table")).toBe(1);
    expect(db.schemaVersion("b", "table")).toBe(2);
    expect(db.schemaVersion("never", "table")).toBe(0);
  });
});

describe("two processes on one file", () => {
  const holder = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    db.exec("INSERT INTO t VALUES (99)");
    process.stdout.write("locked\\n");
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => { db.exec("ROLLBACK"); db.close(); process.exit(0); });
  `;

  test("a write waits for the busy timeout while another process holds the lock, then reports SQLITE_BUSY", async () => {
    const path = join(tempDir(), "d.db");
    const db = open({ path, busyTimeoutMs: 400 });
    db.exec("CREATE TABLE t (x)");
    const child = spawn(process.execPath, ["-e", holder, path], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let seen = "";
        child.stdout.on("data", (chunk) => {
          seen += String(chunk);
          if (seen.includes("locked")) resolve();
        });
        child.on("error", reject);
        child.on("exit", () => reject(new Error("holder exited early")));
      });
      const started = performance.now();
      let error: unknown;
      try {
        db.transaction(() => db.exec("INSERT INTO t VALUES (1)"));
      } catch (caught) {
        error = caught;
      }
      const waited = performance.now() - started;
      expect(error).toBeDefined();
      expect(waited).toBeGreaterThanOrEqual(300);
      expect(waited).toBeLessThan(5000);
      expect(isSqliteBusyError(error)).toBe(true);
      expect(isSqliteBusyError(new Error("boom"))).toBe(false);
    } finally {
      child.stdin.end();
      const exited = new Promise((resolve) => child.on("exit", resolve));
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(timer);
    }
    // The lock is gone once the holder exits: the write now goes through.
    db.transaction(() => db.exec("INSERT INTO t VALUES (2)"));
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 1 });
  }, 20000);

  test("migrate refuses a newer version that another process stores while migrate waits for the write lock", async () => {
    const path = join(tempDir(), "d.db");
    const steps: SqliteMigration[] = [
      { version: 1, sql: "CREATE TABLE one (x)" },
      { version: 2, sql: "CREATE TABLE two (x)" },
      { version: 3, sql: "CREATE TABLE three (x)" },
    ];
    const db = open({ path, busyTimeoutMs: 5000 });
    db.migrate("c", steps.slice(0, 2), "table");
    const holdMs = 600;
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures", "sqlite-schema-bump-holder.ts"),
        path,
        "c",
        "9",
        String(holdMs),
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    try {
      const reader = child.stdout.getReader();
      let seen = "";
      while (!seen.includes("locked")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the holder exited before locking");
        seen += new TextDecoder().decode(value);
      }
      reader.releaseLock();
      // The version the holder stores is not committed yet: the check before
      // the transaction still reads 2 and lets migrate ask for the lock.
      const started = performance.now();
      const failure = failureOf(() => db.migrate("c", steps, "table"));
      const waited = performance.now() - started;
      expect(failure.failure).toBe("schema_unsupported");
      expect(failure.message).toContain("schema version 9");
      // The refusal came from inside the transaction, after the wait.
      expect(waited).toBeGreaterThanOrEqual(holdMs / 2);
      expect(db.schemaVersion("c", "table")).toBe(9);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'three'").get(),
      ).toBeUndefined();
    } finally {
      child.kill(9);
      await child.exited;
    }
  }, 20000);
});

describe("isSqliteBusyError", () => {
  test("is false for values that are not SQLite errors", () => {
    expect(isSqliteBusyError(undefined)).toBe(false);
    expect(isSqliteBusyError(null)).toBe(false);
    expect(isSqliteBusyError("database is locked")).toBe(false);
    expect(isSqliteBusyError(new Error("something else"))).toBe(false);
  });
});
