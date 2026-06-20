/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

export type ExternalAgentPermissionMode = "read-only" | "ask" | "workspace-write" | "full-access";

export interface ExternalAgentPermissionPolicy {
  mode: ExternalAgentPermissionMode;
  allowNetwork?: boolean;
  allowedPaths?: readonly string[];
}

export interface ProviderPermissionFlags {
  readOnly?: boolean;
  requireApproval?: boolean;
  workspaceWrite?: boolean;
  fullAccess?: boolean;
  network?: boolean;
  paths?: readonly string[];
}
