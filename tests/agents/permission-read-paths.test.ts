import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unenforceablePathsRefusal } from "../../src/agents/driver/policy-errors.js";
import {
  guardPermissionRequest,
  guardRequestPaths,
  readPathsReadAllowed,
} from "../../src/agents/permissions/confirmation.js";
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

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** `a` is the writable root, `b` a read root, `c` neither. */
function layout(): { root: string; a: string; b: string; c: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "guard-read-paths-")));
  dirs.push(root);
  const a = join(root, "a");
  const b = join(root, "b");
  const c = join(root, "c");
  for (const dir of [a, b, c]) mkdirSync(dir, { recursive: true });
  return { root, a, b, c };
}

function paths(
  policy: ExternalAgentPermissionPolicy,
  toolName: string,
  input: Record<string, unknown>,
  workingDirectory: string,
) {
  return guardRequestPaths(policy, { toolName, input }, { workingDirectory });
}

function guard(
  policy: ExternalAgentPermissionPolicy,
  toolName: string,
  input: Record<string, unknown>,
  workingDirectory: string,
) {
  return guardPermissionRequest(
    policy,
    { requestId: "r1", toolName, input },
    { workingDirectory },
  );
}

const READS: Array<[string, (dir: string) => Record<string, unknown>]> = [
  ["Read", (dir) => ({ file_path: join(dir, "x.ts") })],
  ["Glob", (dir) => ({ pattern: "**/*.ts", path: dir })],
  ["Glob", (dir) => ({ pattern: `${dir}/**/*.ts` })],
  ["Grep", (dir) => ({ pattern: "needle", path: dir })],
  ["LS", (dir) => ({ path: dir })],
  ["NotebookRead", (dir) => ({ notebook_path: join(dir, "x.ipynb") })],
  ["read_file", (dir) => ({ absolute_path: join(dir, "x.ts") })],
  ["read_many_files", (dir) => ({ paths: [join(dir, "x.ts")] })],
  ["list_directory", (dir) => ({ dir_path: dir })],
  ["glob", (dir) => ({ pattern: "*.ts", dir_path: dir })],
  ["grep_search", (dir) => ({ pattern: "needle", dir_path: dir })],
  ["search_file_content", (dir) => ({ pattern: "needle", path: dir })],
];

const WRITES: Array<[string, (dir: string) => Record<string, unknown>]> = [
  ["Write", (dir) => ({ file_path: join(dir, "x.ts") })],
  ["Edit", (dir) => ({ file_path: join(dir, "x.ts") })],
  ["MultiEdit", (dir) => ({ file_path: join(dir, "x.ts") })],
  ["NotebookEdit", (dir) => ({ notebook_path: join(dir, "x.ipynb") })],
  ["write_file", (dir) => ({ file_path: join(dir, "x.ts") })],
  ["replace", (dir) => ({ file_path: join(dir, "x.ts") })],
  [
    "apply_patch",
    (dir) => ({ input: `*** Update File: ${join(dir, "x.ts")}\n` }),
  ],
  // Unknown tools count as writes: the guard cannot tell what they do.
  ["SomeFutureTool", (dir) => ({ file_path: join(dir, "x.ts") })],
  ["read", (dir) => ({ file_path: join(dir, "x.ts") })],
  ["mcp__other__Read", (dir) => ({ file_path: join(dir, "x.ts") })],
];

describe("readPaths: read tools reach the read roots, nothing else does", () => {
  for (const mode of ["workspace-write", "ask", "read-only"] as const) {
    for (const [tool, input] of READS) {
      test(`${mode}: ${tool} inside readPaths passes the path rule`, () => {
        const { a, b } = layout();
        const policy = { mode, allowedPaths: [a], readPaths: [b] };
        expect(paths(policy, tool, input(b), a)).toBeUndefined();
        expect(paths(policy, tool, input(a), a)).toBeUndefined();
      });
    }
    for (const [tool, input] of WRITES) {
      test(`${mode}: ${tool} inside readPaths is denied as a write`, () => {
        const { a, b } = layout();
        const policy = { mode, allowedPaths: [a], readPaths: [b] };
        const decision = paths(policy, tool, input(b), a);
        expect(decision?.behavior).toBe("deny");
        expect(
          decision && "message" in decision ? decision.message : "",
        ).toMatch(/outside the paths allowed/);
        expect(guard(policy, tool, input(b), a)?.behavior).toBe("deny");
        // The writable root still takes the write (the mode decides the rest).
        expect(paths(policy, tool, input(a), a)).toBeUndefined();
      });
    }
  }

  test("a read outside both lists is denied", () => {
    const { a, b, c } = layout();
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [a],
      readPaths: [b],
    };
    for (const [tool, input] of READS) {
      expect(paths(policy, tool, input(c), a)?.behavior).toBe("deny");
    }
  });

  test("one path outside the read roots denies the whole read", () => {
    const { a, b, c } = layout();
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [a],
      readPaths: [b],
    };
    expect(
      paths(
        policy,
        "read_many_files",
        { paths: [join(b, "x.ts"), join(c, "y.ts")] },
        a,
      )?.behavior,
    ).toBe("deny");
  });

  test("a search without a search root checks the working directory", () => {
    const { a, b, c } = layout();
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [a],
      readPaths: [b],
    };
    expect(paths(policy, "Grep", { pattern: "x" }, b)).toBeUndefined();
    expect(paths(policy, "Grep", { pattern: "x" }, c)?.behavior).toBe("deny");
  });

  test("a symlink inside readPaths that leaves them is denied", () => {
    const { a, b, c } = layout();
    symlinkSync(c, join(b, "out"));
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [a],
      readPaths: [b],
    };
    expect(
      paths(policy, "Read", { file_path: join(b, "out", "x.ts") }, a)?.behavior,
    ).toBe("deny");
  });

  test("a symlink inside allowedPaths into readPaths is no way to write there", () => {
    const { a, b } = layout();
    symlinkSync(b, join(a, "into-b"));
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [a],
      readPaths: [b],
    };
    expect(
      paths(policy, "Write", { file_path: join(a, "into-b", "x.ts") }, a)
        ?.behavior,
    ).toBe("deny");
    expect(
      paths(policy, "Read", { file_path: join(a, "into-b", "x.ts") }, a),
    ).toBeUndefined();
  });

  test("relative readPaths resolve against the working directory", () => {
    const { root, a, b } = layout();
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: ["a"],
      readPaths: ["b"],
    };
    expect(
      paths(policy, "Read", { file_path: join(b, "x.ts") }, root),
    ).toBeUndefined();
    expect(
      paths(policy, "Write", { file_path: join(b, "x.ts") }, root)?.behavior,
    ).toBe("deny");
    expect(
      paths(policy, "Write", { file_path: join(a, "x.ts") }, root),
    ).toBeUndefined();
  });

  test("without readPaths a policy behaves as before: reads stay in allowedPaths", () => {
    const { a, b } = layout();
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [a],
    };
    expect(
      paths(policy, "Read", { file_path: join(b, "x.ts") }, a)?.behavior,
    ).toBe("deny");
  });

  test("an empty readPaths adds no read root", () => {
    const { a, b } = layout();
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [a],
      readPaths: [],
    };
    expect(
      paths(policy, "Read", { file_path: join(b, "x.ts") }, a)?.behavior,
    ).toBe("deny");
  });
});

describe("read bounds", () => {
  test("without readPathBounds, reads follow pathBounds", () => {
    const { a, b } = layout();
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [a],
      readPaths: [b],
      pathBounds: [[a]],
    };
    expect(
      paths(policy, "Read", { file_path: join(b, "x") }, a)?.behavior,
    ).toBe("deny");
  });

  test("readPathBounds replaces pathBounds for reads only", () => {
    const { a, b } = layout();
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [a, b],
      readPaths: [b],
      pathBounds: [[a]],
      readPathBounds: [[a, b]],
    };
    expect(
      paths(policy, "Read", { file_path: join(b, "x") }, a),
    ).toBeUndefined();
    expect(
      paths(policy, "Write", { file_path: join(b, "x") }, a)?.behavior,
    ).toBe("deny");
  });

  test("read rules without write roots allow no write (hand-built policy)", () => {
    const { a, b } = layout();
    for (const policy of [
      { mode: "workspace-write", readPaths: [b] },
      { mode: "workspace-write", readPathBounds: [[a, b]] },
    ] as ExternalAgentPermissionPolicy[]) {
      expect(
        paths(policy, "Write", { file_path: join(a, "x") }, a)?.behavior,
      ).toBe("deny");
    }
    expect(
      paths(
        { mode: "workspace-write", readPaths: [b] },
        "Read",
        { file_path: join(b, "x") },
        a,
      ),
    ).toBeUndefined();
  });
});

describe("readPathsReadAllowed: which calls the driver may approve unasked", () => {
  test("a known read tool whose every path is inside the read roots", () => {
    const { a, b, c } = layout();
    const policy: ExternalAgentPermissionPolicy = {
      mode: "read-only",
      allowedPaths: [a],
      readPaths: [b],
    };
    const options = { workingDirectory: a };
    for (const [tool, input] of READS) {
      expect(
        readPathsReadAllowed(
          policy,
          { toolName: tool, input: input(b) },
          options,
        ),
      ).toBe(true);
      expect(
        readPathsReadAllowed(
          policy,
          { toolName: tool, input: input(c) },
          options,
        ),
      ).toBe(false);
    }
    for (const [tool, input] of WRITES) {
      expect(
        readPathsReadAllowed(
          policy,
          { toolName: tool, input: input(b) },
          options,
        ),
      ).toBe(false);
    }
  });

  test("a write inside allowedPaths is never approved unasked", () => {
    const { a, b } = layout();
    const policy: ExternalAgentPermissionPolicy = {
      mode: "ask",
      allowedPaths: [a],
      readPaths: [b],
    };
    for (const [tool, input] of WRITES) {
      expect(
        readPathsReadAllowed(
          policy,
          { toolName: tool, input: input(a) },
          { workingDirectory: a },
        ),
      ).toBe(false);
    }
  });

  test("a blocked path outside the read roots is not approved", () => {
    const { a, b, c } = layout();
    const policy: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [a],
      readPaths: [b],
    };
    expect(
      readPathsReadAllowed(
        policy,
        {
          toolName: "Read",
          input: { file_path: join(b, "x.ts") },
          blockedPath: join(c, "x.ts"),
        },
        { workingDirectory: a },
      ),
    ).toBe(false);
  });

  test("never without readPaths, and never for a read tool with no path", () => {
    const { a, b } = layout();
    expect(
      readPathsReadAllowed(
        { mode: "workspace-write", allowedPaths: [a, b] },
        { toolName: "Read", input: { file_path: join(b, "x.ts") } },
        { workingDirectory: a },
      ),
    ).toBe(false);
    expect(
      readPathsReadAllowed(undefined, { toolName: "Read", input: {} }),
    ).toBe(false);
    expect(
      readPathsReadAllowed(
        { mode: "workspace-write", allowedPaths: [a], readPaths: [b] },
        { toolName: "Read", input: {} },
        { workingDirectory: a },
      ),
    ).toBe(false);
  });
});

describe("readPaths validation", () => {
  test("is copied and frozen", () => {
    const readPaths = ["/b"];
    const policy = assertPermissionPolicy(
      { mode: "workspace-write", allowedPaths: ["/a"], readPaths },
      "agent",
    );
    readPaths.push("/c");
    expect(policy?.readPaths).toEqual(["/b"]);
    expect(Object.isFrozen(policy?.readPaths)).toBe(true);
  });

  test("readPathBounds is copied and frozen", () => {
    const policy = snapshotPermissionPolicy({
      mode: "workspace-write",
      allowedPaths: ["/a"],
      readPathBounds: [["/a", "/b"]],
    });
    expect(policy?.readPathBounds).toEqual([["/a", "/b"]]);
    expect(Object.isFrozen(policy?.readPathBounds)).toBe(true);
    expect(Object.isFrozen(policy?.readPathBounds?.[0])).toBe(true);
  });

  for (const readPaths of ["/b", [1], [null], {}]) {
    test(`rejects readPaths ${JSON.stringify(readPaths)}`, () => {
      expect(() =>
        assertPermissionPolicy(
          { mode: "workspace-write", allowedPaths: ["/a"], readPaths },
          "agent",
        ),
      ).toThrow(/readPaths/);
    });
  }

  for (const readPathBounds of ["/b", ["/b"], [[1]]]) {
    test(`rejects readPathBounds ${JSON.stringify(readPathBounds)}`, () => {
      expect(() =>
        assertPermissionPolicy(
          { mode: "workspace-write", allowedPaths: ["/a"], readPathBounds },
          "agent",
        ),
      ).toThrow(/readPathBounds/);
    });
  }

  test("rejects readPaths without allowedPaths: paths are not restricted then", () => {
    expect(() =>
      assertPermissionPolicy(
        { mode: "workspace-write", readPaths: ["/b"] },
        "agent",
      ),
    ).toThrow(/readPaths/);
  });
});

describe("readPaths inheritance: never wider than the parent's reads", () => {
  test("a child without a policy inherits the read roots", () => {
    const { a, b } = layout();
    const derived = deriveSubAgentPermissionPolicy(
      { mode: "workspace-write", allowedPaths: [a], readPaths: [b] },
      undefined,
    );
    expect(
      paths(derived, "Read", { file_path: join(b, "x") }, a),
    ).toBeUndefined();
    expect(
      paths(derived, "Write", { file_path: join(b, "x") }, a)?.behavior,
    ).toBe("deny");
  });

  test("a child keeps only the read roots its parent can read", () => {
    const { a, b, c } = layout();
    const parent: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [a],
      readPaths: [b],
    };
    const child: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [join(a, "sub")],
      readPaths: [b, c],
    };
    mkdirSync(join(a, "sub"));
    const derived = deriveSubAgentPermissionPolicy(parent, child);
    expect(derived.allowedPaths).toEqual([join(a, "sub")]);
    expect(
      paths(derived, "Read", { file_path: join(b, "x") }, a),
    ).toBeUndefined();
    expect(
      paths(derived, "Read", { file_path: join(c, "x") }, a)?.behavior,
    ).toBe("deny");
    // The child's own writable root stays readable; the parent's wider one
    // is not the child's to read.
    expect(
      paths(derived, "Read", { file_path: join(a, "sub", "x") }, a),
    ).toBeUndefined();
    expect(
      paths(derived, "Read", { file_path: join(a, "x") }, a)?.behavior,
    ).toBe("deny");
    expect(
      paths(derived, "Write", { file_path: join(b, "x") }, a)?.behavior,
    ).toBe("deny");
  });

  test("a parent's writable root can be a child's read root", () => {
    const { a, b } = layout();
    mkdirSync(join(a, "out"));
    const derived = deriveSubAgentPermissionPolicy(
      { mode: "workspace-write", allowedPaths: [a] },
      {
        mode: "workspace-write",
        allowedPaths: [join(a, "out")],
        readPaths: [a, b],
      },
    );
    expect(
      paths(derived, "Read", { file_path: join(a, "x") }, a),
    ).toBeUndefined();
    expect(
      paths(derived, "Read", { file_path: join(b, "x") }, a)?.behavior,
    ).toBe("deny");
    expect(
      paths(derived, "Write", { file_path: join(a, "x") }, a)?.behavior,
    ).toBe("deny");
    expect(
      paths(derived, "Write", { file_path: join(a, "out", "x") }, a),
    ).toBeUndefined();
  });

  test("a child cannot turn a parent's read root into a writable one", () => {
    const { a, b } = layout();
    const derived = deriveSubAgentPermissionPolicy(
      { mode: "workspace-write", allowedPaths: [a], readPaths: [b] },
      { mode: "workspace-write", allowedPaths: [a, b] },
    );
    expect(derived.allowedPaths).toEqual([a]);
    expect(
      paths(derived, "Write", { file_path: join(b, "x") }, a)?.behavior,
    ).toBe("deny");
  });

  test("a child's readPaths bound by a parent without readPaths stay in the parent's roots", () => {
    const { a, b } = layout();
    const derived = deriveSubAgentPermissionPolicy(
      { mode: "workspace-write", allowedPaths: [a] },
      { mode: "workspace-write", allowedPaths: [a], readPaths: [b] },
    );
    expect(
      paths(derived, "Read", { file_path: join(b, "x") }, a)?.behavior,
    ).toBe("deny");
  });

  test("a child's own readPaths stay when the parent sets no paths", () => {
    const { a, b } = layout();
    const derived = deriveSubAgentPermissionPolicy(
      { mode: "workspace-write" },
      { mode: "workspace-write", allowedPaths: [a], readPaths: [b] },
    );
    expect(
      paths(derived, "Read", { file_path: join(b, "x") }, a),
    ).toBeUndefined();
    expect(
      paths(derived, "Write", { file_path: join(b, "x") }, a)?.behavior,
    ).toBe("deny");
  });

  test("a parent's relative read roots do not pass to the child", () => {
    const { root, a, b } = layout();
    const derived = deriveSubAgentPermissionPolicy(
      { mode: "workspace-write", allowedPaths: [a], readPaths: ["b"] },
      undefined,
    );
    expect(
      paths(derived, "Read", { file_path: join(b, "x") }, root)?.behavior,
    ).toBe("deny");
  });

  test("a read root retargeted after derivation cannot leave the parent's reads", () => {
    const { root, a, b, c } = layout();
    const link = join(root, "link");
    symlinkSync(b, link);
    const derived = deriveSubAgentPermissionPolicy(
      { mode: "workspace-write", allowedPaths: [a], readPaths: [b] },
      { mode: "workspace-write", allowedPaths: [a], readPaths: [link] },
    );
    expect(
      paths(derived, "Read", { file_path: join(link, "x") }, a),
    ).toBeUndefined();
    unlinkSync(link);
    symlinkSync(c, link);
    expect(
      paths(derived, "Read", { file_path: join(link, "x") }, a)?.behavior,
    ).toBe("deny");
  });

  test("a parent's own bounds keep binding the child's reads", () => {
    const { a, b, c } = layout();
    const derived = deriveSubAgentPermissionPolicy(
      {
        mode: "workspace-write",
        allowedPaths: [a, b],
        readPaths: [c],
        pathBounds: [[a]],
      },
      { mode: "workspace-write", allowedPaths: [a], readPaths: [b] },
    );
    expect(
      paths(derived, "Read", { file_path: join(a, "x") }, a),
    ).toBeUndefined();
    expect(
      paths(derived, "Read", { file_path: join(b, "x") }, a)?.behavior,
    ).toBe("deny");
  });

  test("a child's own read bounds keep binding its reads after derivation", () => {
    const { a, b, c } = layout();
    const parent: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [a],
      readPaths: [b, c],
    };
    for (const child of [
      {
        mode: "workspace-write",
        allowedPaths: [a],
        readPaths: [b, c],
        readPathBounds: [[a, b]],
      },
      {
        mode: "workspace-write",
        allowedPaths: [a],
        readPaths: [b, c],
        pathBounds: [[a, b]],
      },
    ] as ExternalAgentPermissionPolicy[]) {
      const derived = deriveSubAgentPermissionPolicy(parent, child);
      expect(
        paths(derived, "Read", { file_path: join(b, "x") }, a),
      ).toBeUndefined();
      expect(
        paths(derived, "Read", { file_path: join(c, "x") }, a)?.behavior,
      ).toBe("deny");
    }
  });

  test("a grandchild cannot read wider than its grandparent", () => {
    const { a, b, c } = layout();
    const parent = deriveSubAgentPermissionPolicy(
      { mode: "workspace-write", allowedPaths: [a], readPaths: [b] },
      { mode: "workspace-write", allowedPaths: [a], readPaths: [b] },
    );
    const grandchild = deriveSubAgentPermissionPolicy(parent, {
      mode: "workspace-write",
      allowedPaths: [a],
      readPaths: [b, c],
      readPathBounds: [[a, b, c]],
    });
    expect(
      paths(grandchild, "Read", { file_path: join(c, "x") }, a)?.behavior,
    ).toBe("deny");
    expect(
      paths(grandchild, "Read", { file_path: join(b, "x") }, a),
    ).toBeUndefined();
  });

  test("policies without readPaths derive exactly as before", () => {
    const { a } = layout();
    mkdirSync(join(a, "sub"));
    const derived = deriveSubAgentPermissionPolicy(
      { mode: "workspace-write", allowedPaths: [a] },
      { mode: "workspace-write", allowedPaths: [join(a, "sub")] },
    );
    expect(derived).toEqual({
      mode: "workspace-write",
      allowNetwork: false,
      allowedPaths: [join(a, "sub")],
      pathBounds: [[a], [join(a, "sub")]],
    });
  });

  test("the session registry stores readPaths frozen and only narrows them", () => {
    const { a, b, c } = layout();
    const session = {};
    setInheritedPermissions(session, {
      mode: "workspace-write",
      allowedPaths: [a],
      readPaths: [b],
    });
    setInheritedPermissions(session, {
      mode: "workspace-write",
      allowedPaths: [a],
      readPaths: [b, c],
    });
    const stored = getInheritedPermissions(session);
    expect(stored).toBeDefined();
    if (!stored) return;
    expect(Object.isFrozen(stored.readPaths)).toBe(true);
    expect(
      paths(stored, "Read", { file_path: join(b, "x") }, a),
    ).toBeUndefined();
    expect(
      paths(stored, "Read", { file_path: join(c, "x") }, a)?.behavior,
    ).toBe("deny");
  });
});

describe("drivers that cannot check paths refuse readPaths", () => {
  test("readPaths alone is enough to refuse", () => {
    expect(
      unenforceablePathsRefusal(
        { mode: "workspace-write", readPaths: ["/b"] },
        { runtime: "Codex", allowUnenforcedPaths: false },
      )?.code,
    ).toBe("EXTERNAL_AGENT_PATHS_UNENFORCEABLE");
    expect(
      unenforceablePathsRefusal(
        { mode: "workspace-write", readPathBounds: [["/b"]] },
        { runtime: "Codex", allowUnenforcedPaths: false },
      )?.code,
    ).toBe("EXTERNAL_AGENT_PATHS_UNENFORCEABLE");
  });
});
