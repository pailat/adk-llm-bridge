/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { WorkflowError } from "../contracts.js";

export type QuickJSModuleLoader = () => Promise<QuickJSWASMModule>;

let releaseModulePromise: Promise<QuickJSWASMModule> | undefined;

/** Lazily loads the optional production QuickJS sync variant. */
export const loadReleaseQuickJS: QuickJSModuleLoader = async () => {
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
