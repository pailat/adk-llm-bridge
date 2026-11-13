/**
 * Lets a test load an example's source files. The examples are standalone
 * projects that depend on the published `adk-llm-bridge`, so the repository
 * install does not link it for them; these mocks resolve the package's
 * entries to this checkout's source instead. Every other import of an example
 * (`@google/adk`, the Codex SDK, ...) resolves from the root `node_modules`.
 */

import { mock } from "bun:test";

/**
 * Resolves `adk-llm-bridge`, `adk-llm-bridge/agents` and
 * `adk-llm-bridge/workflows` to `src/`. Call it before the first import of an
 * example file.
 */
export function resolveBridgeToSource(): void {
  mock.module("adk-llm-bridge", () => import("../../src/index.js"));
  mock.module(
    "adk-llm-bridge/agents",
    () => import("../../src/agents/index.js"),
  );
  mock.module(
    "adk-llm-bridge/workflows",
    () => import("../../src/workflows/index.js"),
  );
}
