/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type {
  ExternalAgentPermissionMode,
  ExternalAgentPermissionPolicy,
} from "./schema.js";

const MODE_RANK: Record<ExternalAgentPermissionMode, number> = {
  "read-only": 0,
  ask: 1,
  "workspace-write": 2,
  "full-access": 3,
};

const MODES: readonly ExternalAgentPermissionMode[] = [
  "read-only",
  "ask",
  "workspace-write",
  "full-access",
];

export function deriveSubAgentPermissionPolicy(
  parent?: ExternalAgentPermissionPolicy,
  child?: ExternalAgentPermissionPolicy,
): ExternalAgentPermissionPolicy {
  const parentPolicy = parent ?? { mode: "ask" as const };
  const childPolicy = child ?? parentPolicy;
  const mode = moreRestrictiveMode(parentPolicy.mode, childPolicy.mode);
  const allowedPaths = deriveAllowedPaths(parentPolicy.allowedPaths, childPolicy.allowedPaths);

  return {
    mode,
    allowNetwork: Boolean(parentPolicy.allowNetwork && childPolicy.allowNetwork),
    ...(allowedPaths ? { allowedPaths } : {}),
  };
}

function moreRestrictiveMode(
  parent: ExternalAgentPermissionMode,
  child: ExternalAgentPermissionMode,
): ExternalAgentPermissionMode {
  return MODES[Math.min(MODE_RANK[parent], MODE_RANK[child])] ?? "read-only";
}

function deriveAllowedPaths(
  parent?: readonly string[],
  child?: readonly string[],
): readonly string[] | undefined {
  if (parent && child) {
    const parentSet = new Set(parent);
    return child.filter((path) => parentSet.has(path));
  }
  return parent ?? child;
}
