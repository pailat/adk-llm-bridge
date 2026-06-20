/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { CredentialRequest, ExternalAgentCredential } from "./schema.js";
import type { ExternalAgentCredentialProvider } from "./credential-provider.js";

export type EnvSource = Record<string, string | undefined>;

export function readAllowedEnv(
  env: EnvSource,
  allowlist: readonly string[] = [],
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const key of allowlist) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      result[key] = value;
    }
  }

  return result;
}

export class EnvCredentialProvider implements ExternalAgentCredentialProvider {
  constructor(private readonly env: EnvSource = process.env) {}

  async getCredential(
    request: CredentialRequest,
  ): Promise<ExternalAgentCredential | undefined> {
    const env = readAllowedEnv(this.env, request.envAllowlist);
    if (Object.keys(env).length === 0) {
      return undefined;
    }

    return {
      kind: "env",
      label: `${request.providerId}:env`,
      env,
    };
  }
}
