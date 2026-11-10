import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectFileSystemWorkspaceTombstonesOffline,
  FileSystemWorkspaceAdapter,
  type FileSystemWorkspaceAdapterOptions,
} from "../../../src/workflows/workspace/file-system-workspace-adapter.js";

const directories: string[] = [];
const adapters: FileSystemWorkspaceAdapter[] = [];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "adk-workspace-durable-"));
  directories.push(directory);
  return directory;
}

function adapter(
  stateDirectory: string,
  options: Partial<FileSystemWorkspaceAdapterOptions> = {},
): FileSystemWorkspaceAdapter {
  const instance = new FileSystemWorkspaceAdapter({
    stateDirectory,
    leaseTtlMs: 1_000,
    heartbeatIntervalMs: 200,
    pollIntervalMs: 5,
    lockAcquireTimeoutMs: 1_000,
    ...options,
  });
  adapters.push(instance);
  return instance;
}

const request = (ownerId: string, writePaths: readonly string[]) => ({
  workspaceId: "repo",
  ownerId,
  writePaths,
});

describe("FileSystemWorkspaceAdapter", () => {
  test("serializes overlapping leases across adapter instances", async () => {
    const directory = await stateDirectory();
    const firstAdapter = adapter(directory);
    const secondAdapter = adapter(directory);
    const first = await firstAdapter.acquire(request("agent-a", ["src"]));
    let acquired = false;
    const pending = secondAdapter
      .acquire(request("agent-b", ["src/workflows"]))
      .then((lease) => {
        acquired = true;
        return lease;
      });

    await delay(30);
    expect(acquired).toBe(false);
    expect(await first.release()).toBe(true);
    const second = await pending;
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    expect(acquired).toBe(true);
    expect(await second.release()).toBe(true);
  });

  test("grants disjoint sibling paths concurrently", async () => {
    const directory = await stateDirectory();
    const firstAdapter = adapter(directory);
    const secondAdapter = adapter(directory);

    const [first, second] = await Promise.all([
      firstAdapter.acquire(request("agent-a", ["src/foo"])),
      secondAdapter.acquire(request("agent-b", ["src/foobar"])),
    ]);

    expect(first.fencingToken).not.toBe(second.fencingToken);
    expect(await first.release()).toBe(true);
    expect(await second.release()).toBe(true);
  });

  test("expires a crashed owner and makes stale release harmless", async () => {
    const directory = await stateDirectory();
    let now = 1_000;
    const firstAdapter = adapter(directory, {
      leaseTtlMs: 100,
      heartbeatIntervalMs: 20,
      now: () => now,
    });
    const first = await firstAdapter.acquire(request("agent-a", ["src"]));
    firstAdapter.dispose();
    now = 1_200;

    const secondAdapter = adapter(directory, {
      leaseTtlMs: 100,
      heartbeatIntervalMs: 20,
      now: () => now,
    });
    expect(secondAdapter.conflicts(request("observer", ["src"]))).toEqual([]);
    const second = await secondAdapter.acquire(request("agent-b", ["src"]));

    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    expect(await first.release()).toBe(false);
    expect(
      secondAdapter
        .conflicts(request("observer", ["src"]))
        .map((conflict) => conflict.fencingToken),
    ).toEqual([second.fencingToken]);
    expect(await second.release()).toBe(true);
  });

  test("renews explicitly and updates the exposed expiry", async () => {
    const directory = await stateDirectory();
    let now = 2_000;
    const instance = adapter(directory, {
      leaseTtlMs: 100,
      heartbeatIntervalMs: 20,
      now: () => now,
    });
    const lease = await instance.acquire(request("agent-a", ["src"]));
    expect(lease.expiresAt).toBe(2_100);

    now = 2_080;
    expect(await lease.renew()).toBe(true);
    expect(lease.expiresAt).toBe(2_180);
    expect(await lease.release()).toBe(true);
  });

  test("reports lease loss after expiry and adapter disposal", async () => {
    const directory = await stateDirectory();
    let now = 3_000;
    const expiringAdapter = adapter(directory, {
      leaseTtlMs: 100,
      heartbeatIntervalMs: 20,
      now: () => now,
    });
    const expired = await expiringAdapter.acquire(
      request("agent-expired", ["expired"]),
    );
    now = 3_101;

    expect(await expired.renew()).toBe(false);
    expect(expired.lossSignal.aborted).toBe(true);
    expect(expired.lossSignal.reason).toMatchObject({
      code: "WORKSPACE_LEASE_LOST",
      workspaceId: "repo",
      leaseId: expired.leaseId,
      fencingToken: expired.fencingToken,
    });

    const disposed = await expiringAdapter.acquire(
      request("agent-disposed", ["disposed"]),
    );
    expiringAdapter.dispose();
    expect(disposed.lossSignal.aborted).toBe(true);
    expect(disposed.lossSignal.reason).toMatchObject({
      code: "WORKSPACE_ADAPTER_DISPOSED",
      leaseId: disposed.leaseId,
    });
  });

  test("does not report loss after successful renew and release", async () => {
    const directory = await stateDirectory();
    let now = 4_000;
    const instance = adapter(directory, {
      leaseTtlMs: 100,
      heartbeatIntervalMs: 20,
      now: () => now,
    });
    const lease = await instance.acquire(request("agent-a", ["src"]));
    now = 4_050;

    expect(await lease.renew()).toBe(true);
    expect(lease.lossSignal.aborted).toBe(false);
    expect(await lease.release()).toBe(true);
    now = 5_000;
    await delay(25);
    expect(lease.lossSignal.aborted).toBe(false);
  });

  test("reports loss when heartbeat cannot renew before expiry", async () => {
    const directory = await stateDirectory();
    const instance = adapter(directory, {
      leaseTtlMs: 60,
      heartbeatIntervalMs: 10,
      lockAcquireTimeoutMs: 20,
      pollIntervalMs: 2,
    });
    const lease = await instance.acquire(request("agent-a", ["src"]));
    const workspaceDirectory = workspaceDirectoryFor(directory);
    await mkdir(join(workspaceDirectory, "lock"), { mode: 0o700 });
    await writeFile(
      join(workspaceDirectory, "lock", "owner.json"),
      JSON.stringify({
        token: "live-heartbeat-blocker",
        pid: process.pid,
        acquiredAt: Date.now(),
      }),
    );

    await delay(80);
    expect(lease.lossSignal.aborted).toBe(true);
    expect(lease.lossSignal.reason).toMatchObject({
      code: "WORKSPACE_LEASE_LOST",
      leaseId: lease.leaseId,
    });
  });

  test("auto-renews with an unref heartbeat while the adapter is live", async () => {
    const directory = await stateDirectory();
    // A long lease with a short heartbeat: a slow runner cannot let the lease
    // expire before the release, so only the renewal is under test.
    const instance = adapter(directory, {
      leaseTtlMs: 5_000,
      heartbeatIntervalMs: 15,
    });
    const lease = await instance.acquire(request("agent-a", ["src"]));
    const initialExpiry = lease.expiresAt;

    for (let i = 0; i < 200 && lease.expiresAt <= initialExpiry; i++) {
      await delay(10);
    }
    expect(lease.expiresAt).toBeGreaterThan(initialExpiry);
    expect(await lease.release()).toBe(true);
  });

  test("reads atomic conflict snapshots while heartbeat renewal is active", async () => {
    const directory = await stateDirectory();
    const owner = adapter(directory, {
      leaseTtlMs: 80,
      heartbeatIntervalMs: 10,
    });
    const observer = adapter(directory, {
      leaseTtlMs: 80,
      heartbeatIntervalMs: 10,
    });
    const lease = await owner.acquire(request("agent-a", ["src"]));

    for (let index = 0; index < 20; index++) {
      expect(observer.conflicts(request("observer", ["src"]))).toHaveLength(1);
      await delay(2);
    }
    expect(lease.expiresAt).toBeGreaterThan(lease.acquiredAt + 80);
    expect(await lease.release()).toBe(true);
  });

  test("persists monotonically increasing fencing tokens", async () => {
    const directory = await stateDirectory();
    const firstAdapter = adapter(directory);
    const first = await firstAdapter.acquire(request("agent-a", ["src"]));
    expect(await first.release()).toBe(true);
    firstAdapter.dispose();

    const secondAdapter = adapter(directory);
    const second = await secondAdapter.acquire(request("agent-b", ["src"]));
    expect(second.fencingToken).toBe(first.fencingToken + 1);
    expect(await second.release()).toBe(true);
  });

  test("aborts while waiting for an overlapping lease", async () => {
    const directory = await stateDirectory();
    const firstAdapter = adapter(directory);
    const secondAdapter = adapter(directory);
    const first = await firstAdapter.acquire(request("agent-a", ["src"]));
    const abort = new AbortController();
    const pending = secondAdapter.acquire(request("agent-b", ["src"]), {
      signal: abort.signal,
    });

    await delay(20);
    abort.abort(new Error("cancelled durable acquisition"));
    await expect(pending).rejects.toThrow("cancelled durable acquisition");
    expect(await first.release()).toBe(true);
  });

  test("keeps concurrent release idempotent and permits a fresh lease", async () => {
    const directory = await stateDirectory();
    const firstAdapter = adapter(directory);
    const secondAdapter = adapter(directory);
    const first = await firstAdapter.acquire(request("agent-a", ["src"]));

    expect(
      (await Promise.all([first.release(), first.release()])).sort(),
    ).toEqual([false, true]);
    expect(first.lossSignal.aborted).toBe(false);
    const second = await secondAdapter.acquire(request("agent-b", ["src"]));
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
    expect(await second.release()).toBe(true);
  });

  test("uses one persistent retirement tombstone during dead-owner recovery", async () => {
    const directory = await stateDirectory();
    const workspaceKey = createHash("sha256").update("repo").digest("hex");
    const workspaceDirectory = join(directory, workspaceKey);
    const lockDirectory = join(workspaceDirectory, "lock");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const deadPid = child.pid;
    if (deadPid === undefined) {
      throw new Error("Failed to start dead-owner fixture process");
    }
    await once(child, "exit");
    const ownerToken = "observed-dead-owner";
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(lockDirectory, "owner.json"),
      JSON.stringify({
        token: ownerToken,
        pid: deadPid,
        acquiredAt: Date.now(),
      }),
    );

    const firstAdapter = adapter(directory);
    const secondAdapter = adapter(directory);
    const [first, second] = await Promise.all([
      firstAdapter.acquire(request("agent-a", ["src/foo"])),
      secondAdapter.acquire(request("agent-b", ["src/foobar"])),
    ]);
    const retiredName = `lock.retired.${createHash("sha256")
      .update(ownerToken)
      .digest("hex")}`;

    expect(await readdir(workspaceDirectory)).toContain(retiredName);
    expect(await first.release()).toBe(true);
    expect(await second.release()).toBe(true);
  });

  test("collects only valid workspace tombstones while offline", async () => {
    const directory = await stateDirectory();
    const workspaceDirectory = workspaceDirectoryFor(directory);
    // Recovering a dead owner's lock leaves a tombstone.
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const deadPid = child.pid;
    if (deadPid === undefined) {
      throw new Error("Failed to start dead-owner fixture process");
    }
    await once(child, "exit");
    await mkdir(join(workspaceDirectory, "lock"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(workspaceDirectory, "lock", "owner.json"),
      JSON.stringify({ token: "dead", pid: deadPid, acquiredAt: Date.now() }),
    );
    const instance = adapter(directory);
    const lease = await instance.acquire(request("agent-a", ["src"]));
    expect(await lease.release()).toBe(true);
    const unknownPath = join(workspaceDirectory, "keep.unknown");
    await writeFile(unknownPath, "keep", "utf8");

    const result = collectFileSystemWorkspaceTombstonesOffline({
      root: directory,
      confirmNoActiveWriters: true,
    });

    expect(result.removedTombstones).toBe(1);
    expect(await Bun.file(unknownPath).text()).toBe("keep");
    expect(
      (await readdir(workspaceDirectory)).filter((entry) =>
        ["lock.retired.", "lock.candidate-", "state.json.tmp-"].some((prefix) =>
          entry.startsWith(prefix),
        ),
      ),
    ).toEqual([]);
  });

  test("offline workspace collection requires confirmation and no active lock", async () => {
    const directory = await stateDirectory();
    expect(() =>
      collectFileSystemWorkspaceTombstonesOffline({
        root: directory,
        confirmNoActiveWriters: false as true,
      }),
    ).toThrow("confirmNoActiveWriters: true");
    expect(() =>
      collectFileSystemWorkspaceTombstonesOffline({
        root: "relative",
        confirmNoActiveWriters: true,
      }),
    ).toThrow("root must be absolute");

    const workspaceDirectory = workspaceDirectoryFor(directory);
    await mkdir(workspaceDirectory, { recursive: true });
    await mkdir(join(workspaceDirectory, "lock"));
    expect(() =>
      collectFileSystemWorkspaceTombstonesOffline({
        root: directory,
        confirmNoActiveWriters: true,
      }),
    ).toThrow("active lock or candidate");
  });

  test("offline workspace collection rejects symlinks", async () => {
    const directory = await stateDirectory();
    const outside = await stateDirectory();
    await symlink(outside, join(directory, "unsafe-link"));

    expect(() =>
      collectFileSystemWorkspaceTombstonesOffline({
        root: directory,
        confirmNoActiveWriters: true,
      }),
    ).toThrow("rejects symlinks");
  });
});

function workspaceDirectoryFor(root: string): string {
  return join(root, createHash("sha256").update("repo").digest("hex"));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

describe("FileSystemWorkspaceAdapter path case", () => {
  test("compares paths case-sensitively by default", async () => {
    const root = await stateDirectory();
    const first = adapter(root);
    await first.acquire(request("agent-a", ["Src/a"]));

    expect(adapter(root).conflicts(request("agent-b", ["src/a"]))).toEqual([]);
  });

  test("caseInsensitivePaths makes differently cased paths conflict", async () => {
    const root = await stateDirectory();
    const first = adapter(root, { caseInsensitivePaths: true });
    const held = await first.acquire(request("agent-a", ["Src/A"]));
    const second = adapter(root, { caseInsensitivePaths: true });

    const conflicts = second.conflicts(request("agent-b", ["src/a/file.ts"]));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      leaseId: held.leaseId,
      overlaps: [{ requestedPath: "src/a/file.ts", leasedPath: "Src/A" }],
    });

    const controller = new AbortController();
    const waiting = second.acquire(request("agent-b", ["SRC/a"]), {
      signal: controller.signal,
    });
    await Bun.sleep(30);
    controller.abort(new Error("still blocked"));
    await expect(waiting).rejects.toThrow("still blocked");
  });
});

describe("FileSystemWorkspaceAdapter state written by older releases", () => {
  // Writes a lease file from an older release, with a path the current grammar rejects.
  async function legacyState(root: string, legacyPath: string) {
    let now = 1_000;
    const writer = adapter(root, { now: () => now });
    await writer.acquire(request("legacy-owner", ["legacy"]));
    writer.dispose();
    const statePath = join(
      root,
      createHash("sha256").update("repo").digest("hex"),
      "state.json",
    );
    const state = JSON.parse(await Bun.file(statePath).text());
    state.leases[0].writePaths = [legacyPath];
    await writeFile(statePath, JSON.stringify(state));
    return {
      expiresAt: state.leases[0].expiresAt as number,
      leaseId: state.leases[0].leaseId as string,
      setNow: (value: number) => {
        now = value;
      },
    };
  }

  test.each(["x:y", "C:x", "x".repeat(4097)])(
    "an expired lease with a path no longer accepted (case %#) is dropped",
    async (legacyPath) => {
      const root = await stateDirectory();
      const legacy = await legacyState(root, legacyPath);
      const later = legacy.expiresAt + 1;
      const next = adapter(root, { now: () => later });

      const lease = await next.acquire(request("agent-b", ["src"]));
      expect(lease.writePaths).toEqual(["src"]);
      expect(next.conflicts(request("agent-c", ["src/a"]))).toHaveLength(1);
    },
  );

  test("a live lease with a path no longer accepted fails closed and names the lease", async () => {
    const root = await stateDirectory();
    const legacy = await legacyState(root, "x:y");
    const next = adapter(root, { now: () => legacy.expiresAt - 1 });

    const error = await next.acquire(request("agent-b", ["src"])).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      name: "WorkflowError",
      code: "WORKFLOW_WORKSPACE_STATE_INCOMPATIBLE",
      details: {
        workspaceId: "repo",
        leaseId: legacy.leaseId,
        expiresAt: legacy.expiresAt,
      },
    });
    expect(() => next.conflicts(request("agent-b", ["src"]))).toThrow(
      legacy.leaseId,
    );
  });
});
