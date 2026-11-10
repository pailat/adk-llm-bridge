import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { WorkflowError } from "../contracts.js";

/**
 * Structural view of the `QuickJSWASMModule` from `quickjs-emscripten-core`.
 *
 * Public types use this shape instead of the peer's own type, so the published
 * declarations never import the optional peer (TS2307 under
 * `skipLibCheck: false` when it is not installed). Loaders must still resolve
 * to a real `QuickJSWASMModule`, such as the result of
 * `newQuickJSWASMModuleFromVariant(...)`.
 */
export interface QuickJSModuleLike {
  /** Creates a QuickJS runtime. */
  newRuntime(): object;
}

/** Async factory that resolves a QuickJS WASM module. */
export type QuickJSModuleLoader = () => Promise<QuickJSModuleLike>;

let releaseModulePromise: Promise<QuickJSWASMModule> | undefined;

/**
 * Lazily loads the optional production QuickJS sync variant and caches it.
 *
 * @returns The shared QuickJS module.
 * @throws {@link WorkflowError} with code `WORKFLOW_SANDBOX_UNAVAILABLE` when the optional peers are not installed. A failed load is not cached.
 *
 * @internal
 */
export const loadReleaseQuickJS = async (): Promise<QuickJSWASMModule> => {
  if (!releaseModulePromise) {
    releaseModulePromise = (async () => {
      try {
        const core = await import("quickjs-emscripten-core");
        return await core.newQuickJSWASMModuleFromVariant(
          import("@jitl/quickjs-wasmfile-release-sync"),
        );
      } catch (cause) {
        releaseModulePromise = undefined;
        throw new WorkflowError(
          "WORKFLOW_SANDBOX_UNAVAILABLE",
          "QuickJS sandbox dependencies are unavailable. Install quickjs-emscripten-core and @jitl/quickjs-wasmfile-release-sync.",
          {
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        );
      }
    })();
  }
  return releaseModulePromise;
};

/**
 * Narrows a loader result to the peer's module type. The loader contract
 * requires a real `QuickJSWASMModule`; this only rejects values that cannot be
 * one, with the same error as a missing peer.
 *
 * @param module - Value returned by a {@link QuickJSModuleLoader}.
 * @returns The module typed as `QuickJSWASMModule`.
 * @throws {@link WorkflowError} with code `WORKFLOW_SANDBOX_UNAVAILABLE` when `module` has no `newRuntime` function.
 *
 * @internal
 */
export function quickJSModule(module: QuickJSModuleLike): QuickJSWASMModule {
  if (
    !module ||
    typeof module !== "object" ||
    typeof module.newRuntime !== "function"
  ) {
    throw new WorkflowError(
      "WORKFLOW_SANDBOX_UNAVAILABLE",
      "QuickJS module loader must resolve to a QuickJSWASMModule",
    );
  }
  return module as QuickJSWASMModule;
}
