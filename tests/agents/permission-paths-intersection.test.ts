import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "@google/adk";
import { guardPermissionRequest } from "../../src/agents/permissions/confirmation.js";
import {
  deriveSubAgentPermissionPolicy,
  getInheritedPermissions,
  setInheritedPermissions,
} from "../../src/agents/permissions/inheritance.js";
import {
  assertPermissionPolicy,
  snapshotPermissionPolicy,
} from "../../src/agents/permissions/policy.js";
import type { ExternalAgentPermissionPolicy } from "../../src/agents/permissions/schema.js";

function derive(parent: string[], child: string[]) {
  return deriveSubAgentPermissionPolicy(
    { mode: "workspace-write", allowedPaths: parent },
    { mode: "workspace-write", allowedPaths: child },
  );
}

function paths(parent: string[], child: string[]) {
  return derive(parent, child).allowedPaths;
}

function allowed(
  policy: ExternalAgentPermissionPolicy,
  filePath: string,
  workingDirectory = "/",
): boolean {
  return (
    guardPermissionRequest(
      policy,
      { requestId: "r", toolName: "Read", input: { file_path: filePath } },
      { workingDirectory },
    ) === undefined
  );
}

describe("allowedPaths intersection by containment", () => {
  test("a child root inside a parent root is kept", () => {
    expect(paths(["/repo"], ["/repo/src"])).toEqual(["/repo/src"]);
  });

  test("a parent root inside a child root is kept", () => {
    expect(paths(["/repo/src"], ["/repo"])).toEqual(["/repo/src"]);
  });

  test("equal roots are kept once", () => {
    expect(paths(["/repo", "/tmp"], ["/repo", "/etc"])).toEqual(["/repo"]);
  });

  test("roots that differ only in spelling are kept once", () => {
    expect(paths(["/repo"], ["/repo/src", "/repo/src/"])).toEqual([
      "/repo/src",
    ]);
    expect(paths(["/repo/./src", "/repo/src"], ["/repo"])).toEqual([
      "/repo/./src",
    ]);
  });

  test("a sibling with a shared prefix is not inside", () => {
    expect(paths(["/repo"], ["/repo2", "/repository/src"])).toEqual([]);
  });

  test("disjoint roots give an empty list, which allows no path", () => {
    expect(paths(["/repo"], ["/etc"])).toEqual([]);
  });

  test("an empty list on either side gives an empty list", () => {
    expect(paths([], ["/repo"])).toEqual([]);
    expect(paths(["/repo"], [])).toEqual([]);
    expect(paths([], [])).toEqual([]);
  });

  test("`..` segments cannot climb out of the parent", () => {
    expect(paths(["/repo/src"], ["/repo/src/../secrets"])).toEqual([]);
    expect(paths(["/repo"], ["/repo/src/../lib"])).toEqual([
      "/repo/src/../lib",
    ]);
  });

  test("the root of the filesystem as parent keeps the child's roots", () => {
    expect(paths(["/"], ["/repo", "/etc"])).toEqual(["/repo", "/etc"]);
  });

  test("a ~ root is compared under the home directory", () => {
    expect(paths(["~"], ["~/project", "/etc"])).toEqual(["~/project"]);
    expect(paths([homedir()], ["~/project"])).toEqual(["~/project"]);
    expect(paths(["~/project"], ["~/other"])).toEqual([]);
  });

  test("relative roots are dropped when both sides set allowedPaths", () => {
    // Each relative root is relative to its own agent's working directory,
    // which is not known here: `src` of a parent in /a is not `src` of a
    // child in /b.
    expect(paths(["src"], ["src"])).toEqual([]);
    expect(paths(["src"], ["src/lib"])).toEqual([]);
    expect(paths(["/repo"], ["src", "/repo/lib"])).toEqual(["/repo/lib"]);
    expect(paths(["src", "/repo"], ["/repo/src"])).toEqual(["/repo/src"]);
  });

  test("a parent's relative roots never reach a child without allowedPaths", () => {
    const derived = deriveSubAgentPermissionPolicy(
      { mode: "workspace-write", allowedPaths: ["src", "/abs"] },
      { mode: "workspace-write" },
    );
    expect(derived.allowedPaths).toEqual(["/abs"]);
    // The parent's `src` was relative to the parent's directory (/a); the
    // child runs in /b and must not get /b/src.
    expect(allowed(derived, "/b/src/f", "/b")).toBe(false);
    expect(allowed(derived, "/abs/f", "/b")).toBe(true);
  });

  test("a parent with only relative roots gives an inherit-only child no path", () => {
    const derived = deriveSubAgentPermissionPolicy(
      { mode: "workspace-write", allowedPaths: ["src"] },
      { mode: "ask" },
    );
    expect(derived.allowedPaths).toEqual([]);
    expect(allowed(derived, "/b/src/f", "/b")).toBe(false);
    // A child with no policy at all gets the same.
    expect(
      deriveSubAgentPermissionPolicy({
        mode: "workspace-write",
        allowedPaths: ["src"],
      }).allowedPaths,
    ).toEqual([]);
  });

  test("a child's own relative roots under a parent without allowedPaths stay", () => {
    expect(
      deriveSubAgentPermissionPolicy(
        { mode: "workspace-write" },
        { mode: "workspace-write", allowedPaths: ["src"] },
      ).allowedPaths,
    ).toEqual(["src"]);
  });

  test("a single side keeps its own list", () => {
    expect(
      deriveSubAgentPermissionPolicy(
        { mode: "ask", allowedPaths: ["/repo"] },
        { mode: "ask" },
      ).allowedPaths,
    ).toEqual(["/repo"]);
    expect(
      deriveSubAgentPermissionPolicy(
        { mode: "ask" },
        { mode: "ask", allowedPaths: ["/repo/src"] },
      ).allowedPaths,
    ).toEqual(["/repo/src"]);
  });
});

describe("the guard under allowedPaths", () => {
  test("an empty list denies every path", () => {
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [],
    };
    for (const path of ["/", "/repo/a", "relative/file"]) {
      expect(allowed(policy, path, "/repo")).toBe(false);
    }
  });

  test("a derived empty list denies every path", () => {
    expect(allowed(derive(["/repo"], ["/etc"]), "/repo/a")).toBe(false);
    expect(allowed(derive(["/repo"], ["/etc"]), "/etc/a")).toBe(false);
  });
});

describe("parent roots stay bounds of the derived policy", () => {
  test("the derived policy lists both sides as bounds", () => {
    expect(derive(["/repo"], ["/repo/src"]).pathBounds).toEqual([
      ["/repo"],
      ["/repo/src"],
    ]);
  });

  test("relative roots are not kept as bounds", () => {
    expect(derive(["src", "/repo"], ["/repo/src"]).pathBounds).toEqual([
      ["/repo"],
      ["/repo/src"],
    ]);
  });

  test("bounds accumulate across levels", () => {
    const level1 = derive(["/repo"], ["/repo/src"]);
    const level2 = deriveSubAgentPermissionPolicy(level1, {
      mode: "workspace-write",
      allowedPaths: ["/repo/src/lib"],
    });
    expect(level2.allowedPaths).toEqual(["/repo/src/lib"]);
    expect(level2.pathBounds).toEqual([
      ["/repo"],
      ["/repo/src"],
      ["/repo/src"],
      ["/repo/src/lib"],
    ]);
    // A child without allowedPaths inherits the paths and the bounds.
    const level3 = deriveSubAgentPermissionPolicy(level2, { mode: "ask" });
    expect(level3.allowedPaths).toEqual(["/repo/src/lib"]);
    expect(level3.pathBounds).toEqual(level2.pathBounds);
  });

  test("an inherit-only child keeps the parent's bounds", () => {
    const bounded: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: ["/repo/later"],
      pathBounds: [["/repo"]],
    };
    expect(deriveSubAgentPermissionPolicy(bounded).pathBounds).toEqual([
      ["/repo"],
    ]);
    expect(
      deriveSubAgentPermissionPolicy(bounded, { mode: "ask" }).pathBounds,
    ).toEqual([["/repo"]]);
  });

  test("a child policy's own bounds are kept under an unbounded parent", () => {
    const parent: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: ["/repo/later"],
    };
    const child: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: ["/repo/later"],
      pathBounds: [["/repo"]],
    };
    expect(deriveSubAgentPermissionPolicy(parent, child).pathBounds).toEqual([
      ["/repo"],
      ["/repo/later"],
      ["/repo/later"],
    ]);
  });

  test("the guard enforces every bound, not only allowedPaths", () => {
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: ["/repo", "/etc"],
      pathBounds: [["/repo"]],
    };
    expect(allowed(policy, "/repo/a")).toBe(true);
    expect(allowed(policy, "/etc/passwd")).toBe(false);
  });

  test("an empty bound denies every path", () => {
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: ["/repo"],
      pathBounds: [[]],
    };
    expect(allowed(policy, "/repo/a")).toBe(false);
  });

  test("bounds are enforced without allowedPaths", () => {
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      pathBounds: [["/repo"]],
    };
    expect(allowed(policy, "/repo/a")).toBe(true);
    expect(allowed(policy, "/etc/a")).toBe(false);
  });

  test("bounds survive the snapshot, deep freeze and session inheritance", () => {
    const derived = derive(["/repo"], ["/repo/src"]);
    const snapshot = snapshotPermissionPolicy(derived);
    expect(snapshot?.pathBounds).toEqual([["/repo"], ["/repo/src"]]);
    expect(Object.isFrozen(snapshot?.pathBounds)).toBe(true);
    expect(Object.isFrozen(snapshot?.pathBounds?.[0])).toBe(true);

    const session = createSession({ id: "s", appName: "a", userId: "u" });
    setInheritedPermissions(session, derived);
    const inherited = getInheritedPermissions(session);
    expect(inherited?.pathBounds).toEqual([["/repo"], ["/repo/src"]]);
    expect(Object.isFrozen(inherited?.pathBounds?.[1])).toBe(true);
  });

  test("a malformed pathBounds is rejected", () => {
    for (const pathBounds of ["/repo", ["/repo"], [[1]], [null]]) {
      expect(snapshotPermissionPolicy({ mode: "ask", pathBounds })).toBeNull();
      expect(() =>
        assertPermissionPolicy({ mode: "ask", pathBounds }, "agent"),
      ).toThrow();
    }
  });
});

describe("symlinks on both sides", () => {
  let root = "";
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "adk-paths-")));
    mkdirSync(join(root, "repo", "src"), { recursive: true });
    mkdirSync(join(root, "outside", "secret"), { recursive: true });
    // A link inside the parent root that points outside it.
    symlinkSync(join(root, "outside"), join(root, "repo", "escape"));
    // A link outside the parent root that points inside it.
    symlinkSync(join(root, "repo", "src"), join(root, "into-src"));
    // A parent root given through a link.
    symlinkSync(join(root, "repo"), join(root, "repo-link"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a child root that is a symlink out of the parent is dropped", () => {
    expect(paths([join(root, "repo")], [join(root, "repo", "escape")])).toEqual(
      [],
    );
  });

  test("a child root that is a symlink into the parent is kept", () => {
    const child = join(root, "into-src");
    expect(paths([join(root, "repo")], [child])).toEqual([child]);
  });

  test("a parent root given through a symlink is resolved too", () => {
    expect(
      paths([join(root, "repo-link")], [join(root, "repo", "src")]),
    ).toEqual([join(root, "repo", "src")]);
    expect(paths([join(root, "repo-link")], [join(root, "outside")])).toEqual(
      [],
    );
  });

  test("a missing tail under an outward symlink is denied", () => {
    const policy = derive([join(root, "repo")], [join(root, "repo")]);
    expect(
      allowed(policy, join(root, "repo", "escape", "new", "file.txt")),
    ).toBe(false);
    expect(allowed(policy, join(root, "repo", "src", "new.txt"))).toBe(true);
  });

  test("a symlink created after derive cannot escape the parent root", () => {
    const later = join(root, "repo", "later");
    const policy = derive([join(root, "repo")], [later]);
    expect(policy.allowedPaths).toEqual([later]);
    symlinkSync(join(root, "outside"), later);
    try {
      expect(allowed(policy, join(later, "secret", "k"))).toBe(false);
    } finally {
      unlinkSync(later);
    }
  });

  test("bounds carried one level down still stop a retargeted symlink", () => {
    const later = join(root, "repo", "later");
    symlinkSync(join(root, "repo", "src"), later);
    try {
      // Level 1: the grandparent's /repo bounds a child kept at repo/later.
      const level1 = derive([join(root, "repo")], [later]);
      // An inherit-only grandchild, and a parent without bounds whose child
      // policy carries level 1 (as a branded or session-inherited policy can).
      const inheritOnly = deriveSubAgentPermissionPolicy(level1);
      const viaChild = deriveSubAgentPermissionPolicy(
        { mode: "workspace-write", allowedPaths: [later] },
        level1,
      );
      expect(allowed(inheritOnly, join(later, "f.txt"))).toBe(true);
      expect(allowed(viaChild, join(later, "f.txt"))).toBe(true);

      unlinkSync(later);
      symlinkSync(join(root, "outside"), later);
      expect(allowed(inheritOnly, join(later, "secret", "k"))).toBe(false);
      expect(allowed(viaChild, join(later, "secret", "k"))).toBe(false);
    } finally {
      rmSync(later, { force: true });
    }
  });

  test("a symlink retargeted after derive cannot escape the parent root", () => {
    const link = join(root, "repo", "moving");
    symlinkSync(join(root, "repo", "src"), link);
    try {
      const policy = derive([join(root, "repo")], [link]);
      expect(policy.allowedPaths).toEqual([link]);
      expect(allowed(policy, join(link, "file.txt"))).toBe(true);
      unlinkSync(link);
      symlinkSync(join(root, "outside"), link);
      expect(allowed(policy, join(link, "secret", "k"))).toBe(false);
    } finally {
      rmSync(link, { force: true });
    }
  });
});
