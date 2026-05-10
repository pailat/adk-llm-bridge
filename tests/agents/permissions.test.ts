/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  deriveSubAgentPermissionPolicy,
  mapPermissionModeToPolicy,
  mapPermissionPolicyToFlags,
} from "../../src/agents/index.js";

describe("permission mapping", () => {
  test("maps read-only policy to provider flags", () => {
    expect(
      mapPermissionPolicyToFlags({ mode: "read-only", allowedPaths: ["/tmp/project"] }),
    ).toEqual({
      readOnly: true,
      requireApproval: false,
      network: undefined,
      paths: ["/tmp/project"],
    });
  });

  test("maps ask policy to approval flags", () => {
    expect(mapPermissionPolicyToFlags({ mode: "ask", allowNetwork: false })).toEqual({
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
    });
  });
});
