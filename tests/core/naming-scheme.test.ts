/**
 * Pins the public naming scheme: `<Provider>ProviderConfig` for a model's
 * config, `<Provider>RegisterOptions` for a `register*()` function, and `Adk`
 * (not `ADK`) in class names. Every older name stays exported as a
 * `@deprecated` alias of the same type or value, so no import breaks.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as agents from "../../src/agents/index.js";
import type * as Root from "../../src/index.js";
import type * as Workflows from "../../src/workflows/index.js";
import * as workflows from "../../src/workflows/index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

// Each deprecated alias is the very same type as its replacement;
// `typecheck:all` fails if one drifts.
export type AliasesAreIdentical = [
  Expect<Equal<Root.AIGatewayConfig, Root.AIGatewayProviderConfig>>,
  Expect<Equal<Root.RegisterOptions, Root.AIGatewayRegisterOptions>>,
  Expect<Equal<Root.OpenRouterConfig, Root.OpenRouterProviderConfig>>,
  Expect<Equal<Root.CustomLlmConfig, Root.CustomProviderConfig>>,
  Expect<Equal<Root.CustomLlmProviderConfig, Root.CustomProviderConfig>>,
  Expect<
    Equal<Root.CustomProviderRegistrationConfig, Root.CustomRegisterOptions>
  >,
  Expect<
    Equal<
      Workflows.ADKSessionCheckpointStoreOptions,
      Workflows.AdkSessionCheckpointStoreOptions
    >
  >,
  Expect<
    Equal<
      Workflows.ADKSessionCheckpointStore,
      Workflows.AdkSessionCheckpointStore
    >
  >,
];

const ROOT = join(import.meta.dir, "..", "..");

/**
 * The doc comment directly above the declaration of `name` in `file`, or
 * `undefined` when the declaration has none.
 */
function docCommentOf(file: string, name: string): string | undefined {
  const source = readFileSync(join(ROOT, file), "utf8");
  const declaration = new RegExp(
    `export (?:declare )?(?:const|type|interface|class|function) ${name}\\b`,
  );
  const match = declaration.exec(source);
  if (!match) throw new Error(`${name} is not declared in ${file}`);
  const before = source.slice(0, match.index).trimEnd();
  if (!before.endsWith("*/")) return undefined;
  return before.slice(before.lastIndexOf("/**"));
}

const DEPRECATED: ReadonlyArray<{
  file: string;
  name: string;
  replacement: string;
}> = [
  {
    file: "src/types.ts",
    name: "AIGatewayConfig",
    replacement: "AIGatewayProviderConfig",
  },
  {
    file: "src/types.ts",
    name: "RegisterOptions",
    replacement: "AIGatewayRegisterOptions",
  },
  {
    file: "src/types.ts",
    name: "OpenRouterConfig",
    replacement: "OpenRouterProviderConfig",
  },
  {
    file: "src/types.ts",
    name: "CustomLlmConfig",
    replacement: "CustomProviderConfig",
  },
  {
    file: "src/providers/custom/custom-llm.ts",
    name: "CustomLlmProviderConfig",
    replacement: "CustomProviderConfig",
  },
  {
    file: "src/providers/custom/registry.ts",
    name: "CustomProviderRegistrationConfig",
    replacement: "CustomRegisterOptions",
  },
  {
    file: "src/workflows/checkpoint/store.ts",
    name: "ADKSessionCheckpointStore",
    replacement: "AdkSessionCheckpointStore",
  },
  {
    file: "src/workflows/checkpoint/store.ts",
    name: "ADKSessionCheckpointStoreOptions",
    replacement: "AdkSessionCheckpointStoreOptions",
  },
  {
    file: "src/agents/driver/claude-agent-sdk.ts",
    name: "DEFAULT_CLAUDE_SDK_TOOLS",
    replacement: "DEFAULT_CLAUDE_TOOLS",
  },
  {
    file: "src/agents/runtime/error-classification.ts",
    name: "LEGACY_RECOVERABLE_ERROR_CODES",
    replacement: "normalizeRecoverableErrorCode",
  },
];

const CURRENT: ReadonlyArray<{ file: string; name: string }> = [
  { file: "src/types.ts", name: "AIGatewayProviderConfig" },
  { file: "src/types.ts", name: "AIGatewayRegisterOptions" },
  { file: "src/types.ts", name: "OpenRouterProviderConfig" },
  { file: "src/types.ts", name: "CustomProviderConfig" },
  { file: "src/providers/custom/registry.ts", name: "CustomRegisterOptions" },
  {
    file: "src/workflows/checkpoint/store.ts",
    name: "AdkSessionCheckpointStore",
  },
  {
    file: "src/workflows/checkpoint/store.ts",
    name: "AdkSessionCheckpointStoreOptions",
  },
];

describe("public naming scheme", () => {
  test.each(DEPRECATED)(
    "$name is @deprecated in favor of $replacement",
    ({ file, name, replacement }) => {
      const doc = docCommentOf(file, name) ?? "";
      expect(doc).toContain("@deprecated");
      expect(doc).toContain(`{@link ${replacement}}`);
    },
  );

  test.each(CURRENT)(
    "$name is documented and not deprecated",
    ({ file, name }) => {
      const doc = docCommentOf(file, name);
      expect(doc).toBeDefined();
      expect(doc).not.toContain("@deprecated");
    },
  );

  test("the Adk store name is the same class as the deprecated ADK name", () => {
    expect(workflows.AdkSessionCheckpointStore).toBeFunction();
    expect(workflows.ADKSessionCheckpointStore).toBe(
      workflows.AdkSessionCheckpointStore,
    );
  });

  test("DEFAULT_CLAUDE_SDK_TOOLS is the very list DEFAULT_CLAUDE_TOOLS", () => {
    expect(agents.DEFAULT_CLAUDE_SDK_TOOLS).toBe(agents.DEFAULT_CLAUDE_TOOLS);
  });
});
