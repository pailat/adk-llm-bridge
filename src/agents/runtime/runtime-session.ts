/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

export interface AgentRuntimeSession {
  id: string;
  parentId?: string;
  rootAgentName?: string;
  metadata?: Record<string, unknown>;
}
