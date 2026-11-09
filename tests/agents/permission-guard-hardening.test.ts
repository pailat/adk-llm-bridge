import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  guardPermissionRequest,
  type PermissionRequest,
} from "../../src/agents/permissions/confirmation.js";
import { canonicalPath } from "../../src/agents/permissions/paths.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A temp dir with an allowed `root/` and a sibling `outside/`. */
function layout(): { base: string; root: string; outside: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "guard-hardening-")));
  dirs.push(base);
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return { base, root, outside };
}

function write(path: string): PermissionRequest {
  return { requestId: "r", toolName: "Write", input: { file_path: path } };
}

describe.skipIf(process.platform === "win32")(
  "path guard with dangling symlinks",
  () => {
    test("canonicalPath follows a dangling link to where a write would land", () => {
      const { root, outside } = layout();
      symlinkSync(join(outside, "new.txt"), join(root, "link.txt"));
      expect(canonicalPath(join(root, "link.txt"), root)).toBe(
        join(outside, "new.txt"),
      );
    });

    test("a write through a dangling link that points outside the root is denied", () => {
      const { root, outside } = layout();
      symlinkSync(join(outside, "new.txt"), join(root, "link.txt"));
      expect(
        guardPermissionRequest(
          { mode: "workspace-write", allowedPaths: [root] },
          write(join(root, "link.txt")),
          { workingDirectory: root },
        ),
      ).toMatchObject({ behavior: "deny" });
    });

    test("a relative dangling link and a dangling link to a directory are followed", () => {
      const { root } = layout();
      symlinkSync("../outside/new.txt", join(root, "rel.txt"));
      symlinkSync("../outside/missing-dir", join(root, "dir"));
      for (const path of [join(root, "rel.txt"), join(root, "dir", "a.txt")]) {
        expect(
          guardPermissionRequest(
            { mode: "workspace-write", allowedPaths: [root] },
            write(path),
            { workingDirectory: root },
          ),
        ).toMatchObject({ behavior: "deny" });
      }
    });

    test("a dangling link that stays inside the root is allowed", () => {
      const { root } = layout();
      symlinkSync(join(root, "later.txt"), join(root, "link.txt"));
      expect(
        guardPermissionRequest(
          { mode: "workspace-write", allowedPaths: [root] },
          write(join(root, "link.txt")),
          { workingDirectory: root },
        ),
      ).toBeUndefined();
    });

    test("a symlink loop is denied", () => {
      const { root } = layout();
      symlinkSync(join(root, "b"), join(root, "a"));
      symlinkSync(join(root, "a"), join(root, "b"));
      expect(
        guardPermissionRequest(
          { mode: "workspace-write", allowedPaths: [root] },
          write(join(root, "a")),
          { workingDirectory: root },
        ),
      ).toMatchObject({ behavior: "deny" });
    });
  },
);

describe("read-only denial names the path when it is outside allowedPaths", () => {
  test("a read outside allowedPaths gets the path reason", () => {
    const decision = guardPermissionRequest(
      { mode: "read-only", allowedPaths: ["/repo"] },
      { requestId: "r", toolName: "Read", input: { file_path: "/etc/passwd" } },
      { workingDirectory: "/repo" },
    );
    expect(decision).toEqual({
      behavior: "deny",
      message:
        "Denied: /etc/passwd is outside the paths allowed by this agent's policy.",
    });
  });

  test("a read inside allowedPaths is still denied as read-only", () => {
    const decision = guardPermissionRequest(
      { mode: "read-only", allowedPaths: ["/repo"] },
      { requestId: "r", toolName: "Read", input: { file_path: "/repo/a.ts" } },
      { workingDirectory: "/repo" },
    );
    expect(decision).toMatchObject({
      behavior: "deny",
      message: expect.stringContaining("read-only"),
    });
  });

  test("read-only denies a request with no path", () => {
    expect(
      guardPermissionRequest(
        { mode: "read-only" },
        { requestId: "r", toolName: "TodoWrite", input: {} },
      ),
    ).toMatchObject({ behavior: "deny" });
  });
});

describe("bridge MCP exemption without network", () => {
  const policy = { mode: "ask" as const, allowNetwork: false };
  const request = (toolName: string): PermissionRequest => ({
    requestId: "r",
    toolName,
    input: {},
  });

  test("only names the caller registered as bridge tools are exempt", () => {
    const bridgeToolNames = new Set(["mcp__adk_bridge__adk_tool__lookup"]);
    expect(
      guardPermissionRequest(
        policy,
        request("mcp__adk_bridge__adk_tool__lookup"),
        { bridgeToolNames },
      ),
    ).toBeUndefined();
    for (const name of [
      "mcp__adk_bridge__x__exfiltrate",
      "mcp__adk_bridge__adk_tool__not_registered",
      "mcp__adk_bridge_evil__lookup",
    ]) {
      expect(
        guardPermissionRequest(policy, request(name), { bridgeToolNames }),
      ).toMatchObject({ behavior: "deny" });
    }
  });

  test("without registered bridge tools every MCP tool is denied", () => {
    expect(
      guardPermissionRequest(policy, request("mcp__adk_bridge__lookup")),
    ).toMatchObject({ behavior: "deny" });
  });
});

describe("shell network sandbox value", () => {
  test("a value other than enforced or waived counts as no sandbox", () => {
    expect(
      guardPermissionRequest(
        { mode: "ask" },
        {
          requestId: "r",
          toolName: "Bash",
          input: { command: "curl example.com" },
          networkSandbox: "partial" as unknown as "enforced",
        },
      ),
    ).toMatchObject({ behavior: "deny" });
  });
});
