/**
 * Post-build fix for the emitted declarations.
 *
 * The bunup declaration bundler (0.16.x) rewrites the ES private-field marker
 * `#private;` as `private;`. That declares a public member named `private`
 * with an implicit `any` type, so consumers compiling with `strict` and
 * `skipLibCheck: false` get TS7008 once per class. No bunup `dts` option
 * (`inferTypes`, `resolve`, `splitting`, `minify`) avoids it; `tsgo` would
 * need an extra dev dependency.
 *
 * Usage:
 * - `bun scripts/fix-dts-private.ts`: restore `#private;` in every `.d.ts`
 *   under `dist/` (run by `bun run build`).
 * - `bun scripts/fix-dts-private.ts --check`: exit 1 if any `private;`
 *   marker is left (run by `ci` and `prepublishOnly`).
 *
 * `DIST_DIR` overrides the dist path.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

const BARE_PRIVATE_MARKER = /^(\s+)private;$/gm;

const distDir = process.env.DIST_DIR ?? resolve(import.meta.dir, "..", "dist");
const checkOnly = process.argv.includes("--check");

function* declarationFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* declarationFiles(path);
    else if (path.endsWith(".d.ts")) yield path;
  }
}

if (!existsSync(distDir)) {
  console.error(
    `fix-dts-private: ${distDir} does not exist; run the build first`,
  );
  process.exit(1);
}

let files = 0;
let markers = 0;
for (const file of declarationFiles(distDir)) {
  const source = readFileSync(file, "utf8");
  const count = source.match(BARE_PRIVATE_MARKER)?.length ?? 0;
  if (count === 0) continue;
  files++;
  markers += count;
  if (checkOnly) {
    console.error(
      `fix-dts-private: ${relative(distDir, file)} has ${count} bare 'private;' marker(s)`,
    );
  } else {
    writeFileSync(file, source.replace(BARE_PRIVATE_MARKER, "$1#private;"));
  }
}

if (checkOnly) {
  if (markers > 0) {
    console.error(
      "fix-dts-private: FAIL, run `bun scripts/fix-dts-private.ts` after bunup",
    );
    process.exit(1);
  }
  console.log("fix-dts-private: OK (no bare 'private;' markers in dist)");
} else {
  console.log(
    `fix-dts-private: restored ${markers} '#private;' marker(s) in ${files} file(s)`,
  );
}
