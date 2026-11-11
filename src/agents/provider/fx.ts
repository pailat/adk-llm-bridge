import type { ExternalAgentProviderDefinition } from "./schema.js";

/**
 * Environment variables the fx CLI may read for auth.
 *
 * @remarks
 * Only these variables are forwarded from the credential, so unrelated
 * secrets never reach the fx process. `HOME` is a base key of the driver, so
 * credentials saved by `fx login` in `~/.fx` still work.
 */
export const FX_ENV_ALLOWLIST = [
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
] as const;

/** Provider definition for the fx coding agent. */
export const FX_PROVIDER: ExternalAgentProviderDefinition = {
  id: "fx",
  name: "fx",
  command: "fx",
  envAllowlist: FX_ENV_ALLOWLIST,
};
