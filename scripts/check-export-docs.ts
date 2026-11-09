/**
 * Checks that every symbol exported from the public entry points has a TSDoc
 * summary in the built declarations (`dist/**\/*.d.ts`).
 *
 * Run it after `bun run build`. The entry points are the `types` files of the
 * `exports` map in `package.json`.
 *
 * TypeScript 7 has no JavaScript compiler API, so this reads the bundled
 * declaration files directly: top-level declarations start at column 0, and
 * the bundle ends with one `export { ... }` list. A name in that list that
 * has no local declaration (a re-export from a dependency) is skipped, and an
 * `@internal` symbol does not need a summary.
 *
 * Usage:
 * - `bun scripts/check-export-docs.ts`: exit 1 when a symbol has no summary.
 * - `bun scripts/check-export-docs.ts --report`: print the list, exit 0.
 */
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

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

const missing: string[] = [];
let checked = 0;
for (const entry of entries) {
  const path = resolve(ROOT, entry);
  if (!existsSync(path)) {
    console.error(`check-export-docs: ${entry} not found; run bun run build`);
    process.exit(1);
  }
  const source = readFileSync(path, "utf8");
  const lines = source.split("\n");
  const exported = exportedNames(source);
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const match = DECLARATION.exec(line);
    const name = match?.[1];
    if (!name || !exported.has(name) || seen.has(name)) return;
    seen.add(name);
    checked++;
    if (hasSummary(lines, index) === "no") {
      missing.push(`${relative(ROOT, path)}:${index + 1}: ${name}`);
    }
  });
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
