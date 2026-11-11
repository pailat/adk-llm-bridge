/**
 * Flushes a real directory with an injected platform and file-system error,
 * in its own process so the module mock and the platform override cannot leak.
 *
 * Usage: `bun directory-sync-fault.ts <platform> <stage> <code> <form> <dir>`.
 * `stage` is `open` (opening `dir` fails), `fsync` (the flush fails) or
 * `none` (no fault); `form` is `sync` or `async`. Prints one JSON line:
 * `{ ok: true, flushed }` or `{ ok: false, code }`, where `flushed` counts the
 * flushes that reached the real file system. When the real file system itself
 * refuses the open or the flush (Windows), `refused: "<stage>:<code>"` names
 * that step.
 */

import { mock } from "bun:test";

const [platform, stage, code, form, directory] = process.argv.slice(2);
if (!platform || !stage || !code || !form || !directory) {
  throw new Error(
    "usage: <platform> <open|fsync|none> <code> <sync|async> <dir>",
  );
}

const realFs = { ...(await import("node:fs")) };
const realPromises = { ...(await import("node:fs/promises")) };
let flushed = 0;
let refused: string | undefined;
/** Runs a real step, recording the code if the file system refuses it. */
function real<T>(step: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    refused = `${step}:${String((error as { code?: unknown }).code)}`;
    throw error;
  }
}
async function realAsync<T>(step: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    refused = `${step}:${String((error as { code?: unknown }).code)}`;
    throw error;
  }
}
const fault = (step: string): void => {
  if (stage === step) {
    throw Object.assign(new Error(`injected ${code}`), { code });
  }
};

mock.module("node:fs", () => ({
  ...realFs,
  openSync: (...args: Parameters<typeof realFs.openSync>) => {
    if (String(args[0]) !== directory) return realFs.openSync(...args);
    fault("open");
    return real("open", () => realFs.openSync(...args));
  },
  fsyncSync: (descriptor: number) => {
    fault("fsync");
    real("fsync", () => realFs.fsyncSync(descriptor));
    flushed += 1;
  },
}));
mock.module("node:fs/promises", () => ({
  ...realPromises,
  open: async (...args: Parameters<typeof realPromises.open>) => {
    if (String(args[0]) !== directory) return await realPromises.open(...args);
    fault("open");
    const handle = await realAsync("open", () => realPromises.open(...args));
    return new Proxy(handle, {
      get(target, key) {
        if (key === "sync") {
          return async () => {
            fault("fsync");
            await realAsync("fsync", () => target.sync());
            flushed += 1;
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
}));
Object.defineProperty(process, "platform", { value: platform });

const { fsyncDirectory, fsyncDirectorySync } = await import(
  "../../../../src/workflows/internal/directory-sync.js"
);
try {
  if (form === "sync") fsyncDirectorySync(directory);
  else await fsyncDirectory(directory);
  console.log(JSON.stringify({ ok: true, flushed, refused }));
} catch (error) {
  console.log(
    JSON.stringify({ ok: false, code: (error as { code?: unknown }).code }),
  );
}
