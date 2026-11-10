import { afterEach, describe, expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { cleanupRoots, createRepository } from "./git-worktree-fixture.js";

afterEach(cleanupRoots);

describe("changed symlinks must use a relative target", () => {
  test("an absolute target is rejected even when it points inside the worktree", async () => {
    const repo = await createRepository();
    const worktree = repo.workspace.host.worktreePath;
    // Dangling, so only the lexical rule applies (no realpath result).
    await symlink(join(worktree, "missing.txt"), join(worktree, "abs.txt"));

    await expect(
      repo.driver.inspect(repo.workspace.host, repo.request),
    ).rejects.toMatchObject({ code: "GIT_SYMLINK_ESCAPE" });
  });

  test("the same target written relatively is accepted", async () => {
    const repo = await createRepository();
    const worktree = repo.workspace.host.worktreePath;
    await symlink("missing.txt", join(worktree, "rel.txt"));

    await expect(
      repo.driver.inspect(repo.workspace.host, repo.request),
    ).resolves.toBeDefined();
  });
});
