/**
 * Runs the directory lock with an injected file-system fault, in its own
 * process so the module mock cannot leak into other tests.
 *
 * Usage: `bun directory-lock-fault.ts <mode> <root>`. Prints one JSON line.
 * - `eperm-held`: a live owner publishes the lock after the occupancy check
 *   and the candidate rename fails with `EPERM`, as a rename onto a non-empty
 *   directory does on Windows. Expect `{ held: true }`.
 * - `eperm-free`: the same `EPERM` with no lock present. Expect the error.
 * - `busy-release`: the first two lock-to-tombstone renames of a release fail
 *   with `EBUSY` (a waiter has a file of the lock open on Windows). Expect the
 *   release to retry and succeed.
 * - `busy-recover`: the same `EBUSY` on a recovery rename. Expect the error
 *   (only a release retries).
 * - `sync-<code>-<platform>` (`sync-eperm-linux`, `sync-eio-linux`,
 *   `sync-enotsup-darwin`, `sync-eperm-win32`): runs as that platform, and
 *   every flush of the lock's parent directory fails with that code, as on a
 *   mount that refuses a directory flush. The publishing rename itself works.
 *   Prints whether the lock was acquired, the error code, whether the lock
 *   path is still there, and how many cleanup errors were attached.
 * - `recover-race`, `recover-race-win32`, `recover-race-linux-eperm`: a dead
 *   owner's lock is recovered while a faster recoverer retires it and a new
 *   owner (token `next`) publishes in between, so the delayed rename lands on
 *   an existing tombstone. `-win32` runs as Windows and reports that collision
 *   as `EPERM`, as `MoveFileExW` does for an existing directory; `-linux-eperm`
 *   reports the same `EPERM` on Linux. Prints the error code, if any, and the
 *   token that holds the lock afterwards.
 * - `recover-blocked-win32`: runs as Windows; the recovery rename fails with
 *   `EPERM` and no tombstone exists (an open file blocks the lock directory).
 * - `trace`: acquire, release, then recovery of an abandoned lock and a second
 *   acquire and release. Prints every mutating call whose path is the lock or
 *   inside it, other than the two renames the protocol allows, and whether the
 *   owner file was complete before the publishing rename.
 */

import { mock } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const [mode, root] = process.argv.slice(2);
const MODES = [
  "eperm-held",
  "eperm-free",
  "busy-release",
  "busy-recover",
  "trace",
  "sync-eperm-linux",
  "sync-eio-linux",
  "sync-enotsup-darwin",
  "sync-eperm-win32",
  "recover-race",
  "recover-race-win32",
  "recover-race-linux-eperm",
  "recover-blocked-win32",
];
if (!root || !mode || !MODES.includes(mode)) {
  throw new Error(`usage: <${MODES.join("|")}> <root>`);
}

const real = { ...(await import("node:fs")) };
const syncFault = /^sync-([a-z]+)-([a-z0-9]+)$/u.exec(mode);
if (syncFault) {
  Object.defineProperty(process, "platform", { value: syncFault[2] });
}
if (mode.endsWith("-win32")) {
  Object.defineProperty(process, "platform", { value: "win32" });
} else if (mode === "recover-race-linux-eperm") {
  Object.defineProperty(process, "platform", { value: "linux" });
}
let raceArmed = mode.startsWith("recover-");
const parentDescriptors = new Set<number>();
const lockPath = join(root, "lock");
const slashes = (path: unknown): string => String(path).replaceAll("\\", "/");
const isLock = (path: unknown): boolean => {
  const text = slashes(path);
  return text === slashes(lockPath) || text.startsWith(`${slashes(lockPath)}/`);
};
const violations: string[] = [];
let publishes = 0;
let incompleteOwnerAtPublish = 0;
let busyLeft = 2;
let lstats = 0;

function record(call: string, path: unknown): void {
  if (mode === "trace" && isLock(path)) violations.push(`${call} ${path}`);
}

function writeFlags(flags: unknown): boolean {
  return typeof flags === "string"
    ? /[wa+]/u.test(flags)
    : typeof flags === "number" && (flags & 3) !== 0;
}

mock.module("node:fs", () => ({
  ...real,
  mkdirSync: (path: string, ...rest: [unknown?]) => {
    record("mkdir", path);
    return real.mkdirSync(path, ...(rest as []));
  },
  openSync: (path: string, flags?: unknown, ...rest: [unknown?]) => {
    if (writeFlags(flags)) record("open-write", path);
    const descriptor = real.openSync(path, flags as string, ...(rest as []));
    if (syncFault && slashes(path) === slashes(root)) {
      parentDescriptors.add(descriptor);
    }
    return descriptor;
  },
  fsyncSync: (descriptor: number) => {
    if (syncFault && parentDescriptors.has(descriptor)) {
      throw Object.assign(new Error(`injected ${syncFault[1]}, fsync`), {
        code: syncFault[1]?.toUpperCase(),
        syscall: "fsync",
      });
    }
    return real.fsyncSync(descriptor);
  },
  writeFileSync: (path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string") record("writeFile", path);
    return real.writeFileSync(path as string, ...(rest as [string]));
  },
  unlinkSync: (path: string) => {
    record("unlink", path);
    return real.unlinkSync(path);
  },
  rmdirSync: (path: string, ...rest: [unknown?]) => {
    record("rmdir", path);
    return real.rmdirSync(path, ...(rest as []));
  },
  rmSync: (path: string, ...rest: [unknown?]) => {
    record("rm", path);
    return real.rmSync(path, ...(rest as []));
  },
  lstatSync: (path: string, ...rest: [unknown?]) => {
    if (
      (mode === "eperm-held" || mode === "eperm-free") &&
      path === lockPath &&
      lstats++ === 0
    ) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return real.lstatSync(path, ...(rest as []));
  },
  renameSync: (from: string, to: string) => {
    const publishing = isLock(to) && !isLock(from);
    const retiring = isLock(from) && String(to).includes(".retired.");
    if (mode === "trace" && !publishing && !retiring) {
      record("rename-from", from);
      record("rename-to", to);
    }
    if (mode === "trace" && publishing) {
      publishes += 1;
      try {
        JSON.parse(real.readFileSync(join(from, "owner.json"), "utf8"));
      } catch {
        incompleteOwnerAtPublish += 1;
      }
    }
    if (mode === "eperm-held" && publishing) {
      real.mkdirSync(lockPath);
      real.writeFileSync(
        join(lockPath, "owner.json"),
        JSON.stringify({ token: "live", pid: process.pid, acquiredAt: 1 }),
      );
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    }
    if (mode === "eperm-free" && publishing) {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    }
    if (raceArmed && retiring) {
      raceArmed = false;
      if (mode === "recover-blocked-win32") {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      // The faster recoverer retires the same dead lock, and a new owner
      // publishes before this delayed rename runs.
      real.renameSync(from, to);
      const candidate = `${lockPath}.fixture-next`;
      real.mkdirSync(candidate);
      real.writeFileSync(
        join(candidate, "owner.json"),
        JSON.stringify({ token: "next", pid: process.pid, acquiredAt: 1 }),
      );
      real.renameSync(candidate, lockPath);
      try {
        return real.renameSync(from, to);
      } catch (error) {
        if (mode === "recover-race") throw error;
        throw Object.assign(new Error("EPERM, rename"), {
          code: "EPERM",
          syscall: "rename",
        });
      }
    }
    if (
      (mode === "busy-release" || mode === "busy-recover") &&
      retiring &&
      busyLeft > 0
    ) {
      busyLeft -= 1;
      throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    }
    return real.renameSync(from, to);
  },
}));

const {
  recoverDeadDirectoryLock,
  releaseDirectoryLock,
  tryAcquireDirectoryLock,
} = await import("../../../../src/workflows/internal/directory-lock.js");

function deadPid(): number {
  const pid = spawnSync(process.execPath, ["-e", "0"]).pid;
  if (!pid) throw new Error("child process did not expose a pid");
  return pid;
}

const result: Record<string, unknown> = {};
try {
  if (mode === "eperm-held" || mode === "eperm-free") {
    result.held = tryAcquireDirectoryLock(lockPath) === undefined;
  } else if (syncFault) {
    try {
      result.acquired = tryAcquireDirectoryLock(lockPath) !== undefined;
    } catch (error) {
      result.code = (error as { code?: string }).code;
      result.cleanupErrors = (
        (error as { cleanupErrors?: unknown[] }).cleanupErrors ?? []
      ).length;
    }
    result.lockLeft = real.existsSync(lockPath);
  } else if (mode.startsWith("recover-")) {
    real.mkdirSync(lockPath);
    real.writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({ token: "dead", pid: deadPid(), acquiredAt: 1 }),
    );
    try {
      recoverDeadDirectoryLock(lockPath);
    } catch (error) {
      result.code = (error as { code?: string }).code;
    }
    result.holder = JSON.parse(
      real.readFileSync(join(lockPath, "owner.json"), "utf8"),
    ).token;
  } else if (mode === "busy-release") {
    const owner = tryAcquireDirectoryLock(lockPath);
    if (!owner) throw new Error("lock not acquired");
    result.released = releaseDirectoryLock(lockPath, owner.token);
    result.left = real.readdirSync(root);
  } else if (mode === "busy-recover") {
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
    real.mkdirSync(lockPath);
    real.writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({ token: "dead", pid: dead, acquiredAt: 1 }),
    );
    recoverDeadDirectoryLock(lockPath);
  } else {
    const first = tryAcquireDirectoryLock(lockPath);
    if (!first) throw new Error("lock not acquired");
    releaseDirectoryLock(lockPath, first.token);
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
    real.mkdirSync(lockPath);
    real.writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({ token: "dead", pid: dead, acquiredAt: 1 }),
    );
    recoverDeadDirectoryLock(lockPath);
    const second = tryAcquireDirectoryLock(lockPath);
    if (!second) throw new Error("lock not reacquired");
    releaseDirectoryLock(lockPath, second.token);
    result.violations = violations;
    result.publishes = publishes;
    result.incompleteOwnerAtPublish = incompleteOwnerAtPublish;
  }
} catch (error) {
  result.code = (error as { code?: string }).code;
}
console.log(JSON.stringify(result));
