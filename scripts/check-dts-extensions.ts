import { readdir, readFile } from "node:fs/promises";
import { relative } from "node:path";

const distDir = new URL("../dist/", import.meta.url);
const specifierPattern = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g;
const sideEffectImportPattern = /import\s+["'](\.{1,2}\/[^"']+)["']/g;
const allowedExtensions = new Set([".js", ".json"]);

function hasAllowedExtension(specifier: string): boolean {
  const withoutQuery = specifier.split(/[?#]/, 1)[0] ?? specifier;
  const lastSegment = withoutQuery.split("/").pop() ?? "";
  return [...allowedExtensions].some((extension) => lastSegment.endsWith(extension));
}

async function findDtsFiles(directory: URL): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) {
        return findDtsFiles(entryPath);
      }
      return entry.name.endsWith(".d.ts") ? [entryPath.pathname] : [];
    }),
  );

  return files.flat();
}

const failures: string[] = [];

for (const file of await findDtsFiles(distDir)) {
  const text = await readFile(file, "utf8");
  const patterns = [specifierPattern, sideEffectImportPattern];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier && !hasAllowedExtension(specifier)) {
        failures.push(`${relative(process.cwd(), file)}: extensionless relative specifier "${specifier}"`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Declaration files contain extensionless relative ESM specifiers:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("✓ Declaration relative ESM specifiers include explicit file extensions");
