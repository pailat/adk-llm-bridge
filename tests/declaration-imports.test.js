import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixDeclarationImports } from "../scripts/fix-declaration-imports.mjs";

let tempDir;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("fixDeclarationImports", () => {
  test("adds .js to declaration imports that resolve to files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "adk-llm-bridge-dts-"));
    await mkdir(join(tempDir, "converters"), { recursive: true });
    const indexPath = join(tempDir, "index.d.ts");

    await writeFile(
      indexPath,
      'export { convertRequest } from "./converters/request";\n',
    );
    await writeFile(join(tempDir, "converters", "request.d.ts"), "");

    await fixDeclarationImports(tempDir);

    await expect(readFile(indexPath, "utf8")).resolves.toBe(
      'export { convertRequest } from "./converters/request.js";\n',
    );
  });

  test("adds /index.js to declaration imports that resolve to directories", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "adk-llm-bridge-dts-"));
    await mkdir(join(tempDir, "providers", "openai"), { recursive: true });
    const indexPath = join(tempDir, "index.d.ts");

    await writeFile(
      indexPath,
      'export { OpenAI } from "./providers/openai";\n',
    );
    await writeFile(join(tempDir, "providers", "openai", "index.d.ts"), "");

    await fixDeclarationImports(tempDir);

    await expect(readFile(indexPath, "utf8")).resolves.toBe(
      'export { OpenAI } from "./providers/openai/index.js";\n',
    );
  });
});
