/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { createHash } from "node:crypto";
import {
  CANONICAL_DIGEST_PREFIX,
  canonicalJson,
  type LegacyDigestForm,
  legacyJson,
} from "./canonical-hash.js";

/**
 * Synchronous `node:crypto` twin of `canonical-hash.ts` for Node-only call
 * sites that cannot await. Same serializer, same `sha256:<hex>` output.
 */
export function sha256DigestSync(text: string): string {
  return `${CANONICAL_DIGEST_PREFIX}${sha256HexSync(text)}`;
}

/** Bare lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
export function sha256HexSync(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function canonicalDigestSync(value: unknown): string {
  return sha256DigestSync(canonicalJson(value));
}

/** Pre-0.7.0 digest of `value`. Only for reading old digests. */
export function legacyDigestSync(
  value: unknown,
  form: LegacyDigestForm,
): string {
  return sha256DigestSync(legacyJson(value, form));
}
