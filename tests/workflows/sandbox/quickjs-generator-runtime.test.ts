import { describe, expect, spyOn, test } from "bun:test";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import {
  DEFAULT_WORKFLOW_EXECUTION_LIMITS,
  WorkflowError,
} from "../../../src/workflows/contracts.js";
import {
  QUICKJS_MAX_STACK_BYTES,
  QuickJSSyncGeneratorRuntime,
} from "../../../src/workflows/sandbox/quickjs-generator-runtime.js";
import {
  discardReleaseQuickJS,
  loadReleaseQuickJS,
} from "../../../src/workflows/sandbox/quickjs-loader.js";

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
      limits: { stackBytes: 16 * 1024 },
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

/**
 * Tests that run many forced overflows: about a second when idle, so the
 * default 5 s timeout is too tight on a busy machine.
 */
const slowTest = (name: string, run: () => Promise<void>) =>
  test(name, run, 30_000);

/**
 * Compares modules by identity. A failing `toEqual` on a wasm module makes the
 * test runner print its whole heap, which takes minutes; a boolean fails fast.
 */
function sameModules(
  actual: readonly (object | undefined)[],
  expected: readonly (object | undefined)[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((module, index) => module === expected[index])
  );
}

describe("QuickJSSyncGeneratorRuntime stack limit and the host stack", () => {
  const RECURSION = "function f() { return f() + 1; } return f();";
  /** Deep native recursion: QuickJS recurses in C, not in guest frames. */
  const JSON_NESTING =
    "let a = []; for (let i = 0; i < 300000; i += 1) a = [a]; return JSON.stringify(a);";

  /** Captures what the wasm module prints on its error channel. */
  async function captureWasmErrors<T>(
    run: () => Promise<T>,
  ): Promise<{ result: T; printed: string[] }> {
    const printed: string[] = [];
    const spy = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      },
    );
    try {
      return { result: await run(), printed };
    } finally {
      spy.mockRestore();
    }
  }

  /**
   * A module cache of the test's own, so a forced overflow never touches the
   * shared module and the module is created while the error channel is
   * captured (the wasm binds `console.error` when it loads).
   */
  function isolatedModules() {
    let cached: Promise<QuickJSWASMModule> | undefined;
    let current: QuickJSWASMModule | undefined;
    const loaded: QuickJSWASMModule[] = [];
    const discarded: object[] = [];
    return {
      loaded,
      discarded,
      loader: () => {
        cached ??= releaseLoader().then((module) => {
          current = module;
          loaded.push(module);
          return module;
        });
        return cached;
      },
      discardModule: (module: object) => {
        discarded.push(module);
        if (module === current) cached = undefined;
      },
    };
  }

  async function code(
    runtime: QuickJSSyncGeneratorRuntime,
    source: string,
    stackBytes?: number,
  ): Promise<unknown> {
    let session: Awaited<ReturnType<typeof runtime.createSession>>;
    try {
      session = await runtime.createSession({
        source,
        limits: { ...(stackBytes ? { stackBytes } : {}), cpuTimeMs: 2_000 },
      });
    } catch (error) {
      return (error as { code?: unknown }).code;
    }
    try {
      session.next();
      return "returned";
    } catch (error) {
      return (error as { code?: unknown }).code;
    } finally {
      session.dispose();
    }
  }

  test("the default stackBytes is within the maximum", () => {
    expect(DEFAULT_WORKFLOW_EXECUTION_LIMITS.stackBytes).toBeLessThanOrEqual(
      QUICKJS_MAX_STACK_BYTES,
    );
  });

  test("validateLimits refuses a stackBytes above the maximum without a session", () => {
    const runtime = new QuickJSSyncGeneratorRuntime({ loader: releaseLoader });

    expect(() => runtime.validateLimits(undefined)).not.toThrow();
    expect(() =>
      runtime.validateLimits({ stackBytes: QUICKJS_MAX_STACK_BYTES }),
    ).not.toThrow();
    expect(() =>
      runtime.validateLimits({ stackBytes: QUICKJS_MAX_STACK_BYTES + 1 }),
    ).toThrow(expect.objectContaining({ code: "WORKFLOW_DEFINITION_INVALID" }));
    expect(() => runtime.validateLimits({ cpuTimeMs: 0 })).toThrow(
      expect.objectContaining({ code: "WORKFLOW_DEFINITION_INVALID" }),
    );
  });

  test("stackBytes above the maximum is refused and names the maximum", async () => {
    const runtime = new QuickJSSyncGeneratorRuntime({ loader: releaseLoader });
    const error = await runtime
      .createSession({
        source: "return 1;",
        limits: { stackBytes: QUICKJS_MAX_STACK_BYTES + 1 },
      })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toMatchObject({
      code: "WORKFLOW_DEFINITION_INVALID",
      details: { name: "stackBytes", maxBytes: QUICKJS_MAX_STACK_BYTES },
    });
    expect((error as Error).message).toContain(String(QUICKJS_MAX_STACK_BYTES));
    const atMaximum = await runtime.createSession({
      source: "return 1;",
      limits: { stackBytes: QUICKJS_MAX_STACK_BYTES },
    });
    atMaximum.dispose();
  });

  slowTest(
    "deep recursion at the maximum ends in the limit error and frees cleanly",
    async () => {
      const runtime = new QuickJSSyncGeneratorRuntime();
      const { result, printed } = await captureWasmErrors(async () => {
        const codes: unknown[] = [];
        for (let attempt = 0; attempt < 15; attempt += 1) {
          codes.push(await code(runtime, RECURSION, QUICKJS_MAX_STACK_BYTES));
          codes.push(
            await code(runtime, JSON_NESTING, QUICKJS_MAX_STACK_BYTES),
          );
        }
        return codes;
      });

      expect(new Set(result)).toEqual(new Set(["WORKFLOW_LIMIT_EXCEEDED"]));
      expect(printed.filter((line) => line.includes("Aborted("))).toEqual([]);
      expect(await code(runtime, "return 1;")).toBe("returned");
    },
  );

  // The regression the maximum alone cannot cover (another host, a stack the
  // measurements did not see): a run that overflows the host stack leaks its
  // runtime in the module, and about fifteen of them left every later script
  // unable to start.
  describe("a host that overflows before QuickJS does", () => {
    const FORCED = 2 * 1024 * 1024;
    const PARSER_BOMB = `return eval(${JSON.stringify("(".repeat(5000))} + "1" + ${JSON.stringify(")".repeat(5000))});`;

    slowTest(
      "fifteen forced overflows leave the next script able to run",
      async () => {
        // The production wiring: the default loader and its cache. Start from
        // an empty cache so the module loads while the error channel is captured.
        discardReleaseQuickJS(await loadReleaseQuickJS());
        const runtime = new QuickJSSyncGeneratorRuntime({
          maxStackBytes: 4 * FORCED,
        });
        const { result } = await captureWasmErrors(async () => {
          const codes: unknown[] = [];
          for (let attempt = 0; attempt < 20; attempt += 1) {
            codes.push(await code(runtime, RECURSION, FORCED));
          }
          return codes;
        });

        expect(new Set(result)).toEqual(new Set(["WORKFLOW_LIMIT_EXCEEDED"]));
        const healthy = await runtime.createSession({
          source: "return [1, 2, 3].map((x) => x * 2).join();",
        });
        try {
          expect(healthy.next()).toEqual({ done: true, value: "2,4,6" });
        } finally {
          healthy.dispose();
        }
      },
    );

    test("the module that overflowed is discarded, the next session gets another", async () => {
      const modules = isolatedModules();
      const runtime = new QuickJSSyncGeneratorRuntime({
        loader: modules.loader,
        discardModule: modules.discardModule,
        maxStackBytes: 4 * FORCED,
      });
      await captureWasmErrors(async () => {
        await code(runtime, RECURSION, FORCED);
        expect(await code(runtime, "return 1;")).toBe("returned");
      });

      expect(sameModules(modules.discarded, [modules.loaded[0]])).toBe(true);
      expect(modules.loaded.length).toBe(2);
    });

    /**
     * The real module, except that the first call of `method` on a context
     * throws `error`, as the host does when its own stack overflows.
     */
    function faultyModule(
      real: QuickJSWASMModule,
      method: "callFunction" | "evalCode" | "newString" | "dump" | "getString",
      error: Error,
    ): QuickJSWASMModule {
      return new Proxy(real, {
        get(target, key) {
          if (key !== "newRuntime") return Reflect.get(target, key);
          return () => {
            const runtime = target.newRuntime();
            return new Proxy(runtime, {
              get(rt, rtKey) {
                const value = Reflect.get(rt, rtKey);
                if (rtKey !== "newContext") {
                  return typeof value === "function" ? value.bind(rt) : value;
                }
                return () => {
                  const context = rt.newContext();
                  let armed = true;
                  return new Proxy(context, {
                    get(ctx, ctxKey) {
                      const original = Reflect.get(ctx, ctxKey);
                      if (ctxKey !== method) {
                        return typeof original === "function"
                          ? original.bind(ctx)
                          : original;
                      }
                      return (...args: unknown[]) => {
                        // `evalCode` runs the set-up program first; a turn is
                        // the first `callFunction`.
                        if (armed) {
                          armed = false;
                          throw error;
                        }
                        return (original as (...a: unknown[]) => unknown).apply(
                          ctx,
                          args,
                        );
                      };
                    },
                  });
                };
              },
            });
          };
        },
      });
    }

    test.each([
      [
        "a host stack overflow during a turn",
        "callFunction",
        new RangeError("Maximum call stack size exceeded."),
        "return 1;",
      ],
      [
        "a wasm abort during a turn",
        "callFunction",
        new WebAssembly.RuntimeError("Aborted(test)"),
        "return 1;",
      ],
      [
        "a host stack overflow while the session is set up",
        "evalCode",
        new RangeError("Maximum call stack size exceeded."),
        "return 1;",
      ],
      [
        "a wasm abort while the session is set up",
        "evalCode",
        new WebAssembly.RuntimeError("Aborted(test)"),
        "return 1;",
      ],
      [
        "a host stack overflow while the turn message is created",
        "newString",
        new RangeError("Maximum call stack size exceeded."),
        "return 1;",
      ],
      [
        "a host stack overflow while the turn result is read",
        "getString",
        new RangeError("Maximum call stack size exceeded."),
        "return 1;",
      ],
      [
        "a host stack overflow while a turn's error is read",
        "dump",
        new RangeError("Maximum call stack size exceeded."),
        "throw new Error('x');",
      ],
      [
        "a host stack overflow while a set-up error is read",
        "dump",
        new RangeError("Maximum call stack size exceeded."),
        "const = ;",
      ],
    ] as const)(
      "%s ends in the limit error and discards the module",
      async (_name, method, error, source) => {
        const modules = isolatedModules();
        const real = await captureWasmErrors(modules.loader).then(
          ({ result }) => result,
        );
        const module = faultyModule(real, method, error);
        const runtime = new QuickJSSyncGeneratorRuntime({
          loader: async () => module,
          discardModule: modules.discardModule,
        });

        const { result } = await captureWasmErrors(() => code(runtime, source));
        expect(result).toBe("WORKFLOW_LIMIT_EXCEEDED");
        expect(sameModules(modules.discarded, [module])).toBe(true);
      },
    );

    /** The real module, except that freeing a runtime asserts afterwards. */
    function abortingDisposeModule(real: QuickJSWASMModule) {
      return new Proxy(real, {
        get(target, key) {
          if (key !== "newRuntime") return Reflect.get(target, key);
          return () =>
            new Proxy(target.newRuntime(), {
              get(rt, rtKey) {
                const value = Reflect.get(rt, rtKey);
                if (rtKey !== "dispose") {
                  return typeof value === "function" ? value.bind(rt) : value;
                }
                return () => {
                  (value as () => void).call(rt);
                  throw new Error("Aborted(Assertion failed: test)");
                };
              },
            });
        },
      });
    }

    test("a wasm assertion while the runtime is freed is contained and discards the module", async () => {
      const modules = isolatedModules();
      const real = await captureWasmErrors(modules.loader).then(
        ({ result }) => result,
      );
      const module = abortingDisposeModule(real);
      const runtime = new QuickJSSyncGeneratorRuntime({
        loader: async () => module,
        discardModule: modules.discardModule,
      });

      expect(await code(runtime, "return 1;")).toBe("returned");
      expect(sameModules(modules.discarded, [module])).toBe(true);
    });

    test("a wasm assertion while a failed set-up frees the runtime keeps the set-up error and discards the module", async () => {
      const modules = isolatedModules();
      const real = await captureWasmErrors(modules.loader).then(
        ({ result }) => result,
      );
      const module = abortingDisposeModule(real);
      const runtime = new QuickJSSyncGeneratorRuntime({
        loader: async () => module,
        discardModule: modules.discardModule,
      });

      expect(await code(runtime, "const = ;")).toBe("WORKFLOW_SCRIPT_INVALID");
      expect(sameModules(modules.discarded, [module])).toBe(true);
    });

    slowTest(
      "a deeply nested source given to eval ends in the limit error and leaves the sandbox usable",
      async () => {
        // The QuickJS parser recurses in native code, which `stackBytes` does not
        // bound: depending on the host this is QuickJS's own error or the host
        // stack. Both end the same way.
        const modules = isolatedModules();
        const runtime = new QuickJSSyncGeneratorRuntime({
          loader: modules.loader,
          discardModule: modules.discardModule,
        });
        const { result } = await captureWasmErrors(async () => {
          const codes: unknown[] = [];
          for (let attempt = 0; attempt < 8; attempt += 1) {
            codes.push(await code(runtime, PARSER_BOMB));
            codes.push(await code(runtime, "return 1;"));
          }
          return codes;
        });

        expect(new Set(result)).toEqual(
          new Set(["WORKFLOW_LIMIT_EXCEEDED", "returned"]),
        );
        expect(result.filter((entry) => entry === "returned")).toHaveLength(8);
      },
    );

    slowTest(
      "the parser bomb on a host stack that overflows first is contained and reported as the host stack",
      async () => {
        const modules = isolatedModules();
        const runtime = new QuickJSSyncGeneratorRuntime({
          loader: modules.loader,
          discardModule: modules.discardModule,
          maxStackBytes: 4 * FORCED,
        });
        const error = await captureWasmErrors(async () => {
          const session = await runtime.createSession({
            source: PARSER_BOMB,
            limits: { stackBytes: FORCED, cpuTimeMs: 2_000 },
          });
          try {
            session.next();
            return undefined;
          } catch (reason) {
            return reason;
          } finally {
            session.dispose();
          }
        }).then(({ result }) => result);

        expect(error).toMatchObject({ code: "WORKFLOW_LIMIT_EXCEEDED" });
        expect((error as Error).message).toContain("host stack was exhausted");
        expect(modules.discarded.length).toBe(1);
      },
    );

    test("a custom loader that keeps returning a poisoned module is refused", async () => {
      const modules = isolatedModules();
      const fixed = await captureWasmErrors(modules.loader).then(
        ({ result }) => result,
      );
      let loads = 0;
      const runtime = new QuickJSSyncGeneratorRuntime({
        loader: async () => {
          loads += 1;
          return fixed;
        },
        discardModule: () => {},
        maxStackBytes: 4 * FORCED,
      });
      await captureWasmErrors(async () => {
        expect(await code(runtime, RECURSION, FORCED)).toBe(
          "WORKFLOW_LIMIT_EXCEEDED",
        );
      });

      const refused = await runtime.createSession({ source: "return 1;" }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(refused).toMatchObject({ code: "WORKFLOW_SANDBOX_UNAVAILABLE" });
      expect((refused as Error).message).toContain("must return a new module");
      expect(loads).toBe(2);
    });

    slowTest(
      "a session on a module another session poisoned fails its next turn, and a new session gets a new module",
      async () => {
        const modules = isolatedModules();
        const runtime = new QuickJSSyncGeneratorRuntime({
          loader: modules.loader,
          discardModule: modules.discardModule,
          maxStackBytes: 4 * FORCED,
        });
        const outcome = await captureWasmErrors(async () => {
          const bystander = await runtime.createSession({
            source: "return 1;",
          });
          const culprit = await runtime.createSession({
            source: RECURSION,
            limits: { stackBytes: FORCED, cpuTimeMs: 2_000 },
          });
          let culpritCode: unknown;
          try {
            culprit.next();
          } catch (error) {
            culpritCode = (error as { code?: unknown }).code;
          }
          const turns: unknown[] = [];
          for (const session of [bystander, culprit]) {
            try {
              session.next();
              turns.push("returned");
            } catch (error) {
              turns.push((error as { code?: unknown }).code);
            }
          }
          bystander.dispose();
          culprit.dispose();
          const fresh = await runtime.createSession({ source: "return 2;" });
          try {
            return { culpritCode, turns, fresh: fresh.next() };
          } finally {
            fresh.dispose();
          }
        }).then(({ result }) => result);

        expect(outcome.culpritCode).toBe("WORKFLOW_LIMIT_EXCEEDED");
        // The bystander's turn and the poisoned session's own later turn.
        expect(outcome.turns).toEqual([
          "WORKFLOW_EXECUTION_ERROR",
          "WORKFLOW_EXECUTION_ERROR",
        ]);
        expect(outcome.fresh).toEqual({ done: true, value: 2 });
        expect(modules.loaded.length).toBe(2);
      },
    );

    test("a run that stays inside the limit does not discard the module", async () => {
      const discarded: object[] = [];
      const runtime = new QuickJSSyncGeneratorRuntime({
        discardModule: (module) => discarded.push(module),
      });
      expect(await code(runtime, RECURSION)).toBe("WORKFLOW_LIMIT_EXCEEDED");
      expect(await code(runtime, "return 1;")).toBe("returned");
      expect(discarded.length).toBe(0);
    });

    slowTest(
      "an overflow while the session is set up is a limit error and discards the module",
      async () => {
        const modules = isolatedModules();
        const runtime = new QuickJSSyncGeneratorRuntime({
          loader: modules.loader,
          discardModule: modules.discardModule,
          maxStackBytes: 4 * FORCED,
        });
        const { result } = await captureWasmErrors(async () => {
          const codes: unknown[] = [];
          for (let attempt = 0; attempt < 6; attempt += 1) {
            codes.push(
              await runtime
                .createSession({
                  source:
                    "}), (function f() { return f() + 1; })(), (function* () {",
                  limits: { stackBytes: FORCED, cpuTimeMs: 2_000 },
                })
                .then(
                  (session) => {
                    session.dispose();
                    return "created";
                  },
                  (error: unknown) => (error as { code?: unknown }).code,
                ),
            );
          }
          return codes;
        });

        expect(new Set(result)).toEqual(new Set(["WORKFLOW_LIMIT_EXCEEDED"]));
        expect(modules.discarded.length).toBeGreaterThan(0);
      },
    );
  });
});

describe("loadReleaseQuickJS cache", () => {
  test("discardReleaseQuickJS drops only the module it is given", async () => {
    const first = await loadReleaseQuickJS();
    expect(await loadReleaseQuickJS()).toBe(first);

    discardReleaseQuickJS({ newRuntime: () => ({}) });
    expect(await loadReleaseQuickJS()).toBe(first);

    discardReleaseQuickJS(first);
    const second = await loadReleaseQuickJS();
    expect(second).not.toBe(first);

    discardReleaseQuickJS(first);
    expect(await loadReleaseQuickJS()).toBe(second);
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
