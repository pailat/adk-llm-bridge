/**
 * Checks that every symbol exported from the public entry points has a TSDoc
 * summary in the built declarations (`dist/**\/*.d.ts`).
 *
 * Run it after `bun run build`. The entry points are the `types` files of the
 * `exports` map in `package.json`.
 *
 * TypeScript 7 has no JavaScript compiler API, so this reads the bundled
 * declaration files directly: top-level declarations start at column 0, and
 * the bundle ends with one `export { ... }` list. A name that an entry
 * imports from a shared chunk (`dist/shared/*.d.ts`) is checked at its
 * declaration in that chunk. A name with no declaration in the package (a
 * re-export from a dependency) is skipped, and an `@internal` symbol does not
 * need a summary.
 *
 * Usage:
 * - `bun scripts/check-export-docs.ts`: exit 1 when a symbol has no summary.
 * - `bun scripts/check-export-docs.ts --report`: print the list, exit 0.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const reportOnly = process.argv.includes("--report");

const manifest = JSON.parse(
  readFileSync(resolve(ROOT, "package.json"), "utf8"),
);
const entries: string[] = Object.values(
  (manifest.exports ?? {}) as Record<string, { types?: string }>,
)
  .map((entry) => entry.types)
  .filter((types): types is string => typeof types === "string");

const DECLARATION =
  /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:function|class|const|let|var|enum|interface|type|namespace)\s+([A-Za-z_$][\w$]*)/;

/** Names of the final `export { ... }` lists, as declared locally. */
function exportedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const item of (match[1] ?? "").split(",")) {
      const local = item
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (local) names.add(local);
    }
  }
  return names;
}

/** True when the JSDoc block ending right before `index` has a summary. */
function hasSummary(lines: string[], index: number): "yes" | "no" | "internal" {
  let end = index - 1;
  while (end >= 0 && (lines[end] ?? "").trim() === "") end--;
  if ((lines[end] ?? "").trim() !== "*/") {
    // One-line `/** text */`.
    const single = /^\s*\/\*\*\s*(.*?)\s*\*\/\s*$/.exec(lines[end] ?? "");
    if (!single) return "no";
    if (single[1]?.startsWith("@internal")) return "internal";
    return single[1] && !single[1].startsWith("@") ? "yes" : "no";
  }
  let start = end;
  while (start >= 0 && !(lines[start] ?? "").trim().startsWith("/**")) start--;
  if (start < 0) return "no";
  const body = lines
    .slice(start, end + 1)
    .map((line) => line.replace(/^\s*(?:\/\*\*|\*\/|\*)\s?/, "").trim());
  if (body.some((line) => line.startsWith("@internal"))) return "internal";
  const first = body.find((line) => line !== "");
  return first && !first.startsWith("@") ? "yes" : "no";
}

interface DeclarationFile {
  lines: string[];
  /** Line index of the first top-level declaration of each name. */
  declarations: Map<string, number>;
  /** Local name -> [file, name in that file] for relative imports. */
  imports: Map<string, [string, string]>;
}

const files = new Map<string, DeclarationFile>();
function load(path: string): DeclarationFile {
  const cached = files.get(path);
  if (cached) return cached;
  const source = readFileSync(path, "utf8");
  const lines = source.split("\n");
  const declarations = new Map<string, number>();
  lines.forEach((line, index) => {
    const name = DECLARATION.exec(line)?.[1];
    if (name && !declarations.has(name)) declarations.set(name, index);
  });
  const imports = new Map<string, [string, string]>();
  for (const match of source.matchAll(
    /^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(\.{1,2}\/[^"]+)"/gm,
  )) {
    const target = resolve(
      dirname(path),
      (match[2] ?? "").replace(/\.js$/, ".d.ts"),
    );
    for (const item of (match[1] ?? "").split(",")) {
      const [imported, local] = item
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .map((part) => part.trim());
      if (imported) imports.set(local ?? imported, [target, imported]);
    }
  }
  const file = { lines, declarations, imports };
  files.set(path, file);
  return file;
}

/** Follows relative imports to the file and line that declare `name`. */
function locate(
  path: string,
  name: string,
  depth = 0,
): { path: string; index: number } | undefined {
  const file = load(path);
  const index = file.declarations.get(name);
  if (index !== undefined) return { path, index };
  const imported = file.imports.get(name);
  if (!imported || depth > 8 || !existsSync(imported[0])) return undefined;
  return locate(imported[0], imported[1], depth + 1);
}

const missing: string[] = [];
let checked = 0;
for (const entry of entries) {
  const path = resolve(ROOT, entry);
  if (!existsSync(path)) {
    console.error(`check-export-docs: ${entry} not found; run bun run build`);
    process.exit(1);
  }
  for (const name of exportedNames(readFileSync(path, "utf8"))) {
    const found = locate(path, name);
    if (!found) continue;
    checked++;
    const lines = load(found.path).lines;
    if (hasSummary(lines, found.index) === "no") {
      missing.push(`${relative(ROOT, found.path)}:${found.index + 1}: ${name}`);
    }
  }
}

for (const item of missing) console.log(`${item}: no TSDoc summary`);
const suffix = `${checked} exported symbol(s) checked`;
if (missing.length === 0) {
  console.log(`check-export-docs: OK, ${suffix}`);
} else if (reportOnly) {
  console.log(
    `check-export-docs: ${missing.length} missing (${suffix}); report mode`,
  );
} else {
  console.error(
    `check-export-docs: FAIL, ${missing.length} missing (${suffix})`,
  );
  process.exit(1);
}
