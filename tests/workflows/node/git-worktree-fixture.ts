import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitWorktreeChangeDriver } from "../../../src/workflows/node/git-worktree-change-driver.js";
import { InMemoryWorkflowHostMutationJournal } from "../../../src/workflows/workspace/mutation-journal.js";

const roots = new Set<string>();

export async function cleanupRoots(): Promise<void> {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Creates a repository; `baseSymlinks` maps a committed path to a symlink
 * target (resolved against `root` when the value starts with "ROOT/").
 */
export async function createRepository(
  baseSymlinks: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "adk-mk-git-"));
  roots.add(root);
  const repoRoot = join(root, "repo");
  const worktreesRoot = join(root, "worktrees");
  await mkdir(repoRoot);
  await mkdir(worktreesRoot);
  git(root, "init", "--initial-branch=main", repoRoot);
  git(repoRoot, "config", "user.name", "Workflow Test");
  git(repoRoot, "config", "user.email", "workflow@example.test");
  await writeFile(join(repoRoot, "tracked.txt"), "base\n");
  for (const [path, target] of Object.entries(baseSymlinks)) {
    await symlink(
      target.startsWith("ROOT/") ? join(root, target.slice(5)) : target,
      join(repoRoot, path),
    );
  }
  git(repoRoot, "add", "--all", "--");
  git(repoRoot, "commit", "--no-gpg-sign", "--no-verify", "-m", "base");
  const baseRevision = git(repoRoot, "rev-parse", "HEAD");
  const driver = await NodeGitWorktreeChangeDriver.create({
    repoRoot,
    worktreesRoot,
    baseRevision,
    createWorkspaceId: (() => {
      let next = 0;
      return () => `workspace-${++next}`;
    })(),
    now: () => 1234,
    mutationJournal: new InMemoryWorkflowHostMutationJournal(),
  });
  const workspace = await driver.provision({
    executionId: "execution-1",
    taskId: "task-1",
  });
  const request = {
    executionId: "execution-1",
    taskId: "task-1",
    planRevision: 1,
    workspaceRevision: baseRevision,
    baseRevision,
  };
  return { root, repoRoot, baseRevision, driver, workspace, request };
}
