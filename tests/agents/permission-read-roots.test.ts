import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  guardPermissionRequest,
  guardRequestPaths,
} from "../../src/agents/permissions/confirmation.js";
import { deriveSubAgentPermissionPolicy } from "../../src/agents/permissions/inheritance.js";
import type { ExternalAgentPermissionPolicy } from "../../src/agents/permissions/schema.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A repo with a writable `out` directory and a `src` directory to read. */
function repo(): { root: string; out: string; src: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "guard-read-roots-")));
  dirs.push(root);
  const out = join(root, "out");
  const src = join(root, "src");
  mkdirSync(out, { recursive: true });
  mkdirSync(src, { recursive: true });
  return { root, out, src };
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
  ["Read", (dir) => ({ file_path: join(dir, "a.ts") })],
  ["Glob", (dir) => ({ pattern: "**/*.ts", path: dir })],
  ["Grep", (dir) => ({ pattern: "needle", path: dir })],
  ["read_file", (dir) => ({ absolute_path: join(dir, "a.ts") })],
  ["read_many_files", (dir) => ({ paths: [join(dir, "a.ts")] })],
];

describe("allowedPaths is one list for reads and writes", () => {
  for (const mode of ["workspace-write", "ask", "read-only"] as const) {
    for (const [tool, input] of READS) {
      test(`${mode}: ${tool} outside allowedPaths is denied, inside is not`, () => {
        const { out, src } = repo();
        const policy: ExternalAgentPermissionPolicy = {
          mode,
          allowedPaths: [out],
        };

        expect(guard(policy, tool, input(src), out)?.behavior).toBe("deny");
        // Inside the root the path rule has nothing to say. Only the mode
        // decides: a read-only policy denies every permission request with
        // its own message (reads still run, because the runtime approves
        // them and only the path hook sees them).
        expect(
          guardRequestPaths(
            policy,
            { toolName: tool, input: input(out) },
            { workingDirectory: out },
          ),
        ).toBeUndefined();
        const inside = guard(policy, tool, input(out), out);
        if (mode === "read-only") {
          expect(inside?.behavior).toBe("deny");
          expect(inside && "message" in inside ? inside.message : "").toMatch(
            /read-only policy/,
          );
        } else {
          expect(inside).toBeUndefined();
        }
      });
    }
  }

  test("the denial of a read says the path is outside the allowed paths", () => {
    const { out, src } = repo();
    const decision = guard(
      { mode: "workspace-write", allowedPaths: [out] },
      "Read",
      { file_path: join(src, "a.ts") },
      out,
    );

    expect(decision?.behavior).toBe("deny");
    expect(decision && "message" in decision ? decision.message : "").toMatch(
      /outside the paths allowed/i,
    );
  });
});

describe("the supported way to read wider than you write", () => {
  test("a writer whose roots cover both can read and write both (no split)", () => {
    const { root, out, src } = repo();
    const writer: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [root],
    };

    expect(
      guard(writer, "Read", { file_path: join(src, "a.ts") }, out),
    ).toBeUndefined();
    // The guard cannot keep this agent out of `src` when it writes.
    expect(
      guard(writer, "Write", { file_path: join(src, "a.ts") }, out),
    ).toBeUndefined();
  });

  test("a separate read-only agent with wide roots reads but never writes", () => {
    const { root, out, src } = repo();
    const reader: ExternalAgentPermissionPolicy = {
      mode: "read-only",
      allowedPaths: [root],
    };
    const writer: ExternalAgentPermissionPolicy = {
      mode: "workspace-write",
      allowedPaths: [out],
    };

    // The reader's path rule passes on `src` for every read tool (the check
    // the Claude SDK driver's PreToolUse hook runs for auto-approved reads).
    for (const [tool, input] of READS) {
      expect(
        guardRequestPaths(
          reader,
          { toolName: tool, input: input(src) },
          { workingDirectory: out },
        ),
      ).toBeUndefined();
    }
    // Read-only mode denies the write tools, not the path rule.
    expect(
      guard(reader, "Write", { file_path: join(out, "a.ts") }, out),
    ).toEqual(expect.objectContaining({ behavior: "deny" }));
    // The writer, confined to `out`, cannot read `src` itself, so what it
    // needs from `src` has to reach it as input from the reader step.
    expect(
      guard(writer, "Read", { file_path: join(src, "a.ts") }, out),
    ).toEqual(expect.objectContaining({ behavior: "deny" }));
    expect(
      guard(writer, "Write", { file_path: join(out, "a.ts") }, out),
    ).toBeUndefined();
  });

  test("a delegated agent cannot be given roots wider than its parent's", () => {
    const { root, out } = repo();
    const derived = deriveSubAgentPermissionPolicy(
      { mode: "workspace-write", allowedPaths: [out] },
      { mode: "workspace-write", allowedPaths: [root] },
    );

    expect(derived.allowedPaths).toEqual([out]);
  });
});
