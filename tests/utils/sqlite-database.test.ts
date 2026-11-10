import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSqliteBusyError,
  type OpenSqliteDatabaseOptions,
  openSqliteDatabase,
  type SqliteDatabaseHandle,
  type SqliteMigration,
  type SqliteOpenFailure,
} from "../../src/utils/sqlite-database.js";

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
  test("creates a missing file with mode 0600 and its directory with 0700, whatever the umask", () => {
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
  });

  test("keeps the mode of a file that already exists when links are followed", () => {
    const path = join(tempDir(), "data.db");
    writeFileSync(path, "");
    execFileSync("chmod", ["640", path]);
    open({ path, symlinks: "follow" });
    expect(mode(path)).toBe(0o640);
  });

  test("sets an existing file that others can read to 0600, and its -wal and -shm with it", () => {
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
  });

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

  test("rejects a FIFO at the path without blocking", () => {
    const dir = tempDir();
    const path = join(dir, "data.db");
    execFileSync("mkfifo", [path]);
    expect(failureOf(() => open({ path })).failure).toBe("unsafe_path");
  });

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
      expect(failureOf(() => open({ path })).failure).toBe("unsafe_path");
      expect(readFileSync(decoy).length).toBe(0);
    });
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
  test("creates the target of a dangling link with mode 0600", () => {
    const dir = tempDir();
    const target = join(dir, "made.db");
    const link = join(dir, "link.db");
    symlinkSync(target, link);
    open({ path: link, symlinks: "follow" });
    expect(existsSync(target)).toBe(true);
    expect(mode(target)).toBe(0o600);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test("rejects a link to a directory", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "d"));
    symlinkSync(join(dir, "d"), join(dir, "link.db"));
    expect(
      failureOf(() => open({ path: join(dir, "link.db"), symlinks: "follow" }))
        .failure,
    ).toBe("unsafe_path");
  });

  test("rejects a link to a FIFO without blocking", () => {
    const dir = tempDir();
    execFileSync("mkfifo", [join(dir, "fifo")]);
    symlinkSync(join(dir, "fifo"), join(dir, "link.db"));
    expect(
      failureOf(() => open({ path: join(dir, "link.db"), symlinks: "follow" }))
        .failure,
    ).toBe("unsafe_path");
  });
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

  test("close can be called twice", () => {
    const db = open({ path: join(tempDir(), "d.db") });
    db.close();
    expect(() => db.close()).not.toThrow();
  });
});

describe("node:sqlite is loaded only by the helper, and lazily", () => {
  test("no other file under src references node:sqlite", () => {
    const out = execFileSync(
      "grep",
      ["-rlE", "[\"']node:sqlite[\"']", join(import.meta.dir, "../../src")],
      { encoding: "utf8" },
    ).trim();
    expect(out.split("\n").map((p) => p.replace(/^.*\/src\//, "src/"))).toEqual(
      ["src/utils/sqlite-database.ts"],
    );
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
    const { Database } = require("bun:sqlite");
    const db = new Database(process.argv[1]);
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
});

describe("isSqliteBusyError", () => {
  test("is false for values that are not SQLite errors", () => {
    expect(isSqliteBusyError(undefined)).toBe(false);
    expect(isSqliteBusyError(null)).toBe(false);
    expect(isSqliteBusyError("database is locked")).toBe(false);
    expect(isSqliteBusyError(new Error("something else"))).toBe(false);
  });
});
