/**
 * Runs one file-system checkpoint store operation with an injected file-system
 * fault, in its own process so the module mock cannot leak into other tests.
 *
 * Usage: `bun checkpoint-store-fault.ts <mode> <root> [swapTarget]`.
 * `swap` replaces the checkpoint with a symlink to `swapTarget` right after
 * the store checks the path; `swap-follow` does the same while the store's
 * opens follow a symlink (`O_NOFOLLOW` is removed from their flags), as on
 * Windows. When the host refuses to create the
 * symlink (Windows without Developer Mode or the privilege), the checkpoint
 * is left in place and the result carries `symlink: <code>`.
 * `load-follow` only saves and loads with opens that follow a symlink.
 * `replace` does what a concurrent save does right after the load checked the
 * path: it writes a copy of the checkpoint next to it and renames the copy
 * over the path (a new file, same content). `replace-follow` does it with
 * following opens. `swap-replace-follow` swaps in the symlink after the
 * check, lets the following open reach the target, and then renames a plain
 * copy over the path, so the path no longer names the opened file.
 * `link-follow` replaces the checkpoint with a symlink before the load, with
 * following opens, and reports how often the load opened the checkpoint path
 * (`opens`).
 * `steal` hands the lock to another owner (same pid, new token) right after
 * the checkpoint is committed, as a recoverer that wrongly judged this process
 * dead would. `corrupt` overwrites the lock's owner file with invalid JSON at
 * the same point.
 *
 * The `wait-*` modes save a second time while a live holder owns the lock, and
 * act at the moment the waiter has seen the lock directory but not yet read its
 * owner file. `wait-retire` retires the holder's lock the way the lock protocol
 * does (one rename away, then removal). `wait-replace` also publishes a new,
 * abandoned lock (dead pid) after the waiter's owner read failed and before it
 * looks at the path again. `wait-unlink` deletes only the owner file, which is
 * the first half of a recursive removal and never part of the protocol.
 * `wait-vanish` retires the holder's lock after the waiter found the path
 * occupied and before it inspects the lock directory.
 * `eperm-live` makes the waiter's publishing rename fail with `EPERM` while a
 * live holder owns the lock (Windows reports that, not `EEXIST`); the holder
 * retires 50 ms after that refusal. `eperm-none` is the same `EPERM` with no
 * lock present.
 * `busy-release` fails the first two lock-to-tombstone renames with `EBUSY`.
 * `publish-blocked` fails the first three checkpoint publishing renames
 * (temporary file to checkpoint) with `EPERM`, as Windows does while a reader
 * holds the checkpoint open; `publish-blocked-forever` fails every one with
 * `EBUSY`. Both report `blocks` (publishing renames tried) and `tmpLeft`
 * (temporary files left in the shard); a failed save also reports `causeCode`,
 * `waitedMs` (the retry time the error carries) and `elapsedMs` (wall time of
 * the save).
 * `trace` saves twice, the second time over an abandoned lock (dead pid), and
 * reports every mutating call on a lock path other than the two renames the
 * protocol allows, plus whether the owner file was complete and synced before
 * the publishing rename.
 * `recover-race`, `recover-race-win32` and `recover-blocked-win32` save a
 * second time over an abandoned lock (dead pid). In the race modes a faster
 * recoverer retires it and a live writer publishes a new lock (released 50 ms
 * later) just before this store's recovery rename, which so lands on an
 * existing tombstone; `-win32` runs as Windows and reports that as `EPERM`,
 * as `MoveFileExW` does. `recover-blocked-win32` fails the recovery rename
 * with `EPERM` while no tombstone exists.
 * `dir-sync-win32` runs as `win32` and fails every directory flush with
 * `EPERM`, as Windows does; `dir-sync-posix` is the same fault as `linux`.
 * `file-sync-win32` runs as `win32` and fails the owner file's flush instead.
 * Prints one JSON line: `{ saved, loaded, reason }`, plus the trace fields in
 * `trace` mode, and `fixtureErrors` when an action of the fixture itself
 * failed (the test then fails and names it). `late-fixture-failure` saves and
 * loads normally and schedules a fixture action that fails after that.
 *
 * On a Windows host, or with `ADK_FAULT_TRACE=1`, every file-system step the
 * store takes (and every lock the fixture publishes or retires) is written to
 * stderr as `fault-trace +<ms> <who> <step> <path> -> ok | <code>`, so a child
 * that stops or times out shows its last step. A step that repeats (a waiter
 * polling) is printed its first 3 times and then counted; on exit the counts
 * and the last 30 steps are printed.
 */

import { mock } from "bun:test";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { InvocationContext } from "@google/adk";
import { isLockOwnerPath, isLockPath, samePath } from "./fault-paths.js";

const [mode, root, swapTarget] = process.argv.slice(2);
const MODES = [
  "release",
  "steal",
  "corrupt",
  "swap",
  "swap-follow",
  "load-follow",
  "replace",
  "replace-follow",
  "late-fixture-failure",
  "swap-replace-follow",
  "link-follow",
  "wait-retire",
  "wait-replace",
  "wait-unlink",
  "wait-vanish",
  "eperm-live",
  "eperm-none",
  "busy-release",
  "publish-blocked",
  "publish-blocked-forever",
  "trace",
  "dir-sync-win32",
  "dir-sync-posix",
  "file-sync-win32",
  "recover-race",
  "recover-race-win32",
  "recover-blocked-win32",
];
if (!root || !mode || !MODES.includes(mode)) {
  throw new Error(`usage: <${MODES.join("|")}> <root> [swapTarget]`);
}

const real = { ...(await import("node:fs/promises")) };
// Read before a `-win32` mode makes the process look like Windows.
const TRACE =
  process.platform === "win32" || process.env.ADK_FAULT_TRACE === "1";
const traceStart = performance.now();

/** Times a step with the same who, step, path and outcome is printed. */
const TRACE_REPEATS_SHOWN = 3;
/** Steps printed again, in order, when the process exits. */
const TRACE_TAIL = 30;
const traceCounts = new Map<string, number>();
const traceTail: string[] = [];

/**
 * Writes one step of the file-system trace to stderr. A waiter polls the same
 * steps many times, so a step that repeats is printed only its first few
 * times and then counted; the counts and the last steps are printed on exit.
 */
function traceStep(who: string, step: string, path: unknown, outcome: string) {
  if (!TRACE) return;
  const at = (performance.now() - traceStart).toFixed(1);
  const shown = String(path)
    .replaceAll("\\", "/")
    .replace(String(root).replaceAll("\\", "/"), "<root>");
  const key = `${who} ${step} ${shown} -> ${outcome}`;
  const line = `fault-trace +${at}ms ${key}`;
  traceTail.push(line);
  if (traceTail.length > TRACE_TAIL) traceTail.shift();
  const count = (traceCounts.get(key) ?? 0) + 1;
  traceCounts.set(key, count);
  if (count <= TRACE_REPEATS_SHOWN) process.stderr.write(`${line}\n`);
}

/** Prints how often each repeated step ran, and the last steps in order. */
function traceSummary(code: number) {
  const out = process.stderr;
  for (const [key, count] of traceCounts) {
    if (count > TRACE_REPEATS_SHOWN) {
      out.write(`fault-trace repeated ${count} times: ${key}\n`);
    }
  }
  out.write(`fault-trace last ${traceTail.length} steps:\n`);
  for (const line of traceTail) out.write(`  ${line}\n`);
  out.write(`fault-trace process exit code ${code}\n`);
}

/** Runs one traced step and records its outcome: `ok` or the error code. */
async function traced<T>(
  who: string,
  step: string,
  path: unknown,
  run: () => Promise<T>,
): Promise<T> {
  try {
    const value = await run();
    traceStep(who, step, path, "ok");
    return value;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    traceStep(who, step, path, typeof code === "string" ? code : String(error));
    throw error;
  }
}

if (TRACE) {
  process.on("exit", traceSummary);
}
const syncFault =
  mode === "dir-sync-win32" || mode === "dir-sync-posix"
    ? "directory"
    : mode === "file-sync-win32"
      ? "file"
      : undefined;
if (mode.endsWith("-win32")) {
  Object.defineProperty(process, "platform", { value: "win32" });
} else if (mode === "dir-sync-posix") {
  Object.defineProperty(process, "platform", { value: "linux" });
}
let raceArmed = false;
/** Fixture actions that failed; reported in the result so the test says why. */
const fixtureErrors: string[] = [];

/** Fixture actions scheduled with {@link later}, settled before the result. */
const pendingActions: Promise<void>[] = [];

/**
 * Runs a fixture action `ms` later, as another process would. A failure is
 * recorded in the result instead of escaping as an unhandled rejection, which
 * ends a Node process before it prints the result. The fixture waits for every
 * scheduled action before it reports, so a late failure is not dropped.
 */
function later(ms: number, name: string, action: () => Promise<unknown>) {
  pendingActions.push(
    new Promise<void>((done) => {
      setTimeout(() => {
        action()
          .catch((error: unknown) => {
            const code = (error as { code?: unknown }).code;
            fixtureErrors.push(
              `${name}: ${typeof code === "string" ? code : String(error)}`,
            );
          })
          .finally(done);
      }, ms);
    }),
  );
}
let swapArmed = false;
let symlinkRefused: string | undefined;
let checkpointOpens: number | undefined;
let replaceFileArmed = false;
let replaceAfterOpenArmed = false;

/** Replaces `path` with a new file of the same content, as a save does. */
async function replaceWithCopy(path: string) {
  const temporary = `${path}.fixture-save.tmp`;
  await real.writeFile(temporary, await real.readFile(path));
  await traced("fixture", "save-replace", path, () =>
    real.rename(temporary, path),
  );
}

/** Replaces `path` with a symlink to the swap target in one rename. */
async function swapForSymlink(path: string) {
  const link = `${path}.link`;
  try {
    await real.symlink(String(swapTarget), link);
  } catch (error) {
    symlinkRefused = String((error as { code?: unknown }).code ?? error);
    return;
  }
  await real.rename(link, path);
}
let waitArmed = false;
let replaceLockPath: string | undefined;
let vanishLockPath: string | undefined;
let vanishLstats = 0;
let epermLockPath: string | undefined;
let epermArmed = false;
let busyLeft = 2;
let publishBlocks = 0;
const violations: string[] = [];
const syncedOwners = new Set<string>();
let publishes = 0;
let incompleteOwnerAtPublish = 0;
let unsyncedOwnerAtPublish = 0;
const trace = (call: string, path: unknown): void => {
  if (mode === "trace" && isLockPath(path)) violations.push(`${call} ${path}`);
};
const isWriteFlags = (flags: unknown): boolean =>
  typeof flags === "number" && (flags & 3) !== 0;

/** Publishes a lock the way the store does: owner first, then one rename. */
async function publishLock(lockPath: string, token: string, pid: number) {
  const candidate = join(
    dirname(lockPath),
    `.fixture-candidate.${basename(lockPath)}.${token}`,
  );
  await real.mkdir(candidate, { mode: 0o700 });
  await real.writeFile(
    join(candidate, "owner.json"),
    JSON.stringify({ token, pid, acquiredAt: Date.now() }),
  );
  await traced("fixture", `publish(${token})`, lockPath, () =>
    real.rename(candidate, lockPath),
  );
}

/**
 * Retires a lock the way the protocol does: one rename away, then removal.
 * The rename goes through the store's own release retry, so it waits out a
 * Windows refusal while a waiter has the lock directory open, with the
 * product's budget. It renames with the real file system, not the faults.
 */
async function retireLock(lockPath: string) {
  const retired = `${lockPath}.retired.fixture`;
  await renameRetryingBlocked(lockPath, retired, (from, to) =>
    traced("fixture", "retire", from, () => real.rename(from, to)),
  );
  await traced("fixture", "remove", retired, () =>
    real.rm(retired, { recursive: true }),
  );
}

async function beforeOwnerRead(ownerPath: string) {
  if (!waitArmed || mode === "wait-vanish" || !isLockOwnerPath(ownerPath))
    return;
  waitArmed = false;
  const lockPath = dirname(ownerPath);
  if (mode === "wait-unlink") {
    await real.unlink(ownerPath);
    return;
  }
  await retireLock(lockPath);
  if (mode === "wait-replace") replaceLockPath = lockPath;
}

function deadPid(): number {
  const pid = spawnSync(process.execPath, ["-e", "0"]).pid;
  if (!pid) throw new Error("child process did not expose a pid");
  return pid;
}

const faultFs = {
  ...real,
  mkdir: async (path: string, ...rest: [unknown?]) => {
    trace("mkdir", path);
    return await real.mkdir(path, ...(rest as []));
  },
  writeFile: async (path: string, ...rest: [unknown?]) => {
    trace("writeFile", path);
    return await real.writeFile(path, ...(rest as [string]));
  },
  unlink: async (path: string) => {
    trace("unlink", path);
    return await real.unlink(path);
  },
  rmdir: async (path: string) => {
    trace("rmdir", path);
    return await real.rmdir(path);
  },
  rm: async (path: string, ...rest: [unknown?]) => {
    trace("rm", path);
    return await real.rm(path, ...(rest as []));
  },
  readFile: async (path: string, ...rest: [BufferEncoding?]) => {
    await beforeOwnerRead(String(path));
    return await real.readFile(path, ...rest);
  },
  rename: async (from: string, to: string) => {
    const publishing = isLockPath(to) && !isLockPath(from);
    const retiring = isLockPath(from) && String(to).includes(".retired.");
    if (mode === "trace" && !publishing && !retiring) {
      trace("rename-from", from);
      trace("rename-to", to);
    }
    if (mode === "trace" && publishing) {
      publishes += 1;
      try {
        JSON.parse(await real.readFile(join(from, "owner.json"), "utf8"));
      } catch {
        incompleteOwnerAtPublish += 1;
      }
      if (!syncedOwners.has(join(from, "owner.json"))) {
        unsyncedOwnerAtPublish += 1;
      }
    }
    if (publishing && epermArmed) {
      epermArmed = false;
      // Windows refuses the rename because the holder's lock is there; the
      // holder retires it shortly after, not on a clock started earlier.
      if (mode === "eperm-live") {
        later(50, "holder retire", () => retireLock(to));
      }
      throw Object.assign(new Error("injected EPERM"), { code: "EPERM" });
    }
    if (raceArmed && retiring) {
      raceArmed = false;
      if (mode === "recover-blocked-win32") {
        throw Object.assign(new Error("injected EPERM"), { code: "EPERM" });
      }
      await real.rename(from, to);
      await publishLock(from, "next-token", process.pid);
      later(50, "next owner retire", () => retireLock(from));
      try {
        await real.rename(from, to);
      } catch (error) {
        if (mode === "recover-race") throw error;
        throw Object.assign(new Error("EPERM, rename"), {
          code: "EPERM",
          syscall: "rename",
        });
      }
      return;
    }
    if (mode === "busy-release" && retiring && busyLeft > 0) {
      busyLeft -= 1;
      throw Object.assign(new Error("injected EBUSY"), { code: "EBUSY" });
    }
    if (
      (mode === "publish-blocked" || mode === "publish-blocked-forever") &&
      String(from).endsWith(".tmp") &&
      String(to).endsWith(".json")
    ) {
      publishBlocks += 1;
      if (mode === "publish-blocked-forever" || publishBlocks <= 3) {
        const code = mode === "publish-blocked" ? "EPERM" : "EBUSY";
        throw Object.assign(new Error(`injected ${code}`), { code });
      }
    }
    if (mode === "release" && to.includes(".retired.")) {
      throw Object.assign(new Error("injected release failure"), {
        code: "EIO",
      });
    }
    await real.rename(from, to);
    if (mode === "steal" && from.endsWith(".tmp") && to.endsWith(".json")) {
      const ownerPath = `${to}.lock/owner.json`;
      const owner = JSON.parse(await real.readFile(ownerPath, "utf8"));
      await real.writeFile(
        ownerPath,
        JSON.stringify({ ...owner, token: "stolen-token" }),
      );
    }
    if (mode === "corrupt" && from.endsWith(".tmp") && to.endsWith(".json")) {
      await real.writeFile(`${to}.lock/owner.json`, "{not json");
    }
  },
  // Replace the checkpoint with a symlink right after any check of the path,
  // as a concurrent attacker could.
  lstat: async (path: string, ...rest: [{ bigint?: boolean }?]) => {
    // Windows: the lock appears after the occupancy check and before the rename.
    if (epermLockPath !== undefined && samePath(path, epermLockPath)) {
      epermLockPath = undefined;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    // The waiter's first look is the occupancy check; retire before its second.
    if (vanishLockPath !== undefined && samePath(path, vanishLockPath)) {
      vanishLstats += 1;
      if (vanishLstats === 2) {
        vanishLockPath = undefined;
        await retireLock(path);
      }
    }
    if (replaceLockPath !== undefined && samePath(path, replaceLockPath)) {
      replaceLockPath = undefined;
      await publishLock(path, "abandoned-token", deadPid());
    }
    const info = await real.lstat(path, ...(rest as []));
    if (swapArmed && path.endsWith(".json") && swapTarget) {
      swapArmed = false;
      await swapForSymlink(path);
    }
    if (replaceFileArmed && path.endsWith(".json")) {
      replaceFileArmed = false;
      await replaceWithCopy(path);
    }
    return info;
  },
  open: async (path: string, ...rest: [number?, number?]) => {
    if (swapArmed && path.endsWith(".json") && swapTarget) {
      swapArmed = false;
      await swapForSymlink(path);
    }
    if (mode === "trace" && isWriteFlags(rest[0])) trace("open-write", path);
    if (checkpointOpens !== undefined && path.endsWith(".json")) {
      checkpointOpens += 1;
    }
    // As on Windows, where there is no O_NOFOLLOW: the open follows a symlink.
    if (mode.endsWith("-follow") && typeof rest[0] === "number") {
      rest[0] &= ~(constants.O_NOFOLLOW ?? 0);
    }
    const handle = await real.open(path, ...rest);
    if (replaceAfterOpenArmed && path.endsWith(".json")) {
      replaceAfterOpenArmed = false;
      await replaceWithCopy(path);
    }
    if (syncFault !== undefined) {
      const isDirectory = (await handle.stat()).isDirectory();
      if (isDirectory === (syncFault === "directory")) {
        return new Proxy(handle, {
          get(target, key) {
            if (key === "sync") {
              return async () => {
                throw Object.assign(new Error("injected EPERM, fsync"), {
                  code: "EPERM",
                  syscall: "fsync",
                });
              };
            }
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }
    }
    if (mode !== "trace" || !isWriteFlags(rest[0])) return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === "sync") {
          return async () => {
            syncedOwners.add(String(path));
            return await target.sync();
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
};

/** Steps of an open handle the trace records, as `handle.<name>`. */
const TRACED_HANDLE_STEPS = new Set(["stat", "readFile", "sync", "close"]);

/** The fault file system with every store step traced. */
function tracedFs(fs: typeof faultFs): typeof faultFs {
  const wrap =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A) =>
      traced("store", name, args[0], () => fn(...args));
  return {
    ...fs,
    mkdir: wrap("mkdir", fs.mkdir),
    writeFile: wrap("writeFile", fs.writeFile),
    unlink: wrap("unlink", fs.unlink),
    rmdir: wrap("rmdir", fs.rmdir),
    rm: wrap("rm", fs.rm),
    readFile: wrap("readFile", fs.readFile),
    rename: (from: string, to: string) =>
      traced("store", `rename(-> ${basename(to)})`, from, () =>
        fs.rename(from, to),
      ),
    lstat: wrap("lstat", fs.lstat),
    open: async (path: string, ...rest: [number?, number?]) => {
      const handle = await traced("store", `open(flags=${rest[0]})`, path, () =>
        fs.open(path, ...rest),
      );
      return new Proxy(handle, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          if (typeof key !== "string" || !TRACED_HANDLE_STEPS.has(key)) {
            return value.bind(target);
          }
          return (...args: unknown[]) =>
            traced("store", `handle.${key}`, path, () =>
              value.apply(target, args),
            );
        },
      });
    },
  };
}

mock.module("node:fs/promises", () => (TRACE ? tracedFs(faultFs) : faultFs));

const { FileSystemWorkflowCheckpointStore, renameRetryingBlocked } =
  await import(
    "../../../../src/workflows/checkpoint/file-system-checkpoint-store.js"
  );
const { createWorkflowCheckpoint, withWorkflowCompleted } = await import(
  "../../../../src/workflows/checkpoint/checkpoint.js"
);
const { workflowCheckpointRevision } = await import(
  "../../../../src/workflows/checkpoint/store.js"
);
const { defineWorkflow } = await import(
  "../../../../src/workflows/definition.js"
);

const context = {} as InvocationContext;
const checkpoint = await createWorkflowCheckpoint({
  definition: defineWorkflow({ id: "fault", version: "1", handler: () => "" }),
  executionId: "execution",
  input: "input",
  now: 1,
});
const store = new FileSystemWorkflowCheckpointStore({ root });
if (mode === "eperm-none") epermArmed = true;
const result: {
  saved: boolean;
  loaded?: boolean;
  reason?: unknown;
  [key: string]: unknown;
} = {
  saved: false,
};
const saveStartedAt = performance.now();
try {
  await store.save({ context, checkpoint, expectedRevision: null });
  result.saved = true;
} catch (error) {
  const details = (
    error as {
      details?: { reason?: unknown; causeCode?: unknown; waitedMs?: unknown };
    }
  ).details;
  result.reason = details?.reason;
  if (mode.startsWith("publish-blocked")) {
    result.causeCode = details?.causeCode;
    result.waitedMs = details?.waitedMs;
    result.elapsedMs = Math.round(performance.now() - saveStartedAt);
  }
}
if (mode.startsWith("publish-blocked")) {
  const shard = join(root, (await real.readdir(root))[0] ?? "");
  result.blocks = publishBlocks;
  result.tmpLeft = (await real.readdir(shard)).filter((name) =>
    name.endsWith(".tmp"),
  ).length;
}
if (
  mode.startsWith("wait-") ||
  mode.startsWith("recover-") ||
  mode === "eperm-live" ||
  mode === "trace"
) {
  const shardPath = join(root, (await real.readdir(root))[0] ?? "");
  const checkpointName = (await real.readdir(shardPath)).find((name) =>
    name.endsWith(".json"),
  );
  const heldLockPath = join(shardPath, `${checkpointName}.lock`);
  await publishLock(
    heldLockPath,
    "holder-token",
    mode === "trace" || mode.startsWith("recover-") ? deadPid() : process.pid,
  );
  if (mode === "eperm-live") {
    epermArmed = true;
    epermLockPath = heldLockPath;
  }
  waitArmed = mode.startsWith("wait-");
  raceArmed = mode.startsWith("recover-");
  if (mode === "wait-vanish") vanishLockPath = heldLockPath;
  result.saved = false;
  try {
    await new FileSystemWorkflowCheckpointStore({
      root,
      lockRetryMs: 1,
      lockTimeoutMs: 10_000,
    }).save({
      context,
      checkpoint: withWorkflowCompleted(checkpoint, "done", 2),
      expectedRevision: await workflowCheckpointRevision(checkpoint),
    });
    result.saved = true;
  } catch (error) {
    result.reason = (
      error as { details?: { reason?: unknown } }
    ).details?.reason;
  }
}
if (mode === "trace") {
  result.violations = violations;
  result.publishes = publishes;
  result.incompleteOwnerAtPublish = incompleteOwnerAtPublish;
  result.unsyncedOwnerAtPublish = unsyncedOwnerAtPublish;
}
if (
  mode === "swap" ||
  mode === "swap-follow" ||
  mode === "swap-replace-follow"
) {
  swapArmed = true;
}
replaceAfterOpenArmed = mode === "swap-replace-follow";
if (mode === "replace" || mode === "replace-follow") replaceFileArmed = true;
if (mode === "link-follow") {
  const shardPath = join(root, (await real.readdir(root))[0] ?? "");
  const checkpointName = (await real.readdir(shardPath)).find((name) =>
    name.endsWith(".json"),
  );
  await swapForSymlink(join(shardPath, String(checkpointName)));
  checkpointOpens = 0;
}
try {
  const loaded = await store.load({
    context,
    workflowId: "fault",
    executionId: "execution",
  });
  result.loaded = loaded !== undefined;
} catch (error) {
  result.reason = (error as { details?: { reason?: unknown } }).details?.reason;
}
if (symlinkRefused !== undefined) result.symlink = symlinkRefused;
if (mode === "late-fixture-failure") {
  later(20, "late action", async () => {
    throw Object.assign(new Error("late"), { code: "EPERM" });
  });
}
await Promise.allSettled(pendingActions);
if (fixtureErrors.length > 0) result.fixtureErrors = fixtureErrors;
if (checkpointOpens !== undefined) result.opens = checkpointOpens;
console.log(JSON.stringify(result));
