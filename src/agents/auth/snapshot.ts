/**
 * Internal credential snapshot used by `ExternalAgent`. Not part of the
 * public API: do not re-export from any barrel.
 */

import type { ExternalAgentCredential } from "./schema.js";

/** A credential read once: a frozen copy, or the reason it was refused. */
export type CredentialSnapshot =
  | { readonly credential: ExternalAgentCredential | undefined }
  | { readonly unsupportedKind: string };

/**
 * Reads a credential provider's result once and copies it.
 *
 * @remarks
 * Each field is read once, so a getter cannot pass the check with one kind
 * and hand the driver another. `undefined` and `null` mean no credential.
 * Only `"env"` and `"none"` are supported; any other kind (a value that is
 * not an object has none), or an `env` that is not an object, is refused.
 * Non-string `env` values are dropped. The copy and its `env` are frozen.
 *
 * @param value - What `getCredential` resolved to.
 * @returns The frozen copy, or the kind that was refused (as text).
 */
export function snapshotCredential(value: unknown): CredentialSnapshot {
  if (value === undefined || value === null) return { credential: undefined };
  // A string, number or array has no `kind`, so the check below refuses it.
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== "env" && kind !== "none") {
    return { unsupportedKind: describe(kind) };
  }
  const record = value as Record<string, unknown>;
  const label = record.label;
  const env = kind === "env" ? record.env : undefined;
  let envCopy: Readonly<Record<string, string>> | undefined;
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      return { unsupportedKind: `${kind} with a malformed env` };
    }
    const entries = Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    envCopy = Object.freeze(Object.fromEntries(entries));
  }
  return {
    credential: Object.freeze({
      kind,
      ...(typeof label === "string" ? { label } : {}),
      ...(envCopy ? { env: envCopy } : {}),
    }),
  };
}

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
