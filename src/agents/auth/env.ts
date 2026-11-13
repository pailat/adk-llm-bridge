import type { ExternalAgentCredentialProvider } from "./credential-provider.js";
import type { CredentialRequest, ExternalAgentCredential } from "./schema.js";

/** A readable view of environment variables, such as `process.env`. */
export type EnvSource = Record<string, string | undefined>;

/**
 * Copies the allow-listed, non-empty variables out of an environment.
 *
 * @remarks
 * Variables that are not in the allowlist are never copied, so unrelated
 * secrets in the host environment cannot reach an external runtime.
 *
 * @param env - Environment to read from.
 * @param allowlist - Names of the variables that may be read.
 * @returns The allowed variables that are set to a non-empty string.
 */
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

/** Resolves credentials from environment variables, limited to the provider's allowlist. */
export class EnvCredentialProvider implements ExternalAgentCredentialProvider {
  /** @param env - Environment to read; defaults to `process.env`. */
  constructor(private readonly env: EnvSource = process.env) {}

  /**
   * Reads the provider's allow-listed variables from the environment.
   *
   * @param request - The provider id and its environment allowlist.
   * @returns An `env` credential, or `undefined` when none of the allowed
   * variables is set.
   */
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
