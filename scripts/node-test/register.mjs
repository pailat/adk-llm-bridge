/**
 * Module hooks that let a `bun:test` suite run under Node (see
 * `scripts/node-test.mjs`): `bun:test` resolves to the shim next to this file,
 * a relative `.js` import with no such file resolves to its `.ts` source,
 * and `import.meta.dir` reads `import.meta.dirname`.
 * Defines the few `Bun` globals the suites use when Bun is absent.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const SHIM = new URL("./bun-test.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "bun:test") return { url: SHIM, shortCircuit: true };
    if (
      /^\.\.?\//u.test(specifier) &&
      specifier.endsWith(".js") &&
      context.parentURL?.startsWith("file:")
    ) {
      const target = new URL(specifier, context.parentURL);
      if (!existsSync(fileURLToPath(target))) {
        const source = new URL(
          specifier.replace(/\.js$/u, ".ts"),
          context.parentURL,
        );
        if (existsSync(fileURLToPath(source))) {
          return nextResolve(source.href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (
      url.startsWith("file:") &&
      url.endsWith(".ts") &&
      !url.includes("/node_modules/") &&
      loaded.source !== undefined
    ) {
      const source = String(loaded.source).replace(
        /\bimport\.meta\.dir\b(?!name)/gu,
        "import.meta.dirname",
      );
      return { ...loaded, source };
    }
    return loaded;
  },
});

if (globalThis.Bun === undefined) {
  globalThis.Bun = {
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    file: (path) => ({
      text: () => readFile(path, "utf8"),
      json: async () => JSON.parse(await readFile(path, "utf8")),
      exists: async () => existsSync(path),
    }),
  };
}
