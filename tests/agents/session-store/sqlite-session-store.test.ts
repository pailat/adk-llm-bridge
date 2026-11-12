import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SqliteSessionStore,
  SqliteSessionStoreError,
} from "../../../src/agents/session-store/sqlite/index.js";
import {
  nodeSqliteAvailable,
  openRawDatabase,
} from "../../utils/fixtures/raw-sqlite.js";
import { isBun } from "../../utils/fixtures/runtime.js";

const dirs: string[] = [];
const stores: SqliteSessionStore[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-session-store-"));
  dirs.push(dir);
  return dir;
}

function open(path = join(tempDir(), "sessions.db")): SqliteSessionStore {
  const store = new SqliteSessionStore({ path });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const key = { projectKey: "proj", sessionId: "s1" };

// Needs the built-in `node:sqlite`: the store and the raw fixture both load it.
describe.skipIf(!nodeSqliteAvailable)("SqliteSessionStore", () => {
  test("load returns null for a key that was never written", async () => {
    const store = open();
    expect(await store.load(key)).toBeNull();
    expect(
      await store.load({ ...key, subpath: "subagents/agent-1" }),
    ).toBeNull();
  });

  test("load returns the entries deep-equal and in append order across batches", async () => {
    const store = open();
    const first = [
      { type: "user", uuid: "u1", message: { content: "hi" } },
      {
        type: "assistant",
        uuid: "u2",
        message: { content: [{ type: "text", text: "yo" }] },
      },
    ];
    const second = [
      { type: "custom-title", title: "Title" },
      { type: "user", uuid: "u3", nested: { a: [1, null, true], b: "x" } },
    ];
    await store.append(key, first);
    await store.append(key, second);
    expect(await store.load(key)).toEqual([...first, ...second]);
  });

  test("an entry whose uuid is already stored replaces it in place instead of adding a row", async () => {
    const store = open();
    await store.append(key, [
      { type: "user", uuid: "u1", v: 1 },
      { type: "assistant", uuid: "u2", v: 1 },
    ]);
    // A retried batch, then a replay that carries a newer copy of u1.
    await store.append(key, [
      { type: "user", uuid: "u1", v: 1 },
      { type: "assistant", uuid: "u2", v: 1 },
    ]);
    await store.append(key, [
      { type: "user", uuid: "u1", v: 2 },
      { type: "user", uuid: "u3" },
    ]);
    expect(await store.load(key)).toEqual([
      { type: "user", uuid: "u1", v: 2 },
      { type: "assistant", uuid: "u2", v: 1 },
      { type: "user", uuid: "u3" },
    ]);
  });

  test("a duplicate uuid inside one batch keeps one row", async () => {
    const store = open();
    await store.append(key, [
      { type: "user", uuid: "u1", v: 1 },
      { type: "user", uuid: "u1", v: 2 },
    ]);
    expect(await store.load(key)).toEqual([{ type: "user", uuid: "u1", v: 2 }]);
  });

  test("entries without a uuid are never deduplicated", async () => {
    const store = open();
    await store.append(key, [{ type: "tag", tag: "a" }]);
    await store.append(key, [{ type: "tag", tag: "a" }]);
    expect(await store.load(key)).toEqual([
      { type: "tag", tag: "a" },
      { type: "tag", tag: "a" },
    ]);
  });

  test("the same uuid in another transcript is a separate row", async () => {
    const store = open();
    const sub = { ...key, subpath: "subagents/agent-1" };
    const other = { projectKey: "proj", sessionId: "s2" };
    const otherProject = { projectKey: "other", sessionId: "s1" };
    for (const k of [key, sub, other, otherProject]) {
      await store.append(k, [
        { type: "user", uuid: "u1", at: JSON.stringify(k) },
      ]);
    }
    for (const k of [key, sub, other, otherProject]) {
      expect(await store.load(k)).toEqual([
        { type: "user", uuid: "u1", at: JSON.stringify(k) },
      ]);
    }
  });

  test("main and subagent transcripts are kept apart and listSubkeys lists the subagents", async () => {
    const store = open();
    await store.append(key, [{ type: "user", uuid: "m" }]);
    await store.append({ ...key, subpath: "subagents/agent-a" }, [
      { type: "user", uuid: "a" },
    ]);
    await store.append({ ...key, subpath: "subagents/agent-b" }, [
      { type: "user", uuid: "b" },
    ]);
    expect(await store.load(key)).toEqual([{ type: "user", uuid: "m" }]);
    expect((await store.listSubkeys(key)).sort()).toEqual([
      "subagents/agent-a",
      "subagents/agent-b",
    ]);
    expect(
      await store.listSubkeys({ projectKey: "proj", sessionId: "none" }),
    ).toEqual([]);
  });

  test("listSessions lists the main transcripts of one project with integer millisecond mtimes", async () => {
    const store = open();
    const before = Date.now();
    await store.append(key, [{ type: "user", uuid: "1" }]);
    await store.append({ projectKey: "proj", sessionId: "s2" }, [
      { type: "user" },
    ]);
    await store.append({ projectKey: "other", sessionId: "s3" }, [
      { type: "user" },
    ]);
    // A session with only a subagent transcript has no main transcript.
    await store.append(
      { projectKey: "proj", sessionId: "s4", subpath: "subagents/x" },
      [{ type: "user" }],
    );
    const after = Date.now();
    const listed = await store.listSessions("proj");
    expect(listed.map((item) => item.sessionId).sort()).toEqual(["s1", "s2"]);
    for (const item of listed) {
      expect(Number.isInteger(item.mtime)).toBe(true);
      expect(item.mtime).toBeGreaterThanOrEqual(before);
      expect(item.mtime).toBeLessThanOrEqual(after);
    }
    expect(await store.listSessions("missing")).toEqual([]);
  });

  test("delete of a main transcript removes its subagent transcripts too", async () => {
    const store = open();
    const sub = { ...key, subpath: "subagents/agent-a" };
    const other = { projectKey: "proj", sessionId: "s2" };
    await store.append(key, [{ type: "user", uuid: "m" }]);
    await store.append(sub, [{ type: "user", uuid: "a" }]);
    await store.append(other, [{ type: "user", uuid: "o" }]);
    await store.delete(key);
    expect(await store.load(key)).toBeNull();
    expect(await store.load(sub)).toBeNull();
    expect(await store.listSubkeys(key)).toEqual([]);
    expect(await store.load(other)).toEqual([{ type: "user", uuid: "o" }]);
    expect((await store.listSessions("proj")).map((s) => s.sessionId)).toEqual([
      "s2",
    ]);
  });

  test("delete of a subagent transcript keeps the main transcript", async () => {
    const store = open();
    const sub = { ...key, subpath: "subagents/agent-a" };
    await store.append(key, [{ type: "user", uuid: "m" }]);
    await store.append(sub, [{ type: "user", uuid: "a" }]);
    await store.delete(sub);
    expect(await store.load(sub)).toBeNull();
    expect(await store.load(key)).toEqual([{ type: "user", uuid: "m" }]);
  });

  test("a deleted uuid can be stored again", async () => {
    const store = open();
    await store.append(key, [{ type: "user", uuid: "u1", v: 1 }]);
    await store.delete(key);
    await store.append(key, [{ type: "user", uuid: "u1", v: 2 }]);
    expect(await store.load(key)).toEqual([{ type: "user", uuid: "u1", v: 2 }]);
  });

  test("rejects invalid keys and entries with typed codes and stores nothing of the batch", async () => {
    const store = open();
    for (const bad of [
      { projectKey: "", sessionId: "s" },
      { projectKey: "p", sessionId: "" },
      { projectKey: "p", sessionId: "s", subpath: "" },
    ]) {
      const error = await store.load(bad).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SqliteSessionStoreError);
      expect((error as SqliteSessionStoreError).code).toBe(
        "SESSION_STORE_INVALID_KEY",
      );
    }
    const error = await store
      .append(key, [{ type: "user", uuid: "ok" }, null as never])
      .catch((caught: unknown) => caught);
    expect((error as SqliteSessionStoreError).code).toBe(
      "SESSION_STORE_INVALID_ENTRY",
    );
    expect(await store.load(key)).toBeNull();
  });

  test("an empty batch stores nothing", async () => {
    const store = open();
    await store.append(key, []);
    expect(await store.load(key)).toBeNull();
  });

  test("data survives closing and reopening the file", async () => {
    const path = join(tempDir(), "sessions.db");
    const first = open(path);
    await first.append(key, [{ type: "user", uuid: "u1" }]);
    first.close();
    const second = open(path);
    await second.append(key, [
      { type: "user", uuid: "u1" },
      { type: "user", uuid: "u2" },
    ]);
    expect(await second.load(key)).toEqual([
      { type: "user", uuid: "u1" },
      { type: "user", uuid: "u2" },
    ]);
  });

  // Skipped on Windows: POSIX modes.
  test.skipIf(process.platform === "win32")(
    "creates the database file 0600 in a 0700 directory, uses WAL, and the WAL file is 0600",
    async () => {
      const dir = join(tempDir(), "nested", "dir");
      const path = join(dir, "sessions.db");
      const store = open(path);
      await store.append(key, [{ type: "user", uuid: "u1" }]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    },
  );

  test("works in memory", async () => {
    const store = new SqliteSessionStore({ path: ":memory:" });
    stores.push(store);
    await store.append(key, [{ type: "user", uuid: "u1" }]);
    expect(await store.load(key)).toEqual([{ type: "user", uuid: "u1" }]);
  });

  test("refuses a database written by a newer schema version", async () => {
    const path = join(tempDir(), "sessions.db");
    open(path).close();
    const raw = openRawDatabase(path);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    let caught: unknown;
    try {
      open(path);
    } catch (error) {
      caught = error;
    }
    expect((caught as SqliteSessionStoreError).code).toBe(
      "SESSION_STORE_SCHEMA_UNSUPPORTED",
    );
  });

  test("two processes appending to one file keep every entry and each process's order", async () => {
    const path = join(tempDir(), "sessions.db");
    open(path).close();
    const writer = resolve(import.meta.dir, "fixtures/concurrent-writer.ts");
    const procs = ["a", "b"].map((tag) =>
      Bun.spawn([process.execPath, writer, path, tag, "60"], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const codes = await Promise.all(procs.map((proc) => proc.exited));
    const errors = await Promise.all(
      procs.map((proc) => new Response(proc.stderr).text()),
    );
    expect({ codes, errors }).toEqual({ codes: [0, 0], errors: ["", ""] });
    const store = open(path);
    const entries = (await store.load(key)) ?? [];
    expect(entries).toHaveLength(240);
    for (const tag of ["a", "b"]) {
      const mine = entries
        .filter((entry) => entry.tag === tag)
        .map((entry) => entry.n);
      expect(mine).toEqual(Array.from({ length: 120 }, (_, n) => n));
    }
  });
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SqliteSessionStoreError);
  return (error as SqliteSessionStoreError).code;
}

function openError(options: { path: string; busyTimeoutMs?: number }) {
  try {
    stores.push(new SqliteSessionStore(options));
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Adds a trigger, through a second connection, that fails on `type: "boom"`. */
async function failOnBoom(path: string, action: "ABORT" | "ROLLBACK") {
  const raw = openRawDatabase(path);
  raw.exec(`CREATE TRIGGER boom BEFORE INSERT ON claude_session_entries
    WHEN json_extract(NEW.entry, '$.type') = 'boom'
    BEGIN SELECT RAISE(${action}, 'boom'); END`);
  raw.close();
}

// Needs the built-in `node:sqlite`: the store and the raw fixture both load it.
describe.skipIf(!nodeSqliteAvailable)("SqliteSessionStore edge cases", () => {
  test("listSessions reports the time of the last write, also when it replaced an entry", async () => {
    const store = open();
    const mtimeOf = async () =>
      (await store.listSessions("proj")).find((item) => item.sessionId === "s1")
        ?.mtime ?? 0;
    await store.append(key, [{ type: "user", uuid: "u1" }]);
    const first = await mtimeOf();
    await Bun.sleep(5);
    await store.append(key, [{ type: "user", uuid: "u2" }]);
    const second = await mtimeOf();
    expect(second).toBeGreaterThan(first);
    await Bun.sleep(5);
    // Only replaces u1 in place; no new row.
    await store.append(key, [{ type: "user", uuid: "u1", v: 2 }]);
    expect(await mtimeOf()).toBeGreaterThan(second);
  });

  test("deleting a session keeps the session with the same id in another project", async () => {
    const store = open();
    const elsewhere = { projectKey: "other", sessionId: "s1" };
    await store.append(key, [{ type: "user", uuid: "a" }]);
    await store.append(elsewhere, [{ type: "user", uuid: "b" }]);
    await store.delete(key);
    expect(await store.load(key)).toBeNull();
    expect(await store.load(elsewhere)).toEqual([{ type: "user", uuid: "b" }]);
  });

  test("an array entry is refused as not a JSON object", async () => {
    const store = open();
    expect(await codeOf(store.append(key, [[1, 2] as never]))).toBe(
      "SESSION_STORE_INVALID_ENTRY",
    );
    expect(await store.load(key)).toBeNull();
  });

  test("an entry JSON cannot hold (bigint, cycle) is refused with a typed code and its cause", async () => {
    const store = open();
    const cyclic: Record<string, unknown> = { type: "user" };
    cyclic.self = cyclic;
    for (const bad of [{ type: "user", n: 1n }, cyclic]) {
      const error = await store
        .append(key, [{ type: "user", uuid: "ok" }, bad as never])
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SqliteSessionStoreError);
      expect((error as SqliteSessionStoreError).code).toBe(
        "SESSION_STORE_INVALID_ENTRY",
      );
      expect((error as Error).cause).toBeInstanceOf(TypeError);
    }
    expect(await store.load(key)).toBeNull();
  });

  test("an entry whose toJSON() gives no JSON object (undefined, array, string, number, null) is refused with a typed code", async () => {
    const store = open();
    for (const value of [undefined, [1, 2], "text", 5, null]) {
      const bad = { type: "user", toJSON: () => value };
      const error = await store
        .append(key, [{ type: "user", uuid: "ok" }, bad as never])
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SqliteSessionStoreError);
      expect((error as SqliteSessionStoreError).code).toBe(
        "SESSION_STORE_INVALID_ENTRY",
      );
      expect((error as Error).message).toContain("entry 1");
    }
    expect(await store.load(key)).toBeNull();
  });

  test("an entry whose toJSON() gives a JSON object is stored as that object", async () => {
    const store = open();
    await store.append(key, [
      { type: "user", toJSON: () => ({ type: "user", uuid: "j1" }) } as never,
    ]);
    expect(await store.load(key)).toEqual([{ type: "user", uuid: "j1" }]);
  });

  test("an empty uuid is not an idempotency key: such entries are all kept", async () => {
    const store = open();
    const entries = [
      { type: "user", uuid: "", n: 1 },
      { type: "user", uuid: "", n: 2 },
    ];
    await store.append(key, entries);
    await store.append(key, [{ type: "user", uuid: "", n: 3 }]);
    expect(await store.load(key)).toEqual([
      ...entries,
      { type: "user", uuid: "", n: 3 },
    ]);
  });

  test("busyTimeoutMs must be a non-negative integer, checked before any file is created", async () => {
    const dir = tempDir();
    for (const busyTimeoutMs of [Number.NaN, -1, 1.5, Infinity, 2 ** 31]) {
      const path = join(dir, `bad-${stores.length}`, "sessions.db");
      const error = openError({ path, busyTimeoutMs });
      expect(error).toBeInstanceOf(SqliteSessionStoreError);
      expect((error as SqliteSessionStoreError).code).toBe(
        "SESSION_STORE_INVALID_OPTION",
      );
      expect(existsSync(path)).toBe(false);
    }
    for (const busyTimeoutMs of [0, 1000, 2 ** 31 - 1]) {
      expect(
        openError({ path: join(dir, `ok-${busyTimeoutMs}.db`), busyTimeoutMs }),
      ).toBeUndefined();
    }
  });

  test("a batch that fails mid-way stores nothing and the store stays usable", async () => {
    const path = join(tempDir(), "sessions.db");
    const store = open(path);
    await failOnBoom(path, "ABORT");
    const error = await store
      .append(key, [
        { type: "user", uuid: "ok" },
        { type: "boom", uuid: "x" },
      ])
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("boom");
    expect(await store.load(key)).toBeNull();
    await store.append(key, [{ type: "user", uuid: "ok" }]);
    expect(await store.load(key)).toEqual([{ type: "user", uuid: "ok" }]);
  });

  test("when SQLite already rolled back, the original error is thrown, not the failed ROLLBACK", async () => {
    const path = join(tempDir(), "sessions.db");
    const store = open(path);
    await failOnBoom(path, "ROLLBACK");
    const error = await store
      .append(key, [
        { type: "user", uuid: "ok" },
        { type: "boom", uuid: "x" },
      ])
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("boom");
    expect((error as Error).message).not.toContain("no transaction");
    expect(await store.load(key)).toBeNull();
    await store.append(key, [{ type: "user", uuid: "ok" }]);
    expect(await store.load(key)).toEqual([{ type: "user", uuid: "ok" }]);
  });
});

// The symlink, dangling-link and not-a-regular-file refusals run on Windows
// too; the tests that read or set POSIX modes are skipped there, each with a
// one-line reason.
// Needs the built-in `node:sqlite`: the store and the raw fixture both load it.
describe.skipIf(!nodeSqliteAvailable)(
  "SqliteSessionStore refuses an unsafe database path",
  () => {
    test("a symlink planted at the database path is refused and its target is left alone", () => {
      const dir = tempDir();
      const target = join(dir, "victim.txt");
      writeFileSync(target, "keep me");
      const path = join(dir, "sessions.db");
      symlinkSync(target, path);

      const error = openError({ path });

      expect(error).toBeInstanceOf(SqliteSessionStoreError);
      expect((error as SqliteSessionStoreError).code).toBe(
        "SESSION_STORE_UNSAFE_PATH",
      );
      expect(readFileSync(target, "utf8")).toBe("keep me");
    });

    test("a dangling symlink at the database path is refused and nothing is created", () => {
      const dir = tempDir();
      const target = join(dir, "created-through-link.db");
      const path = join(dir, "sessions.db");
      symlinkSync(target, path);

      expect((openError({ path }) as SqliteSessionStoreError).code).toBe(
        "SESSION_STORE_UNSAFE_PATH",
      );
      expect(existsSync(target)).toBe(false);
    });

    // Skipped on Windows: POSIX modes and umask.
    test.skipIf(process.platform === "win32")(
      "a new file is 0600 whatever the umask",
      async () => {
        const path = join(tempDir(), "sessions.db");
        const previous = process.umask(0o277);
        let store: SqliteSessionStore;
        try {
          store = open(path);
        } finally {
          process.umask(previous);
        }
        await store.append(key, [{ type: "user", uuid: "u1" }]);
        expect(statSync(path).mode & 0o777).toBe(0o600);
      },
    );

    // Skipped on Windows: POSIX directory modes.
    test.skipIf(process.platform === "win32")(
      "a directory others can write is refused",
      () => {
        const dir = join(tempDir(), "shared");
        mkdirSync(dir);
        chmodSync(dir, 0o777);

        expect(
          (
            openError({
              path: join(dir, "sessions.db"),
            }) as SqliteSessionStoreError
          ).code,
        ).toBe("SESSION_STORE_UNSAFE_PATH");
        expect(existsSync(join(dir, "sessions.db"))).toBe(false);
      },
    );

    // Skipped on Windows: POSIX directory modes.
    test.skipIf(process.platform === "win32")(
      "a directory its group can write is refused",
      () => {
        for (const mode of [0o770, 0o775]) {
          const dir = join(tempDir(), `group-${mode.toString(8)}`);
          mkdirSync(dir);
          chmodSync(dir, mode);

          expect(
            (
              openError({
                path: join(dir, "sessions.db"),
              }) as SqliteSessionStoreError
            ).code,
          ).toBe("SESSION_STORE_UNSAFE_PATH");
          expect(existsSync(join(dir, "sessions.db"))).toBe(false);
        }
      },
    );

    // Skipped on Windows: /dev/null is POSIX only; the helper refuses a directory on every platform (sqlite-database.test.ts).
    test.skipIf(process.platform === "win32")(
      "a path that is not a regular file is refused",
      () => {
        const before = statSync("/dev/null");

        const error = openError({ path: "/dev/null" });

        expect(error).toBeInstanceOf(SqliteSessionStoreError);
        expect((error as SqliteSessionStoreError).code).toBe(
          "SESSION_STORE_UNSAFE_PATH",
        );
        expect((error as Error).message).toContain("not a regular file");
        const after = statSync("/dev/null");
        expect(after.isCharacterDevice()).toBe(true);
        expect(after.mode).toBe(before.mode);
      },
    );

    // Skipped on Windows: POSIX modes and the sticky bit.
    test.skipIf(process.platform === "win32")(
      "a sticky shared directory and an existing 0755 directory are accepted unchanged",
      async () => {
        const sticky = join(tempDir(), "sticky");
        mkdirSync(sticky);
        chmodSync(sticky, 0o1777);
        const plain = join(tempDir(), "plain");
        mkdirSync(plain);
        chmodSync(plain, 0o755);

        for (const dir of [sticky, plain]) {
          const store = open(join(dir, "sessions.db"));
          await store.append(key, [{ type: "user", uuid: "u1" }]);
        }
        expect(statSync(sticky).mode & 0o7777).toBe(0o1777);
        expect(statSync(plain).mode & 0o777).toBe(0o755);
      },
    );

    // Skipped on Windows: POSIX directory modes.
    test.skipIf(process.platform === "win32")(
      "a directory reached through a symlink is checked at its real path",
      async () => {
        const real = join(tempDir(), "real");
        mkdirSync(real, { mode: 0o700 });
        const link = join(tempDir(), "link");
        symlinkSync(real, link);

        const store = open(join(link, "sessions.db"));
        await store.append(key, [{ type: "user", uuid: "u1" }]);
        expect(existsSync(join(real, "sessions.db"))).toBe(true);

        chmodSync(real, 0o777);
        expect(
          (
            openError({
              path: join(link, "other.db"),
            }) as SqliteSessionStoreError
          ).code,
        ).toBe("SESSION_STORE_UNSAFE_PATH");
      },
    );

    // Skipped on Windows: POSIX modes.
    test.skipIf(process.platform === "win32")(
      "an existing database keeps its mode",
      async () => {
        const path = join(tempDir(), "sessions.db");
        open(path).close();
        chmodSync(path, 0o640);
        const store = open(path);
        await store.append(key, [{ type: "user", uuid: "u1" }]);
        expect(statSync(path).mode & 0o777).toBe(0o640);
      },
    );

    // The store binds `openSync`, `closeSync` and `fchmodSync` by named import
    // from `node:fs`. Bun's `spyOn` on the `node:fs` namespace reaches those
    // bindings; Node's ESM bindings cannot be replaced. This suite also runs
    // under Node (`scripts/node-test.mjs` in CI), so the test is skipped there.
    test.skipIf(!isBun)(
      "a failed permission change on a just-created database closes the file and throws",
      () => {
        const path = join(tempDir(), "sessions.db");
        const opened: number[] = [];
        const closed: number[] = [];
        const realOpen = fs.openSync;
        const realClose = fs.closeSync;
        const open = spyOn(fs, "openSync").mockImplementation(((
          ...args: Parameters<typeof realOpen>
        ) => {
          const fd = realOpen(...args);
          if (args[0] === path) opened.push(fd);
          return fd;
        }) as typeof fs.openSync);
        const close = spyOn(fs, "closeSync").mockImplementation(((
          fd: number,
        ) => {
          closed.push(fd);
          return realClose(fd);
        }) as typeof fs.closeSync);
        const chmod = spyOn(fs, "fchmodSync").mockImplementation((() => {
          throw Object.assign(new Error("EIO: i/o error, fchmod"), {
            code: "EIO",
          });
        }) as typeof fs.fchmodSync);
        try {
          expect(() => new SqliteSessionStore({ path })).toThrow(
            expect.objectContaining({ code: "EIO" }),
          );
        } finally {
          chmod.mockRestore();
          close.mockRestore();
          open.mockRestore();
        }
        expect(opened).toHaveLength(1);
        expect(closed).toContain(opened[0] as number);
      },
    );
  },
);
