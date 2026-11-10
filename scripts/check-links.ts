/**
 * Checks relative links and anchors in the repository's Markdown files.
 *
 * Offline: only links that point to files in this repository (and `#anchors`
 * inside them) are checked. External URLs are ignored.
 *
 * Usage: `bun scripts/check-links.ts`. Exits 1 when a link is broken.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SKIP = new Set(["node_modules", "dist", ".git", ".claude"]);
/**
 * Rendered outside the repository tree (a pull request page), so relative
 * links do not work there and absolute URLs are required.
 */
const ABSOLUTE_LINKS_ONLY = new Set([".github/PULL_REQUEST_TEMPLATE.md"]);

function* markdownFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* markdownFiles(path);
    else if (name.endsWith(".md")) yield path;
  }
}

/** Removes fenced code blocks so that example links are not checked. */
function stripCode(source: string): string {
  // Keep the newlines so that line numbers still match the file.
  return source.replace(/^(```|~~~)[\s\S]*?^\1/gm, (block) =>
    block.replace(/[^\n]/g, ""),
  );
}

/** GitHub-style heading slug. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchors(source: string): Set<string> {
  const found = new Set<string>();
  const seen = new Map<string, number>();
  for (const match of stripCode(source).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = slug(match[1] ?? "");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    // GitHub numbers repeated headings: x, x-1, x-2.
    found.add(count === 0 ? base : `${base}-${count}`);
  }
  return found;
}

let broken = 0;
for (const file of markdownFiles(ROOT)) {
  const text = stripCode(readFileSync(file, "utf8"));
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const withoutCode = line.replace(/`[^`]*`/g, "");
    for (const match of withoutCode.matchAll(
      /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    )) {
      const target = match[1] ?? "";
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      if (ABSOLUTE_LINKS_ONLY.has(relative(ROOT, file))) {
        broken++;
        console.log(
          `${relative(ROOT, file)}:${index + 1}: relative link in a page rendered outside the repository: ${target}`,
        );
        continue;
      }
      const [pathPart, anchor] = target.split("#");
      const resolved = pathPart ? resolve(dirname(file), pathPart) : file;
      let problem = "";
      if (!existsSync(resolved)) problem = "file not found";
      else if (anchor && resolved.endsWith(".md")) {
        if (!anchors(readFileSync(resolved, "utf8")).has(anchor)) {
          problem = "anchor not found";
        }
      }
      if (problem) {
        broken++;
        console.log(
          `${relative(ROOT, file)}:${index + 1}: ${problem}: ${target}`,
        );
      }
    }
  });
}

if (broken > 0) {
  console.error(`check-links: FAIL, ${broken} broken link(s)`);
  process.exit(1);
}
console.log("check-links: OK");
