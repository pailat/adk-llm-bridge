import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupRoots, createRepository } from "./git-worktree-fixture.js";

afterEach(cleanupRoots);

describe("changed symlink must resolve inside the worktree", () => {
  test("a lexically contained link through an escaping directory symlink is rejected", async () => {
    // "outlink" is committed in the base as a directory symlink leaving the
    // repository, so it is not itself a changed entry.
    const repo = await createRepository({ outlink: "ROOT/outside" });
    await mkdir(join(repo.root, "outside"));
    await writeFile(join(repo.root, "outside", "secret.txt"), "secret\n");
    const worktree = repo.workspace.host.worktreePath;
    await symlink("outlink/secret.txt", join(worktree, "via.txt"));

    await expect(
      repo.driver.inspect(repo.workspace.host, repo.request),
    ).rejects.toMatchObject({ code: "GIT_SYMLINK_ESCAPE" });
  });
});
