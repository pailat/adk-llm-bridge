import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SqliteSessionStore,
  SqliteSessionStoreError,
} from "../../src/agents/session-store/sqlite/index.js";
import {
  type OpenSqliteDatabaseOptions,
  openSqliteDatabase,
  type SqliteDatabaseHandle,
} from "../../src/utils/sqlite-database.js";
import { JsonlWorkflowEventExporter } from "../../src/workflows/storage/jsonl-event-exporter.js";

// The behavior on Windows, where a mode and `O_NOFOLLOW` do not exist. Each
// test pretends to be win32 (and drops `O_NOFOLLOW`) so macOS and Linux runs
// check the same rules the Windows job runs for real.

class TestFailure extends Error {
  constructor(
    readonly failure: string,
    message: string,
  ) {
    super(message);
  }
}

const fail: OpenSqliteDatabaseOptions["fail"] = (failure, message) =>
  new TestFailure(failure, message);

const dirs: string[] = [];
const closers: Array<() => unknown> = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "windows-contract-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const close of closers.splice(0)) {
    try {
      await close();
    } catch {
      // Already closed.
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// Node freezes `fs.constants`, so off Windows there `O_NOFOLLOW` stays set and
// only the platform is changed; on a real Windows run it is absent anyway.
const noFollowWritable =
  Object.getOwnPropertyDescriptor(constants, "O_NOFOLLOW")?.writable !== false;

/** Runs `run` with `process.platform` set to win32 and no `O_NOFOLLOW`. */
async function asWindows<T>(run: () => T | Promise<T>): Promise<T> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const noFollow = constants.O_NOFOLLOW;
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
  if (noFollowWritable) {
    (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW = undefined;
  }
  try {
    return await run();
  } finally {
    if (noFollowWritable) {
      (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW = noFollow;
    }
    if (platform) Object.defineProperty(process, "platform", platform);
  }
}

/** Symlinks need a privilege on Windows: `false` when it is missing. */
function link(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    ) {
      return false;
    }
    throw error;
  }
}

function sqlite(path: string): SqliteDatabaseHandle {
  const db = openSqliteDatabase({ path, fail });
  closers.push(() => db.close());
  return db;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("SQLite database helper on Windows", () => {
  // Skipped on a real Windows host: the mode it reports ignores `chmod`.
  test.skipIf(process.platform === "win32")(
    "an existing database that others can read is neither tightened nor refused",
    async () => {
      const path = join(tempDir(), "data.db");
      sqlite(path).close();
      chmodSync(path, 0o644);

      await asWindows(() => sqlite(path));

      expect(modeOf(path)).toBe(0o644);
    },
  );

  test("a symbolic link at the path is refused without O_NOFOLLOW and its target is left alone", async () => {
    const dir = tempDir();
    const target = join(dir, "victim.txt");
    writeFileSync(target, "keep me");
    const path = join(dir, "data.db");
    if (!link(target, path)) return;

    const error = await asWindows(() => {
      try {
        sqlite(path);
      } catch (caught) {
        return caught;
      }
      return undefined;
    });

    expect(error).toBeInstanceOf(TestFailure);
    expect((error as TestFailure).failure).toBe("unsafe_path");
    expect(readFileSync(target, "utf8")).toBe("keep me");
  });

  test("a dangling symbolic link at the path is refused without O_NOFOLLOW and nothing is created", async () => {
    const dir = tempDir();
    const target = join(dir, "created-through-link.db");
    const path = join(dir, "data.db");
    if (!link(target, path)) return;

    const error = await asWindows(() => {
      try {
        sqlite(path);
      } catch (caught) {
        return caught;
      }
      return undefined;
    });

    expect((error as TestFailure).failure).toBe("unsafe_path");
    expect(existsSync(target)).toBe(false);
  });

  test("a new file is created without O_NOFOLLOW", async () => {
    const path = join(tempDir(), "sub", "data.db");

    await asWindows(() => sqlite(path));

    expect(existsSync(path)).toBe(true);
  });
});

describe("SqliteSessionStore on Windows", () => {
  function openStore(path: string): SqliteSessionStore {
    const store = new SqliteSessionStore({ path });
    closers.push(() => store.close());
    return store;
  }

  test("a symbolic link at the database path is refused without O_NOFOLLOW and its target is left alone", async () => {
    const dir = tempDir();
    const target = join(dir, "victim.txt");
    writeFileSync(target, "keep me");
    const path = join(dir, "sessions.db");
    if (!link(target, path)) return;

    const error = await asWindows(() => {
      try {
        openStore(path);
      } catch (caught) {
        return caught;
      }
      return undefined;
    });

    expect(error).toBeInstanceOf(SqliteSessionStoreError);
    expect((error as SqliteSessionStoreError).code).toBe(
      "SESSION_STORE_UNSAFE_PATH",
    );
    expect(readFileSync(target, "utf8")).toBe("keep me");
  });

  test("a dangling symbolic link at the database path is refused without O_NOFOLLOW and nothing is created", async () => {
    const dir = tempDir();
    const target = join(dir, "created-through-link.db");
    const path = join(dir, "sessions.db");
    if (!link(target, path)) return;

    const error = await asWindows(() => {
      try {
        openStore(path);
      } catch (caught) {
        return caught;
      }
      return undefined;
    });

    expect((error as SqliteSessionStoreError).code).toBe(
      "SESSION_STORE_UNSAFE_PATH",
    );
    expect(existsSync(target)).toBe(false);
  });

  test("a new database is created without O_NOFOLLOW", async () => {
    const path = join(tempDir(), "sessions.db");

    await asWindows(() => openStore(path));

    expect(existsSync(path)).toBe(true);
  });
});

describe("JsonlWorkflowEventExporter on Windows", () => {
  // Skipped on a real Windows host: the mode it reports ignores `chmod`.
  test.skipIf(process.platform === "win32")(
    "a directory others can read is left as it is, not tightened",
    async () => {
      const directory = tempDir();
      await chmod(directory, 0o750);
      const exporter = new JsonlWorkflowEventExporter({ directory });
      closers.push(() => exporter.close());

      await asWindows(() =>
        exporter.append({
          executionId: "exec-1",
          records: [
            {
              id: "r1",
              executionId: "exec-1",
              kind: "workflow",
              type: "custom",
              timestamp: 1,
              payload: {},
            },
          ],
        }),
      );

      expect((await stat(directory)).mode & 0o777).toBe(0o750);
    },
  );
});
