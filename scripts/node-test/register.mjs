/**
 * Module hooks that let a `bun:test` suite run under Node (see
 * `scripts/node-test.mjs`): `bun:test` resolves to the shim next to this file,
 * a relative `.js` import with no such file resolves to its `.ts` source,
 * and `import.meta.dir` reads `import.meta.dirname`.
 * Defines the few `Bun` globals the suites use when Bun is absent: `sleep`,
 * `sleepSync`, `file`, `spawn`, `spawnSync` and `resolveSync`.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { constants as osConstants } from "node:os";
import { Readable } from "node:stream";
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

/** Maps a `Bun.spawn` stdio option to a `node:child_process` one. */
function stdioOf(value, fallback) {
  return value === undefined || value === null ? fallback : value;
}

/** The exit code Bun reports: a process ended by a signal reads 128 + signal. */
function exitCodeOf(code, signal) {
  if (code !== null) return code;
  return 128 + (osConstants.signals[signal] ?? 0);
}

/** `Bun.spawn(command, options)` over `node:child_process`. */
function bunSpawn(command, options = {}) {
  const child = spawn(command[0], command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: [
      stdioOf(options.stdin, "ignore"),
      stdioOf(options.stdout, "pipe"),
      stdioOf(options.stderr, "inherit"),
    ],
  });
  const exited = new Promise((done) => {
    child.once("error", () => done(1));
    child.once("close", (code, signal) => done(exitCodeOf(code, signal)));
  });
  return {
    pid: child.pid,
    exited,
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    get killed() {
      return child.killed;
    },
    kill: (signal) => child.kill(signal),
    stdin: child.stdin
      ? {
          write: (data) => child.stdin.write(data),
          flush: () => undefined,
          end: () => child.stdin.end(),
        }
      : undefined,
    stdout: child.stdout ? Readable.toWeb(child.stdout) : undefined,
    stderr: child.stderr ? Readable.toWeb(child.stderr) : undefined,
  };
}

/** `Bun.spawnSync(command, options)` over `node:child_process`. */
function bunSpawnSync(command, options = {}) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    killSignal: options.killSignal,
    stdio: [
      stdioOf(options.stdin, "ignore"),
      stdioOf(options.stdout, "pipe"),
      stdioOf(options.stderr, "pipe"),
    ],
  });
  return {
    exitCode: result.status === null ? null : result.status,
    signalCode: result.signal,
    success: result.status === 0,
    exitedDueToTimeout: result.error?.code === "ETIMEDOUT",
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr ?? Buffer.alloc(0),
  };
}

if (globalThis.Bun === undefined) {
  globalThis.Bun = {
    sleepSync: (ms) =>
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    gc: () => globalThis.gc?.(),
    spawn: bunSpawn,
    spawnSync: bunSpawnSync,
    resolveSync: (specifier, from) =>
      createRequire(`${from}/`).resolve(specifier),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    file: (path) => ({
      text: () => readFile(path, "utf8"),
      json: async () => JSON.parse(await readFile(path, "utf8")),
      exists: async () => existsSync(path),
    }),
  };
}
