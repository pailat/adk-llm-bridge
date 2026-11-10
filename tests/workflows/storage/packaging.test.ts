import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Importing the workflows entry or a provider subpath must never load
// `node:sqlite`; only opening a database does. Each import runs in a child
// process whose preload makes every `require("node:sqlite")` throw.

const root = resolve(import.meta.dir, "../../..");
const scratch = mkdtempSync(join(tmpdir(), "workflow-storage-packaging-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const preload = join(scratch, "block-node-sqlite.mjs");
writeFileSync(
  preload,
  `import Module from "node:module";
const message = "node:sqlite was required";
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "node:sqlite" || request === "sqlite") throw new Error(message);
  return load.call(this, request, ...rest);
};
const create = Module.createRequire;
Module.createRequire = function (...args) {
  const inner = create.apply(this, args);
  const guarded = (id) => {
    if (id === "node:sqlite" || id === "sqlite") throw new Error(message);
    return inner(id);
  };
  return Object.assign(guarded, inner);
};
`,
);

function runChild(
  source: string,
  name: string,
): { status: number | null; stdout: string; stderr: string } {
  const file = join(scratch, `${name}.mjs`);
  writeFileSync(file, source);
  const result = Bun.spawnSync([process.execPath, "--preload", preload, file], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const entries = [
  ["workflows entry", "src/workflows/index.ts"],
  ["workflows storage barrel", "src/workflows/storage/index.ts"],
  ["sqlite checkpoint subpath", "src/workflows/checkpoint/sqlite/index.ts"],
  ["sqlite events subpath", "src/workflows/events/sqlite/index.ts"],
  ["conformance subpath", "src/workflows/storage/conformance/index.ts"],
] as const;

describe("workflow storage packaging", () => {
  test("the preload really blocks node:sqlite (control)", () => {
    const result = runChild(
      `import { SqliteWorkflowCheckpointStore } from ${JSON.stringify(join(root, "src/workflows/checkpoint/sqlite/index.ts"))};
try {
  const store = new SqliteWorkflowCheckpointStore({ path: ":memory:" });
  await store.list({ limit: 1 });
  console.log("opened");
} catch (error) {
  console.log("failed: " + (error?.code ?? error?.message));
}
`,
      "control",
    );
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("opened");
    expect(result.stdout).toContain("failed:");
  });

  for (const [label, entry] of entries) {
    test(`importing the ${label} does not load node:sqlite`, () => {
      const result = runChild(
        `const mod = await import(${JSON.stringify(join(root, entry))});
console.log("exports:" + Object.keys(mod).length);
`,
        `import-${label.replaceAll(" ", "-")}`,
      );
      expect({ status: result.status, stderr: result.stderr }).toEqual({
        status: 0,
        stderr: "",
      });
      expect(result.stdout).toMatch(/exports:[1-9]/u);
    });
  }

  test("importing all of them together does not load node:sqlite", () => {
    const imports = entries
      .map(([, entry]) => `await import(${JSON.stringify(join(root, entry))});`)
      .join("\n");
    const result = runChild(`${imports}\nconsole.log("done");\n`, "all");
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    expect(result.stdout).toContain("done");
  });
});
