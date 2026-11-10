import { describe, expect, test } from "bun:test";
import { InputValidationError } from "@google/adk";
import {
  CODEX_PROVIDER,
  deriveSubAgentPermissionPolicy,
  ExternalAgent,
  mapPermissionModeToPolicy,
} from "../../src/agents/index.js";
import { mapPermissionPolicyToFlags } from "../../src/agents/permissions/mapper.js";

describe("permission mapping", () => {
  test("maps read-only policy to provider flags", () => {
    expect(
      mapPermissionPolicyToFlags({
        mode: "read-only",
        allowedPaths: ["/tmp/project"],
      }),
    ).toEqual({
      readOnly: true,
      requireApproval: false,
      network: false,
      paths: ["/tmp/project"],
    });
  });

  test("maps ask policy to approval flags", () => {
    expect(
      mapPermissionPolicyToFlags({ mode: "ask", allowNetwork: false }),
    ).toEqual({
      requireApproval: true,
      network: false,
      paths: undefined,
    });
  });

  test("creates policy from mode", () => {
    expect(mapPermissionModeToPolicy("workspace-write")).toEqual({
      mode: "workspace-write",
    });
  });
});

describe("deriveSubAgentPermissionPolicy", () => {
  test("does not let child permissions exceed parent mode", () => {
    expect(
      deriveSubAgentPermissionPolicy(
        { mode: "read-only" },
        { mode: "full-access", allowNetwork: true },
      ),
    ).toEqual({ mode: "read-only", allowNetwork: false });

    expect(
      deriveSubAgentPermissionPolicy(
        { mode: "workspace-write" },
        { mode: "full-access" },
      ),
    ).toEqual({ mode: "workspace-write", allowNetwork: false });
  });

  test("does not expand allowed paths", () => {
    expect(
      deriveSubAgentPermissionPolicy(
        { mode: "workspace-write", allowedPaths: ["/repo", "/tmp"] },
        { mode: "workspace-write", allowedPaths: ["/repo", "/etc"] },
      ),
    ).toEqual({
      mode: "workspace-write",
      allowNetwork: false,
      allowedPaths: ["/repo"],
      pathBounds: [
        ["/repo", "/tmp"],
        ["/repo", "/etc"],
      ],
    });
  });
});

describe("permission policy validation", () => {
  test("ExternalAgent rejects a malformed policy at construction", () => {
    for (const permissions of [
      { mode: "fullaccess" },
      { mode: "ask", allowNetwork: "yes" },
      { mode: "ask", allowedPaths: "src" },
      { mode: "ask", allowedPaths: [1] },
      "read-only",
      null,
    ]) {
      expect(
        () =>
          new ExternalAgent({
            name: "worker",
            provider: CODEX_PROVIDER,
            permissions: permissions as never,
          }),
      ).toThrow(InputValidationError);
    }
  });

  test("ExternalAgent accepts a well-formed policy or none", () => {
    expect(
      () =>
        new ExternalAgent({
          name: "worker",
          provider: CODEX_PROVIDER,
          permissions: {
            mode: "workspace-write",
            allowNetwork: false,
            allowedPaths: ["/repo"],
          },
        }),
    ).not.toThrow();
    expect(
      () => new ExternalAgent({ name: "worker", provider: CODEX_PROVIDER }),
    ).not.toThrow();
  });

  test("an unknown mode maps to the read-only flags", () => {
    expect(mapPermissionPolicyToFlags({ mode: "admin" } as never)).toEqual({
      readOnly: true,
      requireApproval: false,
      network: false,
      paths: undefined,
    });
  });
});

describe("the agent keeps a frozen copy of its permissions", () => {
  test("changing the config after construction does not change the agent", () => {
    const permissions: {
      mode: "read-only" | "full-access";
      allowedPaths: string[];
    } = { mode: "read-only", allowedPaths: ["/repo"] };
    const agent = new ExternalAgent({
      name: "worker",
      provider: CODEX_PROVIDER,
      permissions,
    });
    permissions.mode = "full-access";
    permissions.allowedPaths.push("/");

    expect(agent.permissions).toEqual({
      mode: "read-only",
      allowedPaths: ["/repo"],
    });
    expect(Object.isFrozen(agent.permissions)).toBe(true);
    expect(Object.isFrozen(agent.permissions?.allowedPaths)).toBe(true);
  });

  test("a policy whose mode changes after the check keeps the checked mode", () => {
    let reads = 0;
    const permissions = {
      get mode() {
        reads += 1;
        return reads === 1 ? "read-only" : "full-access";
      },
    } as unknown as { mode: "read-only" };
    const agent = new ExternalAgent({
      name: "worker",
      provider: CODEX_PROVIDER,
      permissions,
    });

    expect(agent.permissions?.mode).toBe("read-only");
    expect(agent.permissions?.mode).toBe("read-only");
  });
});
