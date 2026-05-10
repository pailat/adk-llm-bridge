/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { ExternalAgentProviderDefinition } from "./schema.js";

export const CODEX_ENV_ALLOWLIST = [
  "CODEX_API_KEY",
  "CODEX_HOME",
  "CODEX_CA_CERTIFICATE",
  "SSL_CERT_FILE",
] as const;

export const CODEX_PROVIDER: ExternalAgentProviderDefinition = {
  id: "codex",
  name: "Codex",
  command: "codex",
  envAllowlist: CODEX_ENV_ALLOWLIST,
};
