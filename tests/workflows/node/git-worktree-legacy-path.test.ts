/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { NodeGitWorktreeChangeDriver } from "../../../src/workflows/node/git-worktree-change-driver.js";

const roots = new Set<string>();

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("attaches a worktree created under the pre-0.7.0 directory name", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "adk-git-legacy-path-")),
  );
  roots.add(root);
  const repoRoot = join(root, "repo");
  const worktreesRoot = join(root, "worktrees");
  await mkdir(repoRoot);
  await mkdir(worktreesRoot);
  git(root, "init", "--initial-branch=main", repoRoot);
  git(repoRoot, "config", "user.name", "Workflow Test");
  git(repoRoot, "config", "user.email", "workflow@example.test");
  await writeFile(join(repoRoot, "tracked.txt"), "base\n");
  git(repoRoot, "add", "--all", "--");
  git(repoRoot, "commit", "--no-gpg-sign", "--no-verify", "-m", "base");
  const baseRevision = git(repoRoot, "rev-parse", "HEAD");
  const options = { repoRoot, worktreesRoot, baseRevision, now: () => 1234 };

  const driver = await NodeGitWorktreeChangeDriver.create(options);
  const workspace = await driver.provision({
    executionId: "execution-1",
    taskId: "task-1",
    parameters: { Mode: "x", alpha: 1 },
  });
  const { descriptor } = workspace;
  const canonicalPath = workspace.host.worktreePath;
  await writeFile(join(canonicalPath, "kept.txt"), "kept\n");

  // The pre-0.7.0 name hashed insertion-order JSON of this exact shape.
  const legacySuffix = createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: descriptor.workspaceId,
        executionId: descriptor.executionId,
        taskId: descriptor.taskId,
        revision: descriptor.revision,
        parameters: descriptor.parameters,
      }),
    )
    .digest("hex")
    .slice(0, 12);
  const legacyPath = join(
    dirname(canonicalPath),
    basename(canonicalPath).replace(/[a-f0-9]{12}$/u, legacySuffix),
  );
  expect(legacyPath).not.toBe(canonicalPath);
  await workspace.detach?.();
  git(repoRoot, "worktree", "move", canonicalPath, legacyPath);

  const restarted = await NodeGitWorktreeChangeDriver.create(options);
  const attached = await restarted.attach(descriptor);

  expect(attached?.host.worktreePath).toBe(legacyPath);
  // Re-attaching while active accepts the legacy path too.
  await expect(restarted.attach(descriptor)).resolves.toBeDefined();
  // An altered descriptor is still rejected.
  await expect(
    restarted.attach({ ...descriptor, executionId: "forged-execution" }),
  ).rejects.toMatchObject({ code: "GIT_WORKTREE_STALE" });
});
