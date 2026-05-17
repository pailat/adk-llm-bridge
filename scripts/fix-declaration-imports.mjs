import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST_DIR = resolve("dist");
const RELATIVE_SPECIFIER_RE =
  /(\bfrom\s+["']|import\s*\(\s*["'])(\.{1,2}\/[^"']+)(["'])/g;

function hasExplicitExtension(specifier) {
  return extname(specifier) !== "";
}

function toJsSpecifier(declarationFile, specifier) {
  if (hasExplicitExtension(specifier)) {
    return specifier;
  }

  const declarationDir = dirname(declarationFile);
  const target = resolve(declarationDir, specifier);

  if (existsSync(`${target}.d.ts`)) {
    return `${specifier}.js`;
  }

  if (existsSync(join(target, "index.d.ts"))) {
    return `${specifier}/index.js`;
  }

  return specifier;
}

export function rewriteDeclarationImports(declarationFile, source) {
  return source.replace(
    RELATIVE_SPECIFIER_RE,
    (_match, prefix, specifier, suffix) =>
      `${prefix}${toJsSpecifier(declarationFile, specifier)}${suffix}`
  );
}

async function listDeclarationFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listDeclarationFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }

  return files;
}

export async function fixDeclarationImports(distDir = DIST_DIR) {
  const files = await listDeclarationFiles(distDir);

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const next = rewriteDeclarationImports(file, source);
    if (next !== source) {
      await writeFile(file, next);
    }
  }

  return files.length;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const count = await fixDeclarationImports();
  console.log(`Fixed relative imports in ${count} declaration file(s)`);
}
