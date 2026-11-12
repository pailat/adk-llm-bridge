import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIRECTORY_LOCK_OWNER_FILE,
  directoryLockTokenKey,
  directoryLockTokenMatches,
  recoverDeadDirectoryLock,
  releaseDirectoryLock,
  tryAcquireDirectoryLock,
} from "../../../src/workflows/internal/directory-lock.js";

/** Above the default `pid_max` of Linux and macOS, so no process has it. */
const DEAD_PID = 2_147_483_646;
const roots: string[] = [];
const FIXTURE = join(import.meta.dir, "fixtures", "directory-lock-fault.ts");

/** Runs the lock under an injected fault in a child process. */
async function runFault(
  mode:
    | "eperm-held"
    | "eperm-free"
    | "busy-release"
    | "busy-recover"
    | "trace"
    | "sync-eperm-linux"
    | "sync-eio-linux"
    | "sync-enotsup-darwin"
    | "sync-eperm-win32"
    | "recover-race"
    | "recover-race-win32"
    | "recover-race-linux-eperm"
    | "recover-blocked-win32"
    | "recover-file-win32",
): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), "adk-directory-lock-fault-"));
  roots.push(root);
  const child = spawnSync(process.execPath, [FIXTURE, mode, root], {
    encoding: "utf8",
    timeout: 30_000,
  });
  const line = child.stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`no result from the fault fixture: ${child.stderr}`);
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function lockPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adk-directory-lock-"));
  roots.push(root);
  return join(root, "lock");
}

async function plant(path: string, owner: unknown): Promise<void> {
  await mkdir(path);
  await writeFile(join(path, DIRECTORY_LOCK_OWNER_FILE), JSON.stringify(owner));
}

describe("directory lock", () => {
  test("publishes the lock with its owner and leaves no candidate behind", async () => {
    const path = await lockPath();
    const owner = tryAcquireDirectoryLock(path);

    expect(owner?.pid).toBe(process.pid);
    expect(
      JSON.parse(await readFile(join(path, DIRECTORY_LOCK_OWNER_FILE), "utf8")),
    ).toEqual(owner);
    expect(await readdir(join(path, ".."))).toEqual(["lock"]);
    expect(tryAcquireDirectoryLock(path)).toBeUndefined();
    expect(await readdir(join(path, ".."))).toEqual(["lock"]);
  });

  test("never takes over an empty, owner-less lock directory", async () => {
    const path = await lockPath();
    await mkdir(path);

    expect(tryAcquireDirectoryLock(path)).toBeUndefined();
    recoverDeadDirectoryLock(path);
    expect(await readdir(path)).toEqual([]);
    expect(await readdir(join(path, ".."))).toEqual(["lock"]);
  });

  test("releases only for the owning token and removes its own tombstone", async () => {
    const path = await lockPath();
    const owner = tryAcquireDirectoryLock(path);
    if (!owner) throw new Error("lock not acquired");

    expect(releaseDirectoryLock(path, "someone-else")).toBe(false);
    expect(directoryLockTokenMatches(path, owner.token)).toBe(true);
    expect(releaseDirectoryLock(path, owner.token)).toBe(true);
    expect(releaseDirectoryLock(path, owner.token)).toBe(false);
    expect(await readdir(join(path, ".."))).toEqual([]);
  });

  test("a recoverer leaves the lock alone when its owner changed after the liveness check", async () => {
    const path = await lockPath();
    await plant(path, { token: "dead", pid: DEAD_PID, acquiredAt: 1 });
    // The owner releases and a live owner takes the lock while the recoverer
    // is still deciding (the release left no tombstone).
    const realKill = process.kill.bind(process);
    const kill = spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: string | number,
    ) => {
      if (pid !== DEAD_PID) return realKill(pid, signal);
      rmSync(path, { recursive: true });
      mkdirSync(path);
      writeFileSync(
        join(path, DIRECTORY_LOCK_OWNER_FILE),
        JSON.stringify({ token: "live", pid: process.pid, acquiredAt: 2 }),
      );
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }) as typeof process.kill);
    try {
      recoverDeadDirectoryLock(path);
    } finally {
      kill.mockRestore();
    }

    expect(directoryLockTokenMatches(path, "live")).toBe(true);
    expect(await readdir(join(path, ".."))).toEqual(["lock"]);
  });

  test("a recoverer leaves the lock alone when a new owner reuses the dead owner's pid", async () => {
    const path = await lockPath();
    await plant(path, { token: "dead", pid: DEAD_PID, acquiredAt: 1 });
    // The token is the lock's identity: a new process can get the dead
    // owner's pid back and take the lock with a new token.
    const realKill = process.kill.bind(process);
    const kill = spyOn(process, "kill").mockImplementation(((
      pid: number,
      signal?: string | number,
    ) => {
      if (pid !== DEAD_PID) return realKill(pid, signal);
      rmSync(path, { recursive: true });
      mkdirSync(path);
      writeFileSync(
        join(path, DIRECTORY_LOCK_OWNER_FILE),
        JSON.stringify({ token: "reused", pid: DEAD_PID, acquiredAt: 2 }),
      );
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }) as typeof process.kill);
    try {
      recoverDeadDirectoryLock(path);
    } finally {
      kill.mockRestore();
    }

    expect(directoryLockTokenMatches(path, "reused")).toBe(true);
    expect(await readdir(join(path, ".."))).toEqual(["lock"]);
  });

  test("a delayed retirement of a dead owner never moves the next owner's lock", async () => {
    const path = await lockPath();
    await plant(path, { token: "dead", pid: DEAD_PID, acquiredAt: 1 });

    recoverDeadDirectoryLock(path);
    const next = tryAcquireDirectoryLock(path);
    if (!next) throw new Error("lock not acquired after recovery");
    // A second recoverer that read the dead owner before the first retired it.
    const retired = `${path}.retired.${directoryLockTokenKey("dead")}`;
    let code: unknown = "moved";
    try {
      renameSync(path, retired);
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }
    // Windows never renames onto an existing directory: MoveFileExW refuses
    // it with ERROR_ACCESS_DENIED, which Node and Bun report as EPERM. POSIX
    // refuses a non-empty one with ENOTEMPTY (or EEXIST).
    if (process.platform === "win32") {
      expect(code).toBe("EPERM");
    } else {
      expect(code).toMatch(/^(EEXIST|ENOTEMPTY)$/u);
    }
    expect(directoryLockTokenMatches(path, next.token)).toBe(true);
  });

  // An owner file that cannot be read is not proof the lock is gone or not
  // ours: the live holder must hear about it instead of dropping the lock.
  test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "a release whose owner file is unreadable throws and keeps the lock",
    async () => {
      const path = await lockPath();
      const owner = tryAcquireDirectoryLock(path);
      if (!owner) throw new Error("lock not acquired");
      const ownerFile = join(path, DIRECTORY_LOCK_OWNER_FILE);
      chmodSync(ownerFile, 0o000);
      try {
        expect(() => directoryLockTokenMatches(path, owner.token)).toThrow(
          expect.objectContaining({ code: "EACCES" }),
        );
        expect(() => releaseDirectoryLock(path, owner.token)).toThrow(
          expect.objectContaining({ code: "EACCES" }),
        );
        expect(existsSync(path)).toBe(true);
      } finally {
        chmodSync(ownerFile, 0o600);
      }
      expect(releaseDirectoryLock(path, owner.token)).toBe(true);
    },
  );

  test("a missing owner file or lock directory means the token does not own the lock", async () => {
    const path = await lockPath();
    const owner = tryAcquireDirectoryLock(path);
    if (!owner) throw new Error("lock not acquired");
    expect(directoryLockTokenMatches(path, owner.token)).toBe(true);

    rmSync(join(path, DIRECTORY_LOCK_OWNER_FILE));
    expect(directoryLockTokenMatches(path, owner.token)).toBe(false);
    expect(releaseDirectoryLock(path, owner.token)).toBe(false);

    const parent = await lockPath();
    writeFileSync(parent, "not a directory");
    expect(directoryLockTokenMatches(join(parent, "inner"), "token")).toBe(
      false,
    );
  });

  test("an owner path that is a directory means the token does not own the lock", async () => {
    const path = await lockPath();
    const owner = tryAcquireDirectoryLock(path);
    if (!owner) throw new Error("lock not acquired");
    const ownerFile = join(path, DIRECTORY_LOCK_OWNER_FILE);
    rmSync(ownerFile);
    mkdirSync(ownerFile);
    expect(directoryLockTokenMatches(path, owner.token)).toBe(false);
  });

  test("an owner file that is not a valid owner is not a match", async () => {
    const path = await lockPath();
    await plant(path, { token: "", pid: DEAD_PID });
    expect(directoryLockTokenMatches(path, "")).toBe(false);
    writeFileSync(join(path, DIRECTORY_LOCK_OWNER_FILE), "{not json");
    expect(directoryLockTokenMatches(path, "any")).toBe(false);
  });

  test("never retires a live or unreadable owner", async () => {
    const live = await lockPath();
    await plant(live, { token: "live", pid: process.pid, acquiredAt: 1 });
    recoverDeadDirectoryLock(live);
    expect(directoryLockTokenMatches(live, "live")).toBe(true);

    const corrupt = await lockPath();
    await plant(corrupt, { token: "", pid: DEAD_PID });
    recoverDeadDirectoryLock(corrupt);
    expect(await readdir(corrupt)).toEqual([DIRECTORY_LOCK_OWNER_FILE]);
    expect(tryAcquireDirectoryLock(corrupt)).toBeUndefined();
  });

  // Windows reports a rename onto a non-empty directory as EPERM, not EEXIST.
  test("a lock published between the occupancy check and the rename is held, not an error (Windows EPERM)", async () => {
    expect(await runFault("eperm-held")).toEqual({ held: true });
  });

  test("an EPERM from the publishing rename with no lock present is rethrown", async () => {
    expect(await runFault("eperm-free")).toEqual({ code: "EPERM" });
  });

  test("a release retries a rename a waiter's open file blocks (Windows EBUSY)", async () => {
    expect(await runFault("busy-release")).toEqual({
      released: true,
      left: [],
    });
  });

  test("a recovery does not retry a blocked rename", async () => {
    expect(await runFault("busy-recover")).toEqual({ code: "EBUSY" });
  });

  // The claim behind the wall-clock fix: the lock path is only ever replaced
  // by a whole-directory rename. An in-place write or delete would let a
  // reader see a lock without its owner.
  test("only the publishing and retiring renames touch the lock path, and the owner is complete before it is published", async () => {
    expect(await runFault("trace")).toEqual({
      violations: [],
      publishes: 2,
      incompleteOwnerAtPublish: 0,
    });
  });

  // The publishing rename succeeded, so the lock on the path is this
  // process's own. A failed flush after it must not read as contention or
  // leave that lock behind: the lock is released and the flush error thrown.
  for (const mode of [
    "sync-eperm-linux",
    "sync-eio-linux",
    "sync-enotsup-darwin",
  ] as const) {
    test(`a directory flush that fails after the publishing rename releases the lock and throws (${mode})`, async () => {
      const code = mode.split("-")[1]?.toUpperCase();
      expect(await runFault(mode)).toEqual({
        code,
        cleanupErrors: 1,
        lockLeft: false,
      });
    });
  }

  test("on Windows a refused directory flush after the publishing rename keeps the lock", async () => {
    expect(await runFault("sync-eperm-win32")).toEqual({
      acquired: true,
      lockLeft: true,
    });
  });

  // A delayed recoverer's rename lands on the tombstone the faster one made,
  // after a new owner took the lock. Nothing is moved; the recoverer backs off.
  test("a delayed recovery that collides with the first one's tombstone leaves the next owner's lock", async () => {
    expect(await runFault("recover-race")).toEqual({ holder: "next" });
  });

  test("on Windows that collision (EPERM onto an existing tombstone) is the same back-off", async () => {
    expect(await runFault("recover-race-win32")).toEqual({ holder: "next" });
  });

  // Off Windows an EPERM is not a collision report, and on Windows an EPERM
  // with no tombstone is a blocked or refused rename: both stay errors.
  test("an EPERM from a recovery rename off Windows is an error", async () => {
    expect(await runFault("recover-race-linux-eperm")).toEqual({
      code: "EPERM",
      holder: "next",
    });
  });

  test("on Windows an EPERM with no tombstone in the way is an error", async () => {
    expect(await runFault("recover-blocked-win32")).toEqual({
      code: "EPERM",
      holder: "dead",
    });
  });

  test("on Windows an EPERM with a plain file at the tombstone path is an error", async () => {
    expect(await runFault("recover-file-win32")).toEqual({
      code: "EPERM",
      holder: "dead",
    });
  });
});
