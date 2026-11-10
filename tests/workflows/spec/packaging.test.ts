import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const srcRoot = resolve(import.meta.dir, "../../../src");
const specRoot = join(srcRoot, "workflows", "spec");

/** Lists every TypeScript file below a directory. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** Returns the module specifiers a file imports, re-exports or loads. */
function specifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [
    ...source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/gu),
  ].map((match) => match[1] as string);
}

/** Resolves a relative specifier to a path without the `.js` suffix. */
function target(file: string, specifier: string): string {
  return resolve(dirname(file), specifier).replace(/\.js$/u, "");
}

const insideSpec = (path: string): boolean =>
  path === specRoot || path.startsWith(specRoot + sep);

// Modules of the existing workflow surface that the spec module reuses. All
// of them are free of Node built-ins.
const reusedModules = new Set(
  [
    "workflows/orchestration/contracts",
    "workflows/orchestration/json",
    "workflows/internal/portable-path",
    "workflows/internal/identifiers",
    "workflows/internal/canonical-hash",
    "workflows/internal/immutable-json",
    "workflows/execution/json",
    "agents/permissions/schema",
  ].map((name) => join(srcRoot, name)),
);

describe("spec module packaging", () => {
  const specFiles = sourceFiles(specRoot);

  test("the spec module has source files", () => {
    expect(specFiles.length).toBeGreaterThan(0);
  });

  test("no file outside the spec module imports from it", () => {
    const offenders = sourceFiles(srcRoot)
      .filter((file) => !insideSpec(file))
      .flatMap((file) =>
        specifiers(file)
          .filter(
            (specifier) =>
              specifier.startsWith(".") && insideSpec(target(file, specifier)),
          )
          .map((specifier) => `${relative(srcRoot, file)} -> ${specifier}`),
      );
    expect(offenders).toEqual([]);
  });

  test("the spec module imports only zod, its own files and reused workflow modules", () => {
    const offenders = specFiles.flatMap((file) =>
      specifiers(file)
        .filter((specifier) => {
          if (specifier === "zod") return false;
          if (!specifier.startsWith(".")) return true;
          const path = target(file, specifier);
          return !insideSpec(path) && !reusedModules.has(path);
        })
        .map((specifier) => `${relative(srcRoot, file)} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  test("the spec module has no Node built-in, Bun or process access", () => {
    const offenders = specFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const found: string[] = [];
      if (/["']node:/u.test(source)) found.push("node: import");
      if (/\bprocess\.(env|argv|cwd)\b/u.test(source)) found.push("process");
      if (/\bBun\./u.test(source)) found.push("Bun");
      return found.map((what) => `${relative(srcRoot, file)}: ${what}`);
    });
    expect(offenders).toEqual([]);
  });

  test("no file outside the spec module imports zod", () => {
    const withZod = sourceFiles(srcRoot)
      .filter((file) => specifiers(file).includes("zod"))
      .filter((file) => !insideSpec(file))
      .map((file) => relative(srcRoot, file));
    // Entries that must load without the optional peer cannot import it.
    expect(withZod).toEqual([]);
  });
});

describe("spec module import", () => {
  test("registers no run spec schema in zod's global registry", async () => {
    const spec = await import("../../../src/workflows/spec/index.js");
    const schemas = Object.entries(spec).filter(
      ([name, value]) => name.endsWith("Schema") && value instanceof z.ZodType,
    );
    expect(schemas.length).toBeGreaterThan(10);
    const registered = schemas
      .filter(([, schema]) => z.globalRegistry.has(schema as z.ZodType))
      .map(([name]) => name);
    expect(registered).toEqual([]);
  });

  test("lets a host schema use an id the run spec schemas use", async () => {
    const { RunRulesSchema } = await import(
      "../../../src/workflows/spec/index.js"
    );
    const host = z.object({
      mine: z.string().meta({ id: "RunRules" }),
      rules: RunRulesSchema,
    });
    expect(() => z.toJSONSchema(host)).not.toThrow();
  });

  test("can be evaluated a second time", async () => {
    // A query string makes the runtime evaluate the module again.
    const specifier = "../../../src/workflows/spec/json-schema.js?again";
    const again: { runSpecJsonSchema: Record<string, unknown> } = await import(
      specifier
    );
    expect(again.runSpecJsonSchema.$defs).toBeDefined();
  });
});
