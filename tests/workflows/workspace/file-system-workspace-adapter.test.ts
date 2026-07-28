/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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

  test("auto-renews with an unref heartbeat while the adapter is live", async () => {
    const directory = await stateDirectory();
    const instance = adapter(directory, {
      leaseTtlMs: 80,
      heartbeatIntervalMs: 15,
    });
    const lease = await instance.acquire(request("agent-a", ["src"]));
    const initialExpiry = lease.expiresAt;

    await delay(50);
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
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}
