/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Internal helpers shared by the external-agent drivers. Not part of the
 * public API: do not re-export from any barrel.
 */

import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExternalAgentRunRequest } from "../external-agent-driver.js";

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Returns the value only when it is a non-empty string. */
export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function removeUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

export function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export function readCredentialEnv(
  request: ExternalAgentRunRequest,
  key: string,
): string | undefined {
  return request.credential?.kind === "env"
    ? request.credential.env?.[key]
    : undefined;
}

export function copyIfPresent(
  source: Record<string, string | undefined>,
  target: Record<string, string | undefined>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "string" && value.length > 0) {
    target[key] = value;
  }
}

export function candidateBaseDirectories(workingDirectory?: string): string[] {
  const roots = new Set<string>();
  if (workingDirectory) {
    roots.add(resolve(workingDirectory));
  }
  roots.add(process.cwd());

  let current = dirname(fileURLToPath(import.meta.url));
  for (let index = 0; index < 8; index++) {
    roots.add(current);
    const next = dirname(current);
    if (next === current) {
      break;
    }
    current = next;
  }

  return [...roots].filter((item) => isAbsolute(item));
}
