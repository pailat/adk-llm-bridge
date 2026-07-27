/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { WorkflowError } from "../../../src/workflows/contracts.js";
import { QuickJSSyncGeneratorRuntime } from "../../../src/workflows/sandbox/quickjs-generator-runtime.js";

const releaseLoader = async (): Promise<QuickJSWASMModule> => {
  const variant = await import("@jitl/quickjs-wasmfile-release-sync");
  return newQuickJSWASMModuleFromVariant(variant.default);
};

const debugLoader = async (): Promise<QuickJSWASMModule> => {
  const variant = await import("@jitl/quickjs-wasmfile-debug-sync");
  return newQuickJSWASMModuleFromVariant(variant.default);
};

describe.each([
  ["release", releaseLoader],
  ["debug", debugLoader],
] as const)("QuickJSSyncGeneratorRuntime (%s)", (_variant, loader) => {
  test("runs generator turns through JSON and exposes only input", async () => {
    const runtime = new QuickJSSyncGeneratorRuntime({ loader });
    const session = await runtime.createSession({
      input: { value: 2 },
      source: `
        const resumed = yield { kind: "value", value: ctx.input.value };
        return { total: ctx.input.value + resumed.increment };
      `,
    });
    try {
      expect(session.next()).toEqual({
        done: false,
        value: { kind: "value", value: 2 },
      });
      expect(session.next({ increment: 3 })).toEqual({
        done: true,
        value: { total: 5 },
      });
    } finally {
      session.dispose();
    }
  });
});

describe("QuickJSSyncGeneratorRuntime limits", () => {
  test("loads QuickJS lazily", async () => {
    let calls = 0;
    const runtime = new QuickJSSyncGeneratorRuntime({
      loader: async () => {
        calls += 1;
        return releaseLoader();
      },
    });
    expect(calls).toBe(0);
    const session = await runtime.createSession({ source: "return 1;" });
    expect(calls).toBe(1);
    session.dispose();
  });

  test("reports an unavailable optional dependency", async () => {
    const runtime = new QuickJSSyncGeneratorRuntime({
      loader: async () => {
        throw new Error("module not found");
      },
    });
    await expect(
      runtime.createSession({ source: "return 1;" }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_SANDBOX_UNAVAILABLE",
    });
  });

  test("rejects invalid source and oversized source or messages", async () => {
    const runtime = new QuickJSSyncGeneratorRuntime({ loader: releaseLoader });
    await expect(
      runtime.createSession({ source: "if (" }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_SCRIPT_INVALID",
    });
    await expect(
      runtime.createSession({
        source: "return 1;",
        input: "too large",
        limits: { maxMessageBytes: 4 },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_LIMIT_EXCEEDED" });
    await expect(
      runtime.createSession({
        source: "return 'too large';",
        limits: { maxSourceBytes: 4 },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_LIMIT_EXCEEDED" });
  });

  test("interrupts infinite loops", async () => {
    const runtime = new QuickJSSyncGeneratorRuntime({ loader: releaseLoader });
    const session = await runtime.createSession({
      source: "while (true) {}",
      limits: { cpuTimeMs: 10 },
    });
    try {
      expect(() => session.next()).toThrow(WorkflowError);
      try {
        session.next();
      } catch (error) {
        expect(error).toMatchObject({ code: "WORKFLOW_LIMIT_EXCEEDED" });
      }
    } finally {
      session.dispose();
    }
  });

  test("enforces memory and stack bounds", async () => {
    const runtime = new QuickJSSyncGeneratorRuntime({ loader: releaseLoader });
    const memorySession = await runtime.createSession({
      source: `
        const values = [];
        while (true) values.push("x".repeat(16_384));
      `,
      limits: { memoryBytes: 4 * 1024 * 1024, cpuTimeMs: 2_000 },
    });
    try {
      expect(() => memorySession.next()).toThrow(WorkflowError);
    } finally {
      memorySession.dispose();
    }

    const stackSession = await runtime.createSession({
      source: "const recurse = () => recurse(); return recurse();",
      limits: { stackBytes: 64 * 1024 },
    });
    try {
      expect(() => stackSession.next()).toThrow(WorkflowError);
    } finally {
      stackSession.dispose();
    }
  });

  test("disposes handles, contexts, and runtimes idempotently", async () => {
    let disposed = 0;
    const runtime = new QuickJSSyncGeneratorRuntime({
      loader: releaseLoader,
      onDispose: () => {
        disposed += 1;
      },
    });
    const session = await runtime.createSession({ source: "return 1;" });
    session.dispose();
    session.dispose();
    expect(disposed).toBe(1);
    expect(session.disposed).toBe(true);
    expect(() => session.next()).toThrow("disposed");
  });
});
