/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, spyOn, test } from "bun:test";
import { WorkflowError } from "../../src/workflows/contracts.js";
import {
  attachCause,
  attachCleanupErrors,
  isProcessAlive,
} from "../../src/workflows/internal/error-support.js";

describe("workflow internal error support", () => {
  test("isProcessAlive only reports dead on ESRCH", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    for (const [code, alive] of [
      ["ESRCH", false],
      ["EPERM", true],
      ["EINVAL", true],
    ] as const) {
      const spy = spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error(code), { code });
      });
      try {
        expect(isProcessAlive(4242)).toBe(alive);
      } finally {
        spy.mockRestore();
      }
    }
    const spy = spyOn(process, "kill").mockImplementation(() => {
      throw new Error("unknown");
    });
    try {
      expect(isProcessAlive(4242)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("attachCause keeps message, details and toJSON unchanged", () => {
    const original = new Error("secret host detail");
    const error = new WorkflowError("WORKFLOW_EXECUTION_ERROR", "failed", {
      a: 1,
    });
    const before = JSON.stringify(error);
    expect(attachCause(error, original)).toBe(error);
    expect((error as Error & { cause?: unknown }).cause).toBe(original);
    expect(Object.keys(error)).not.toContain("cause");
    expect(JSON.stringify(error)).toBe(before);
    expect(error.message).toBe("failed");
  });

  test("attachCleanupErrors keeps the primary error and ignores no-ops", () => {
    const primary = new Error("primary");
    const cleanup = new Error("release failed");
    attachCleanupErrors(primary, []);
    expect("cleanupErrors" in primary).toBe(false);
    attachCleanupErrors(primary, [cleanup]);
    expect(
      (primary as Error & { cleanupErrors?: unknown[] }).cleanupErrors,
    ).toEqual([cleanup]);
    expect(Object.keys(primary)).not.toContain("cleanupErrors");
    expect(() => attachCleanupErrors("not an error", [cleanup])).not.toThrow();
  });
});
