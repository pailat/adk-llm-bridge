/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

export type ExternalAgentAuthKind = "none" | "env" | "custom";

export interface ExternalAgentCredential {
  kind: ExternalAgentAuthKind;
  /** Redacted identifier for diagnostics; never store raw secrets here. */
  label?: string;
  env?: Record<string, string>;
}

export interface CredentialRequest {
  providerId: string;
  envAllowlist?: readonly string[];
}
