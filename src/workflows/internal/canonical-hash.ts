/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * The single canonical JSON form and `sha256:` digest used by workflows.
 *
 * Canonical form: `JSON.stringify` semantics (`toJSON`, boxed primitives,
 * `undefined`/functions/symbols dropped from objects and written as `null` in
 * arrays, non-finite numbers written as `null`, BigInt and cycles rejected),
 * with the keys of every object sorted by UTF-16 code unit (the default
 * `Array.prototype.sort` order). Integer-like keys follow the same rule, so
 * `{"10":1,"9":2}` serializes as `{"10":1,"9":2}`. A top-level value that JSON
 * cannot represent (`undefined`, a function or a symbol) serializes as the
 * bare marker `undefined`, as the checkpoint hash always did.
 *
 * This module only needs `crypto.subtle`, so it runs in the Node-free core
 * under Bun, Node 22+ and browsers. Node-only synchronous call sites use
 * `canonical-hash-node.ts`, which shares the serializer below.
 *
 * Legacy forms (read-only compatibility, see `resolveStoredDigest`):
 * - "locale" — keys sorted with `localeCompare` (checkpoint input/source
 *   hashes, checkpoint revisions, external agent revisions before 0.7.0);
 * - "insertion" — plain `JSON.stringify` in property order (artifact digests,
 *   change set digests and git worktree directory suffixes before 0.7.0).
 * New digests are always canonical. Remove the legacy forms once stored
 * pre-0.7.0 checkpoints, artifacts and change sets no longer need to load
 * (planned: the first release after 0.8.0).
 */

export const CANONICAL_DIGEST_PREFIX = "sha256:";

/** Pre-0.7.0 serializations that stored digests may still use. */
export type LegacyDigestForm = "locale" | "insertion";

/** Serializes `value` in the canonical form described in this module. */
export function canonicalJson(value: unknown): string {
  return writeValue("", value, []) ?? "undefined";
}

/** Serializes `value` in a pre-0.7.0 form. Only for reading old digests. */
export function legacyJson(value: unknown, form: LegacyDigestForm): string {
  if (form === "insertion") return JSON.stringify(value) ?? "undefined";
  return (
    JSON.stringify(value, (_key, current) => {
      if (current && typeof current === "object" && !Array.isArray(current)) {
        return Object.fromEntries(
          Object.entries(current).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        );
      }
      return current;
    }) ?? "undefined"
  );
}

/** `sha256:<hex>` of the UTF-8 bytes of `text`. */
export async function sha256Digest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return `${CANONICAL_DIGEST_PREFIX}${toHex(new Uint8Array(digest))}`;
}

/** Canonical `sha256:` digest of `value`. */
export function canonicalDigest(value: unknown): Promise<string> {
  return sha256Digest(canonicalJson(value));
}

/** Pre-0.7.0 `sha256:` digest of `value`. Only for reading old digests. */
export function legacyDigest(
  value: unknown,
  form: LegacyDigestForm,
): Promise<string> {
  return sha256Digest(legacyJson(value, form));
}

/**
 * Picks the digest to keep for a value that may already be stored.
 *
 * Returns `stored` when it is the legacy digest of the same value (so stored
 * checkpoints and the idempotency keys derived from them stay stable), and
 * `current` otherwise. The legacy digest is only computed on a mismatch.
 */
export async function resolveStoredDigest(
  stored: string | undefined,
  current: string,
  legacy: () => string | Promise<string>,
): Promise<string> {
  if (stored === undefined || stored === current) return current;
  return stored === (await legacy()) ? stored : current;
}

const MAX_LEGACY_ALIASES = 4096;
const legacyAliases = new Map<string, string>();

/**
 * Records that `legacy` is the pre-0.7.0 digest of the value whose canonical
 * digest is `current`, for opaque digests (such as agent revisions) that are
 * compared later without access to the value. Process-local and bounded.
 */
export function rememberLegacyDigest(current: string, legacy: string): void {
  if (current === legacy) return;
  legacyAliases.delete(current);
  legacyAliases.set(current, legacy);
  if (legacyAliases.size > MAX_LEGACY_ALIASES) {
    const oldest = legacyAliases.keys().next().value;
    if (oldest !== undefined) legacyAliases.delete(oldest);
  }
}

/** True when `stored` is the remembered legacy digest of `current`. */
export function isRememberedLegacyDigest(
  stored: string,
  current: string,
): boolean {
  return legacyAliases.get(current) === stored;
}

/** Writes one value; `undefined` means "omit" (JSON.stringify semantics). */
function writeValue(
  key: string,
  input: unknown,
  stack: object[],
): string | undefined {
  let value = input;
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "bigint") &&
    typeof (value as { toJSON?: unknown }).toJSON === "function"
  ) {
    value = (value as { toJSON(key: string): unknown }).toJSON.call(value, key);
  }
  if (value instanceof Number) value = Number(value);
  else if (value instanceof String) value = String(value);
  else if (value instanceof Boolean) value = value.valueOf();

  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "string":
      return JSON.stringify(value);
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    case "object":
      break;
    default:
      return undefined;
  }

  const object = value as object;
  if (stack.includes(object)) {
    throw new TypeError("Converting circular structure to JSON");
  }
  stack.push(object);
  try {
    if (Array.isArray(object)) {
      const items: string[] = [];
      for (let index = 0; index < object.length; index++) {
        items.push(writeValue(String(index), object[index], stack) ?? "null");
      }
      return `[${items.join(",")}]`;
    }
    const record = object as Record<string, unknown>;
    const members: string[] = [];
    for (const name of Object.keys(record).sort()) {
      const written = writeValue(name, record[name], stack);
      if (written !== undefined) {
        members.push(`${JSON.stringify(name)}:${written}`);
      }
    }
    return `{${members.join(",")}}`;
  } finally {
    stack.pop();
  }
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
