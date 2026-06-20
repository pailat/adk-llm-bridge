/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

export interface AgentRuntimeRequestMetadata {
  agentName: string;
  rootAgentName: string;
  subAgentNames: readonly string[];
}
