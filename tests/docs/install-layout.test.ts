/**
 * The repository install keeps Bun's isolated layout. Without workspaces Bun
 * defaults to the hoisted linker, which links transitive packages such as
 * `@openai/codex` into the root `node_modules`, so the suite's own install
 * would provide the very `node_modules/.bin/codex` the binary-resolution
 * tests plant and expect to be refused.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("bunfig.toml pins the isolated linker", () => {
  const bunfig = readFileSync(`${ROOT}bunfig.toml`, "utf8");
  const install = bunfig
    .split(/^\[/m)
    .find((section) => section.startsWith("install]"));
  expect(install).toBeDefined();
  expect(install).toMatch(/^linker\s*=\s*"isolated"\s*$/m);
});
