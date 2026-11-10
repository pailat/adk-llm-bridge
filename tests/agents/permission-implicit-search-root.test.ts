import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardRequestPaths } from "../../src/agents/permissions/confirmation.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A repo with an allowed `lib/data` inside it. */
function repo(): { repo: string; data: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "guard-search-root-")));
  dirs.push(base);
  const data = join(base, "lib", "data");
  mkdirSync(data, { recursive: true });
  return { repo: base, data };
}

function decide(
  toolName: string,
  input: Record<string, unknown>,
  workingDirectory: string,
  allowed: string,
) {
  return guardRequestPaths(
    { mode: "workspace-write", allowedPaths: [allowed] },
    { toolName, input },
    { workingDirectory },
  );
}

describe("a relative glob without a search root is rooted at the working directory", () => {
  test("read_many_files with only include globs is denied when the working directory is outside", () => {
    const { repo: cwd, data } = repo();

    for (const include of [["**/*.ts"], "*.env", ["src/**", "app/*"]]) {
      expect(decide("read_many_files", { include }, cwd, data)?.behavior).toBe(
        "deny",
      );
    }
  });

  test("an unknown tool whose only path input is a relative glob is denied too", () => {
    const { repo: cwd, data } = repo();

    expect(decide("find_files", { pattern: "**/*" }, cwd, data)?.behavior).toBe(
      "deny",
    );
  });

  test("the same globs pass when the working directory is inside allowedPaths", () => {
    const { data } = repo();

    expect(
      decide("read_many_files", { include: ["**/*.ts"] }, data, data),
    ).toBeUndefined();
    expect(
      decide("find_files", { pattern: "**/*" }, data, data),
    ).toBeUndefined();
  });

  test("a relative glob under an explicit root inside allowedPaths passes", () => {
    const { repo: cwd, data } = repo();

    expect(
      decide("Glob", { pattern: "**/*.ts", path: data }, cwd, data),
    ).toBeUndefined();
  });
});
