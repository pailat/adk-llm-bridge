/**
 * Post-build check of third-party notices.
 *
 * 1. Every source file that `THIRD-PARTY-NOTICES` names opens with a `/*!`
 *    legal comment, and each line of that comment is in some `dist`
 *    JavaScript file: the bundler must keep it, as the third-party license
 *    requires (a plain `/**` header is dropped from the build).
 * 2. The package ships `THIRD-PARTY-NOTICES`: `bun pm pack --dry-run` lists
 *    it.
 *
 * Usage: `bun run build && bun scripts/check-dist-notices.ts`
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { noticedSourceFiles } from "./third-party-notices.js";

const ROOT = resolve(import.meta.dir, "..");
const NOTICES = "THIRD-PARTY-NOTICES";
const failures: string[] = [];

function distScripts(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...distScripts(path));
    else if (name.endsWith(".js")) files.push(path);
  }
  return files;
}

const notices = readFileSync(join(ROOT, NOTICES), "utf8");
const sources = noticedSourceFiles(notices);
if (sources.length === 0) {
  failures.push(`${NOTICES} names no source file`);
}
const dist = distScripts(join(ROOT, "dist")).map((path) =>
  readFileSync(path, "utf8"),
);
for (const source of sources) {
  const text = readFileSync(join(ROOT, source), "utf8");
  const legal = /^\/\*![\s\S]*?\*\//.exec(text)?.[0];
  if (!legal) {
    failures.push(`${source}: no leading /*! legal comment`);
    continue;
  }
  const lines = legal
    .split("\n")
    .map((line) => line.replace(/^\s*(\/\*!|\*\/|\*)\s?/, "").trim())
    .filter((line) => line.length > 0 && line !== "*/");
  for (const line of lines) {
    if (!dist.some((script) => script.includes(line))) {
      failures.push(`${source}: legal comment line missing from dist: ${line}`);
    }
  }
}

const pack = spawnSync("bun", ["pm", "pack", "--dry-run"], {
  cwd: ROOT,
  encoding: "utf8",
});
const packed = `${pack.stdout}${pack.stderr}`
  .split("\n")
  .map((line) => /^packed\s+\S+\s+(.+)$/.exec(line.trim())?.[1])
  .filter((path): path is string => path !== undefined);
if (pack.status !== 0) {
  failures.push(`bun pm pack --dry-run exited ${pack.status}`);
} else if (!packed.includes(NOTICES)) {
  failures.push(`the package does not ship ${NOTICES}`);
}

if (failures.length > 0) {
  for (const failure of failures)
    console.error(`check-dist-notices: ${failure}`);
  process.exit(1);
}
console.log(
  `check-dist-notices: OK (${sources.length} adapted file(s); ${NOTICES} packed)`,
);
