/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  mapPermissionModeToPolicy,
  mapPermissionPolicyToFlags,
} from "../../src/agents";

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
