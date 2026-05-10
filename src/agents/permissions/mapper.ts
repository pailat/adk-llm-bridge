/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type {
  ExternalAgentPermissionMode,
  ExternalAgentPermissionPolicy,
  ProviderPermissionFlags,
} from "./schema.js";

export function mapPermissionPolicyToFlags(
  policy: ExternalAgentPermissionPolicy,
): ProviderPermissionFlags {
  const common = {
    network: policy.allowNetwork,
    paths: policy.allowedPaths,
  };

  switch (policy.mode) {
    case "read-only":
      return { ...common, readOnly: true, requireApproval: false };
    case "ask":
      return { ...common, requireApproval: true };
    case "workspace-write":
      return { ...common, workspaceWrite: true, requireApproval: false };
    case "full-access":
      return { ...common, fullAccess: true, requireApproval: false };
  }
}

export function mapPermissionModeToPolicy(
  mode: ExternalAgentPermissionMode,
): ExternalAgentPermissionPolicy {
  return { mode };
}
