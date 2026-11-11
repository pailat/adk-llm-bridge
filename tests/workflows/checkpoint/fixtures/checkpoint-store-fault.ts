/**
 * Runs one file-system checkpoint store operation with an injected file-system
 * fault, in its own process so the module mock cannot leak into other tests.
 *
 * Usage: `bun checkpoint-store-fault.ts <mode> <root> [swapTarget]`.
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
 * `trace` mode.
 *
 * On a Windows host, or with `ADK_FAULT_TRACE=1`, every file-system step the
 * store takes (and every lock the fixture publishes or retires) is written to
 * stderr as `fault-trace +<ms> <who> <step> <path> -> ok | <code>`, so a child
 * that stops or times out shows its last step.
 */

import { mock } from "bun:test";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import type { InvocationContext } from "@google/adk";

const [mode, root, swapTarget] = process.argv.slice(2);
const MODES = [
  "release",
  "steal",
  "corrupt",
  "swap",
  "wait-retire",
  "wait-replace",
  "wait-unlink",
  "wait-vanish",
  "eperm-live",
  "eperm-none",
  "busy-release",
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

/** Writes one step of the file-system trace to stderr. */
function traceStep(who: string, step: string, path: unknown, outcome: string) {
  if (!TRACE) return;
  const at = (performance.now() - traceStart).toFixed(1);
  const shown = String(path)
    .replaceAll("\\", "/")
    .replace(String(root).replaceAll("\\", "/"), "<root>");
  process.stderr.write(
    `fault-trace +${at}ms ${who} ${step} ${shown} -> ${outcome}\n`,
  );
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
  process.on("exit", (code) =>
    traceStep("process", "exit", "-", `code ${code}`),
  );
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
let swapArmed = false;
let waitArmed = false;
let replaceLockPath: string | undefined;
let vanishLockPath: string | undefined;
let vanishLstats = 0;
let epermLockPath: string | undefined;
let epermArmed = false;
let busyLeft = 2;
const violations: string[] = [];
const syncedOwners = new Set<string>();
let publishes = 0;
let incompleteOwnerAtPublish = 0;
let unsyncedOwnerAtPublish = 0;
const isLockPath = (path: unknown): boolean => {
  const text = String(path).replaceAll("\\", "/");
  return text.endsWith(".json.lock") || text.includes(".json.lock/");
};
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

/** Retires a lock the way the protocol does: one rename away, then removal. */
async function retireLock(lockPath: string) {
  const retired = `${lockPath}.retired.fixture`;
  await traced("fixture", "retire", lockPath, () =>
    real.rename(lockPath, retired),
  );
  await traced("fixture", "remove", retired, () =>
    real.rm(retired, { recursive: true }),
  );
}

async function beforeOwnerRead(ownerPath: string) {
  if (
    !waitArmed ||
    mode === "wait-vanish" ||
    !ownerPath.endsWith(".json.lock/owner.json")
  )
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
        setTimeout(() => void retireLock(to), 50);
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
      setTimeout(() => void retireLock(from), 50);
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
  lstat: async (path: string) => {
    // Windows: the lock appears after the occupancy check and before the rename.
    if (epermLockPath !== undefined && path === epermLockPath) {
      epermLockPath = undefined;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    // The waiter's first look is the occupancy check; retire before its second.
    if (vanishLockPath !== undefined && path === vanishLockPath) {
      vanishLstats += 1;
      if (vanishLstats === 2) {
        vanishLockPath = undefined;
        await retireLock(path);
      }
    }
    if (replaceLockPath !== undefined && path === replaceLockPath) {
      replaceLockPath = undefined;
      await publishLock(path, "abandoned-token", deadPid());
    }
    const info = await real.lstat(path);
    if (swapArmed && path.endsWith(".json") && swapTarget) {
      swapArmed = false;
      await real.rename(path, `${path}.moved`);
      await real.symlink(swapTarget, path);
    }
    return info;
  },
  open: async (path: string, ...rest: [number?, number?]) => {
    if (swapArmed && path.endsWith(".json") && swapTarget) {
      swapArmed = false;
      await real.rename(path, `${path}.moved`);
      await real.symlink(swapTarget, path);
    }
    if (mode === "trace" && isWriteFlags(rest[0])) trace("open-write", path);
    const handle = await real.open(path, ...rest);
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

const { FileSystemWorkflowCheckpointStore } = await import(
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
try {
  await store.save({ context, checkpoint, expectedRevision: null });
  result.saved = true;
} catch (error) {
  result.reason = (error as { details?: { reason?: unknown } }).details?.reason;
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
if (mode === "swap") swapArmed = true;
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
console.log(JSON.stringify(result));
