import { describe, expect, test } from "bun:test";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { WorkflowError } from "../../../src/workflows/contracts.js";
import { QuickJSSyncGeneratorRuntime } from "../../../src/workflows/sandbox/quickjs-generator-runtime.js";

const releaseLoader = (): Promise<QuickJSWASMModule> =>
  newQuickJSWASMModuleFromVariant(
    import("@jitl/quickjs-wasmfile-release-sync"),
  );

const debugLoader = (): Promise<QuickJSWASMModule> =>
  newQuickJSWASMModuleFromVariant(import("@jitl/quickjs-wasmfile-debug-sync"));

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

  test("rejects a loader result that is not a QuickJS module", async () => {
    for (const value of [null, {}, { newRuntime: "no" }]) {
      const runtime = new QuickJSSyncGeneratorRuntime({
        // A JavaScript caller can bypass the structural loader type.
        loader: async () => value as never,
      });
      await expect(
        runtime.createSession({ source: "return 1;" }),
      ).rejects.toMatchObject({
        code: "WORKFLOW_SANDBOX_UNAVAILABLE",
        message: "QuickJS module loader must resolve to a QuickJSWASMModule",
      });
    }
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
      limits: { cpuTimeMs: 250 },
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

  test("reports unbounded recursion as a limit error and survives disposal", async () => {
    const runtime = new QuickJSSyncGeneratorRuntime({ loader: releaseLoader });
    const session = await runtime.createSession({
      source: "function f() { return f() + 1; } return f();",
      limits: { cpuTimeMs: 300 },
    });
    let caught: unknown;
    try {
      session.next();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkflowError);
    expect(caught).toMatchObject({ code: "WORKFLOW_LIMIT_EXCEEDED" });
    // The wasm assertion raised while freeing the overflowed runtime must not
    // replace the limit error nor escape from dispose().
    expect(() => session.dispose()).not.toThrow();
    expect(session.disposed).toBe(true);

    const next = await runtime.createSession({ source: "return 'alive';" });
    try {
      expect(next.next()).toEqual({ done: true, value: "alive" });
    } finally {
      next.dispose();
    }
  });
});

describe("QuickJSSyncGeneratorRuntime setup budget", () => {
  // A source that starts with `}),` closes the generator factory, so the
  // expression after it runs while the session is set up, before any turn.
  // Only the setup CPU budget can stop it; without it this test never ends.
  test("interrupts guest code that runs at setup", async () => {
    const runtime = new QuickJSSyncGeneratorRuntime({ loader: releaseLoader });
    const outcome = await runtime
      .createSession({
        source: "}), (() => { for (;;) {} })(), (function* () {",
        limits: { cpuTimeMs: 200 },
      })
      .then(
        (session) => {
          session.dispose();
          return "created";
        },
        (error: unknown) => error,
      );
    expect(outcome).toBeInstanceOf(WorkflowError);
    expect(outcome).toMatchObject({ code: "WORKFLOW_LIMIT_EXCEEDED" });
  }, 4_000);
});
