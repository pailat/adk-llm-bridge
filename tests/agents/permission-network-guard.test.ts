import { describe, expect, test } from "bun:test";
import {
  guardPermissionRequest,
  type PermissionRequest,
} from "../../src/agents/permissions/confirmation.js";
import type { ExternalAgentPermissionPolicy } from "../../src/agents/permissions/schema.js";

const NO_NETWORK: ExternalAgentPermissionPolicy = {
  mode: "ask",
  allowNetwork: false,
};

function req(
  toolName: string,
  input: Record<string, unknown> = {},
  extra: Partial<PermissionRequest> = {},
): PermissionRequest {
  return { requestId: "r", toolName, input, ...extra };
}

describe("guardPermissionRequest under allowNetwork: false", () => {
  test("denies MCP tools of other servers", () => {
    expect(
      guardPermissionRequest(NO_NETWORK, req("mcp__github__create_issue")),
    ).toMatchObject({ behavior: "deny" });
  });

  test("lets the bridge's own MCP tools through", () => {
    expect(
      guardPermissionRequest(NO_NETWORK, req("mcp__adk_bridge__lookup")),
    ).toBeUndefined();
  });

  test("denies shell tools of every runtime without a network sandbox", () => {
    for (const name of [
      "Bash",
      "PowerShell",
      "shell",
      "exec_command",
      "run_shell_command",
    ]) {
      expect(
        guardPermissionRequest(NO_NETWORK, req(name, { command: "ls" })),
      ).toMatchObject({ behavior: "deny" });
    }
  });

  test("lets a sandboxed or explicitly waived shell call through", () => {
    for (const networkSandbox of ["enforced", "waived"] as const) {
      expect(
        guardPermissionRequest(
          NO_NETWORK,
          req("Bash", { command: "ls" }, { networkSandbox }),
        ),
      ).toBeUndefined();
    }
  });

  test("denies the web tools of every runtime", () => {
    for (const name of ["WebFetch", "web_fetch", "google_web_search"]) {
      expect(guardPermissionRequest(NO_NETWORK, req(name))).toMatchObject({
        behavior: "deny",
      });
    }
  });

  test("allowNetwork: true does not restrict shell or MCP tools", () => {
    const policy = { mode: "ask" as const, allowNetwork: true };
    expect(guardPermissionRequest(policy, req("Bash"))).toBeUndefined();
    expect(guardPermissionRequest(policy, req("mcp__x__y"))).toBeUndefined();
  });

  test("allowNetwork unset restricts shell and MCP tools as false does", () => {
    for (const policy of [{ mode: "ask" as const }, undefined]) {
      expect(guardPermissionRequest(policy, req("Bash"))?.behavior).toBe(
        "deny",
      );
      expect(guardPermissionRequest(policy, req("mcp__x__y"))?.behavior).toBe(
        "deny",
      );
    }
  });
});

describe("guardPermissionRequest path checks for any runtime", () => {
  const policy: ExternalAgentPermissionPolicy = {
    mode: "ask",
    allowedPaths: ["/repo"],
  };
  const options = { workingDirectory: "/repo" };

  test("reads Gemini file tool keys", () => {
    expect(
      guardPermissionRequest(
        policy,
        req("read_file", { absolute_path: "/etc/passwd" }),
        options,
      ),
    ).toMatchObject({ behavior: "deny" });
    expect(
      guardPermissionRequest(
        policy,
        req("read_many_files", { paths: ["src/a.ts", "/etc/hosts"] }),
        options,
      ),
    ).toMatchObject({ behavior: "deny" });
  });

  test("reads Codex file changes and the working directory", () => {
    expect(
      guardPermissionRequest(
        policy,
        req("file_change", { changes: [{ path: "/etc/evil", kind: "add" }] }),
        options,
      ),
    ).toMatchObject({ behavior: "deny" });
    expect(
      guardPermissionRequest(
        policy,
        req("exec_command", { command: "ls", workdir: "/tmp" }),
        options,
      ),
    ).toMatchObject({ behavior: "deny" });
  });

  test("reads the file headers of an apply_patch body", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Add File: /etc/cron.d/evil",
      "*** End Patch",
    ].join("\n");
    expect(
      guardPermissionRequest(policy, req("apply_patch", { patch }), options),
    ).toMatchObject({ behavior: "deny" });
  });

  test("allows paths inside the allowed roots, whatever the tool name", () => {
    expect(
      guardPermissionRequest(
        policy,
        req("some_new_tool", { file_path: "src/a.ts", dir_path: "/repo/lib" }),
        options,
      ),
    ).toBeUndefined();
  });

  test("still checks the Claude Code tools", () => {
    expect(
      guardPermissionRequest(
        policy,
        req("Write", { file_path: "/etc/evil" }),
        options,
      ),
    ).toMatchObject({ behavior: "deny" });
  });
});

describe("guardPermissionRequest checks escaping globs", () => {
  const policy: ExternalAgentPermissionPolicy = {
    mode: "workspace-write",
    allowedPaths: ["/repo"],
  };
  const options = { workingDirectory: "/repo" };
  const check = (toolName: string, input: Record<string, unknown>) =>
    guardPermissionRequest(policy, req(toolName, input), options);

  test("Claude Glob with an absolute pattern outside the roots is denied", () => {
    expect(check("Glob", { pattern: "/etc/**" })).toMatchObject({
      behavior: "deny",
    });
    expect(check("Glob", { pattern: "~/.ssh/*" })).toMatchObject({
      behavior: "deny",
    });
    expect(check("Glob", { pattern: "../other/**/*.ts" })).toMatchObject({
      behavior: "deny",
    });
  });

  test("a glob whose static part is a root prefix, not a root, is denied", () => {
    // `/repo*` also matches `/repo2`.
    expect(check("Glob", { pattern: "/repo*/secrets" })).toMatchObject({
      behavior: "deny",
    });
  });

  test("a .. after a wildcard climbs out and is denied", () => {
    expect(check("Glob", { pattern: "/repo/*/../../etc/*" })).toMatchObject({
      behavior: "deny",
    });
    expect(check("Glob", { pattern: "src/*/../../../x" })).toMatchObject({
      behavior: "deny",
    });
  });

  test("globs inside the roots and relative globs pass", () => {
    expect(check("Glob", { pattern: "/repo/src/**/*.ts" })).toBeUndefined();
    expect(check("Glob", { pattern: "**/*.ts" })).toBeUndefined();
    expect(check("Glob", { pattern: "src/*/../lib/*.ts" })).toBeUndefined();
  });

  test("Claude Grep checks its glob, not its regex pattern", () => {
    expect(check("Grep", { pattern: "/api/v1", glob: "*.ts" })).toBeUndefined();
    expect(
      check("Grep", { pattern: "TODO", glob: "/etc/**/*.conf" }),
    ).toMatchObject({ behavior: "deny" });
  });

  test("Gemini glob and read_many_files are checked", () => {
    expect(check("glob", { pattern: "/etc/*.conf" })).toMatchObject({
      behavior: "deny",
    });
    expect(
      check("read_many_files", { include: ["src/**", "/etc/passwd"] }),
    ).toMatchObject({ behavior: "deny" });
    expect(
      check("read_many_files", { include: ["src/**", "docs/*.md"] }),
    ).toBeUndefined();
    expect(
      check("search_file_content", { pattern: "/x/", include: "*.ts" }),
    ).toBeUndefined();
  });
});

describe("guardPermissionRequest expands brace alternatives and uses the search root", () => {
  const policy: ExternalAgentPermissionPolicy = {
    mode: "workspace-write",
    allowedPaths: ["/repo"],
  };
  // A working directory below the root, as in a monorepo package.
  const options = { workingDirectory: "/repo/packages/x" };
  const check = (toolName: string, input: Record<string, unknown>) =>
    guardPermissionRequest(policy, req(toolName, input), options);

  test("an absolute path inside a brace group is denied (Claude Glob)", () => {
    expect(check("Glob", { pattern: "{/etc,src}/*" })).toMatchObject({
      behavior: "deny",
    });
  });

  test("an absolute path inside a brace group is denied (Gemini glob)", () => {
    expect(check("glob", { pattern: "{/etc,x}/passwd" })).toMatchObject({
      behavior: "deny",
    });
  });

  test("a .. inside a brace group is a climb", () => {
    expect(check("Glob", { path: "/repo", pattern: "{..,x}/*" })).toMatchObject(
      { behavior: "deny" },
    );
  });

  test("nested brace groups are expanded", () => {
    expect(check("Glob", { pattern: "{src/a,{lib,/etc}}/*" })).toMatchObject({
      behavior: "deny",
    });
    expect(
      check("Glob", { pattern: "{src,lib}/{a,{b,c}}/*.ts" }),
    ).toBeUndefined();
  });

  test("a pattern over the expansion cap is checked as /", () => {
    // 3^4 = 81 alternatives, all of them harmless.
    const pattern = "{a,b,c}{a,b,c}{a,b,c}{a,b,c}/*.ts";
    expect(check("Glob", { pattern })).toMatchObject({ behavior: "deny" });
    // 4^3 = 64 is still expanded and passes.
    expect(
      check("Glob", { pattern: "{a,b,c,d}{a,b,c,d}{a,b,c,d}/*.ts" }),
    ).toBeUndefined();
  });

  test("a relative climb is resolved against the call's path (Claude Glob)", () => {
    // Resolved against the working directory this would look inside /repo.
    expect(check("Glob", { path: "/repo", pattern: "../*" })).toMatchObject({
      behavior: "deny",
    });
    expect(
      check("Glob", { path: "/repo", pattern: "src/../*" }),
    ).toBeUndefined();
  });

  test("a relative climb is resolved against dir_path (Gemini glob)", () => {
    expect(
      check("glob", { dir_path: "/repo", pattern: "../secrets/*" }),
    ).toMatchObject({ behavior: "deny" });
  });

  test("Claude Grep's glob is resolved against its path", () => {
    expect(
      check("Grep", { pattern: "TODO", path: "/repo", glob: "../**/*.env" }),
    ).toMatchObject({ behavior: "deny" });
    expect(
      check("Grep", { pattern: "TODO", path: "/repo", glob: "**/*.ts" }),
    ).toBeUndefined();
  });

  test("without a search root a relative climb uses the working directory", () => {
    expect(check("Glob", { pattern: "../../*" })).toBeUndefined();
    expect(check("Glob", { pattern: "../../../*" })).toMatchObject({
      behavior: "deny",
    });
  });
});
