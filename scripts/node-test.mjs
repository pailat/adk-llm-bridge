/**
 * Runs `bun:test` suites under Node, to check that the code under test behaves
 * the same on Node's file system and process APIs as on Bun's.
 *
 * Usage: `node scripts/node-test.mjs <test file or directory>...`
 *
 * Directories are searched recursively for `*.test.ts`. Each file runs in its
 * own process under `node --test`, one at a time, with the compatibility layer
 * in `scripts/node-test/` loaded through `NODE_OPTIONS`, so a child process a
 * test starts with `process.execPath` gets it too. Sources are compiled with
 * `--experimental-transform-types` (the code uses parameter properties), so it
 * needs Node 22.18 to 25: Node 26 dropped that transform. Exits non-zero when
 * a test fails, no test file is found, or the Node version cannot run it.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18) || major >= 26) {
  console.error(
    `node-test needs Node 22.18 to 25 (TypeScript transform); this is ${process.version}`,
  );
  process.exit(2);
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error(
    "usage: node scripts/node-test.mjs <test file or directory>...",
  );
  process.exit(2);
}

function collect(path, files) {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      if (entry === "node_modules" || entry === "fixtures") continue;
      collect(join(path, entry), files);
    }
  } else if (path.endsWith(".test.ts")) {
    files.push(path);
  }
  return files;
}

const files = paths.flatMap((path) => collect(resolve(path), []));
if (files.length === 0) {
  console.error(`no *.test.ts file under: ${paths.join(" ")}`);
  process.exit(2);
}

const register = pathToFileURL(
  join(
    fileURLToPath(new URL(".", import.meta.url)),
    "node-test",
    "register.mjs",
  ),
).href;
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", "--test-reporter=spec", ...files],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --experimental-transform-types --disable-warning=ExperimentalWarning --import=${register}`.trim(),
    },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
