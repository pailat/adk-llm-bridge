/**
 * Post-build check of the published entry points.
 *
 * 1. Every class is defined in exactly one `dist` JavaScript file and
 *    declared in exactly one `dist` declaration file. The build splits shared
 *    modules into `dist/shared/` chunks, so a class bundled into two entries
 *    (two copies of its module state, and an `instanceof` that fails across
 *    subpaths) means splitting regressed. A class declared twice in `.d.ts`
 *    files is two unrelated types when it has `#private` members, so passing
 *    an `/agents` object where `/workflows` expects it fails to compile.
 * 2. Each entry, and `adk-llm-bridge/package.json`, imports under Node from a
 *    consumer that has the required peers but none of the optional ones, by
 *    package name, so the `exports` map is exercised too. The one exception
 *    is a declared map of entry to required optional peers (the spec entry
 *    needs zod): those entries import only from a consumer that has exactly
 *    those peers, and every other entry is still checked without them.
 * 3. A name exported by more than one entry is the same value in each, so
 *    singletons such as error classes and registries are shared. The storage
 *    registry and error class are also checked by name across the workflows
 *    entry and the storage entries.
 * 4. The probe blocks `node:sqlite`, so an entry that loads it while being
 *    imported (instead of when a store is opened) fails the check.
 *
 * The consumer lives in a temporary directory: the package is copied in and
 * every other installed package except the optional peers is symlinked from
 * `node_modules`. No network is used.
 *
 * Usage: `bun run build && bun scripts/check-dist-entries.ts`
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const distDir = join(root, "dist");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  exports: Record<string, unknown>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};
const optionalPeers = new Set(
  Object.entries(pkg.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta.optional === true)
    .map(([name]) => name),
);
const failures: string[] = [];

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

// 1. No class is defined in two dist files.
const classPattern =
  /^(?:export )?class ([A-Za-z_$][\w$]*)|^var ([A-Za-z_$][\w$]*) = class\b/gm;
const definedIn = new Map<string, string[]>();
for (const file of listFiles(distDir).filter((f) => f.endsWith(".js"))) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(classPattern)) {
    // The bundler renames a clashing local copy `Name2`; strip the suffix.
    const name = (match[1] ?? match[2] ?? "").replace(/\d+$/, "");
    const files = definedIn.get(name) ?? [];
    files.push(relative(root, file));
    definedIn.set(name, files);
  }
}
for (const [name, files] of definedIn) {
  if (files.length > 1) {
    failures.push(`class ${name} is defined in ${files.join(", ")}`);
  }
}

const declarationPattern =
  /^(?:export )?declare (?:abstract )?class ([A-Za-z_$][\w$]*)/gm;
const declaredIn = new Map<string, string[]>();
for (const file of listFiles(distDir).filter((f) => f.endsWith(".d.ts"))) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(declarationPattern)) {
    // Declaration bundles also rename a clashing local copy `Name2`.
    const name = (match[1] ?? "").replace(/\d+$/, "");
    const files = declaredIn.get(name) ?? [];
    files.push(relative(root, file));
    declaredIn.set(name, files);
  }
}
for (const [name, files] of declaredIn) {
  if (files.length > 1) {
    failures.push(`class ${name} is declared in ${files.join(", ")}`);
  }
}
if (declaredIn.size === 0) failures.push("no class declarations found in dist");

// 2 and 3. Import the entries from consumers with and without optional peers.
/**
 * Entries that need an optional peer, by `exports` key. Every other entry must
 * import with no optional peer installed; these are imported only from a
 * consumer that has the listed peers.
 */
const entryOptionalPeers: Readonly<Record<string, readonly string[]>> = {
  "./workflows/spec": ["zod"],
};
for (const [key, peers] of Object.entries(entryOptionalPeers)) {
  if (!(key in pkg.exports))
    failures.push(`${key} is not in package.json exports`);
  for (const peer of peers) {
    if (!optionalPeers.has(peer)) {
      failures.push(`${key} requires ${peer}, which is not an optional peer`);
    }
  }
}

const allKeys = Object.keys(pkg.exports);
const specifierOf = (key: string): string =>
  key === "." ? pkg.name : `${pkg.name}/${key.slice(2)}`;
const needsPeers = (key: string): boolean =>
  (entryOptionalPeers[key]?.length ?? 0) > 0;

/** Imports `keys` from a consumer where only `present` optional peers exist. */
function checkConsumer(
  label: string,
  keys: readonly string[],
  present: ReadonlySet<string>,
): void {
  const consumer = mkdtempSync(join(tmpdir(), "adk-llm-bridge-entries-"));
  try {
    const modules = join(consumer, "node_modules");
    const installed = join(modules, pkg.name);
    mkdirSync(installed, { recursive: true });
    cpSync(join(root, "package.json"), join(installed, "package.json"));
    cpSync(distDir, join(installed, "dist"), { recursive: true });
    const linked: string[] = [];
    for (const entry of readdirSync(join(root, "node_modules"))) {
      if (entry.startsWith(".") || entry === pkg.name) continue;
      const names = entry.startsWith("@")
        ? readdirSync(join(root, "node_modules", entry)).map(
            (child) => `${entry}/${child}`,
          )
        : [entry];
      for (const name of names) {
        if (optionalPeers.has(name) && !present.has(name)) continue;
        mkdirSync(join(modules, name, ".."), { recursive: true });
        symlinkSync(join(root, "node_modules", name), join(modules, name));
        linked.push(name);
      }
    }

    const absent = [...optionalPeers].filter((name) => !present.has(name));
    const probe = `
      const specifiers = ${JSON.stringify(keys.map(specifierOf))};
      const absent = ${JSON.stringify(absent)};
      const present = ${JSON.stringify([...present])};
      const failures = [];
      for (const name of absent) {
        try {
          await import(name);
          failures.push("optional peer " + name + " is installed in the consumer");
        } catch {}
      }
      for (const name of present) {
        try {
          await import(name);
        } catch {
          failures.push("optional peer " + name + " is missing from the consumer");
        }
      }
      const owners = new Map();
      const storageNames = ["WorkflowStorageError", "registerWorkflowStorageProvider", "getWorkflowCheckpointStoreFromUri", "getWorkflowEventExporterFromUri", "BaseWorkflowCheckpointStore", "BaseWorkflowEventExporter"];
      const storageEntries = [
        "/workflows",
        "/workflows/checkpoint/sqlite",
        "/workflows/events/sqlite",
        "/workflows/storage/conformance",
      ];
      const storageValues = new Map();
      for (const specifier of specifiers) {
        let mod;
        try {
          mod = specifier.endsWith("/package.json")
            ? await import(specifier, { with: { type: "json" } })
            : await import(specifier);
        } catch (error) {
          failures.push(specifier + " failed to import: " + (error?.message ?? error));
          continue;
        }
        if (specifier.endsWith("/package.json")) continue;
        for (const name of storageNames) {
          if (!(name in mod) || !storageEntries.some((e) => specifier.endsWith(e))) continue;
          const seen = storageValues.get(name);
          if (seen === undefined) storageValues.set(name, mod[name]);
          else if (seen !== mod[name])
            failures.push(name + " is defined more than once across storage entries (" + specifier + ")");
        }
        for (const [name, value] of Object.entries(mod)) {
          const first = owners.get(name);
          if (!first) owners.set(name, { specifier, value });
          else if (first.value !== value)
            failures.push(name + " differs between " + first.specifier + " and " + specifier);
        }
      }
      for (const name of ["WorkflowStorageError", "registerWorkflowStorageProvider"]) {
        if (!storageValues.has(name)) failures.push(name + " is not exported by the workflows entry");
      }
      if (failures.length > 0) {
        console.error(failures.join("\\n"));
        process.exit(1);
      }
      console.log("imported " + specifiers.join(", "));
    `;
    const probeFile = join(consumer, "probe.mjs");
    writeFileSync(probeFile, probe);
    // Makes every `require("node:sqlite")`, including a lazy one made through
    // `createRequire`, throw, so importing an entry must not need the module.
    const blockFile = join(consumer, "block-sqlite.mjs");
    writeFileSync(
      blockFile,
      `import Module from "node:module";
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "node:sqlite" || request === "sqlite") {
    throw new Error("node:sqlite was required while importing an entry");
  }
  return load.call(this, request, ...rest);
};
`,
    );
    const result = spawnSync("node", ["--import", blockFile, probeFile], {
      cwd: consumer,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      failures.push(
        `Node import ${label} failed:\n${result.stderr || result.stdout || result.error}`,
      );
    } else {
      console.log(`check-dist-entries: ${label}: ${result.stdout.trim()}`);
    }
    if (linked.length === 0) failures.push("no packages were linked");
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

// Entries that need no optional peer, with every optional peer absent.
checkConsumer(
  "without optional peers",
  allKeys.filter((key) => !needsPeers(key)),
  new Set(),
);
// Every entry, with exactly the peers the declared entries require, so the
// values shared across entries are compared including the spec entry.
const requiredPeers = new Set(Object.values(entryOptionalPeers).flat());
if (requiredPeers.size > 0) {
  checkConsumer(
    `with ${[...requiredPeers].join(", ")}`,
    allKeys,
    requiredPeers,
  );
}

if (failures.length > 0) {
  console.error("check-dist-entries: FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(
  `check-dist-entries: OK (${definedIn.size} classes defined once, ${declaredIn.size} declared once; optional peers absent for entries that do not declare them: ${[...optionalPeers].join(", ")})`,
);
