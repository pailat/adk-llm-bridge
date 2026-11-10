import type { CredentialRequest, ExternalAgentCredential } from "./schema.js";

/**
 * Supplies the credential an external runtime authenticates with.
 *
 * @remarks
 * Implement this to fetch secrets from a vault or token service instead of
 * the process environment. See {@link EnvCredentialProvider} for the default.
 */
export interface ExternalAgentCredentialProvider {
  /**
   * Resolves the credential for one provider.
   *
   * @param request - The provider id and the environment variables it may use.
   * @returns The credential, or `undefined` when none is available and the
   * runtime should rely on its own login state.
   */
  getCredential(
    request: CredentialRequest,
  ): Promise<ExternalAgentCredential | undefined>;
}

/** A credential provider that never returns a credential. */
export class NoopCredentialProvider implements ExternalAgentCredentialProvider {
  /** @returns Always `undefined`. */
  async getCredential(): Promise<ExternalAgentCredential | undefined> {
    return undefined;
  }
}
