/**
 * Every example is a standalone project that installs the published package:
 * a copied example must work with `npm install` alone. The repository never
 * links its own root into an example.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EXAMPLES = join(ROOT, "examples");

interface Manifest {
  version?: string;
  workspaces?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, "utf8")) as T;

const root = readJson<Manifest>(join(ROOT, "package.json"));
const examples = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("examples depend on the published package", () => {
  test("every example directory has a package.json", () => {
    expect(examples.length).toBeGreaterThan(0);
    for (const name of examples) {
      expect(existsSync(join(EXAMPLES, name, "package.json"))).toBe(true);
    }
  });

  test("the root package declares no workspaces, so no example is linked to it", () => {
    expect(root.workspaces).toBeUndefined();
  });

  test.each(examples)(
    "%s depends on adk-llm-bridge ^<root version> and @google/adk ^2.5.0",
    (name) => {
      const manifest = readJson<Manifest>(join(EXAMPLES, name, "package.json"));
      const dependencies = manifest.dependencies ?? {};
      expect(dependencies["adk-llm-bridge"]).toBe(`^${root.version}`);
      expect(dependencies["@google/adk"]).toBe("^2.5.0");
      // The other required peers are declared too, so a copy installs alone.
      for (const peer of ["@google/genai", "@opentelemetry/api"]) {
        expect(dependencies[peer]).toBeString();
      }
      expect(manifest.devDependencies?.["adk-llm-bridge"]).toBeUndefined();
      expect(manifest.scripts?.typecheck).toBe("tsc --noEmit");
    },
  );

  test.each(examples)("%s resolves nothing from the repository", (name) => {
    const dir = join(EXAMPLES, name);
    const manifest = readFileSync(join(dir, "package.json"), "utf8");
    expect(manifest).not.toMatch(/"(file|link|workspace):/);
    const tsconfig = readFileSync(join(dir, "tsconfig.json"), "utf8");
    expect(tsconfig).not.toContain("../../");
  });

  test("the root peer range for @google/adk starts at 2.5.0", () => {
    expect(root.peerDependencies?.["@google/adk"]).toBe(">=2.5.0 <3");
    expect(root.devDependencies?.["@google/adk"]).toBe("^2.5.0");
  });
});
