/**
 * How a credential reaches the runtime.
 *
 * @remarks
 * `"env"` passes the allow-listed variables in `env` to the runtime.
 * `"none"` passes nothing, so the runtime uses its own login state, the same
 * as returning `undefined`. Any other kind stops the run with
 * `EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED`, because no driver could deliver it.
 */
export type ExternalAgentAuthKind = "none" | "env";

/** A credential resolved for one external runtime. */
export interface ExternalAgentCredential {
  /** How the credential reaches the runtime. */
  kind: ExternalAgentAuthKind;
  /** Redacted identifier for diagnostics; never store raw secrets here. */
  label?: string;
  /** Environment variables to pass to the runtime when `kind` is `"env"`. */
  env?: Record<string, string>;
}

/** What a credential provider is asked to resolve. */
export interface CredentialRequest {
  /** Id of the provider the credential is for, for example `"codex"`. */
  providerId: string;
  /** Environment variables the provider is allowed to read. */
  envAllowlist?: readonly string[];
}
