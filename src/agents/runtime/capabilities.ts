/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

export interface AgentRuntimeCapabilities {
  tools?: boolean;
  subagents?: boolean;
  mcpServers?: boolean;
  streaming?: boolean;
  sessions?: boolean;
  permissions?: boolean;
}
