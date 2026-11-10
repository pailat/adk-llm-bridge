import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
    expect(code).toMatch(/^(EEXIST|ENOTEMPTY)$/u);
    expect(directoryLockTokenMatches(path, next.token)).toBe(true);
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
});
