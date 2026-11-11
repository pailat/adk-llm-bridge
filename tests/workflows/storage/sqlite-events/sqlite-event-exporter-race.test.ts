import { describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as realFs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The create-time check cannot be reached by arranging files before the open:
// the existence check would see them. So a child run of this file makes the
// check see "nothing" once while the path is already taken, as if another
// process had taken it in between. The child runs only when asked to by the
// environment; a normal run starts it from the tests below.
const CHILD = process.env.EVENT_EXPORTER_RACE_CHILD;
const here = import.meta.path;

if (CHILD === undefined) {
  describe("SqliteWorkflowEventExporter when the path is taken between the check and the create", () => {
    for (const kind of ["symlink", "directory"]) {
      // Skipped on Windows for the symbolic link: there is no `O_NOFOLLOW`, so a
      // link that appears after the check can be followed by the create; the
      // check before the open is the only guard there.
      test.skipIf(kind === "symlink" && process.platform === "win32")(
        `refuses a ${kind} that appeared there, and does not follow or use it`,
        () => {
          const dir = mkdtempSync(join(tmpdir(), "sqlite-events-race-"));
          try {
            const result = spawnSync(process.execPath, ["test", here], {
              env: {
                ...process.env,
                EVENT_EXPORTER_RACE_CHILD: kind,
                EVENT_EXPORTER_RACE_PATH: join(dir, "data.db"),
              },
              encoding: "utf8",
              timeout: 60_000,
            });
            expect(result.stdout + result.stderr).toContain("1 pass");
            expect(result.status).toBe(0);
            expect(realFs.existsSync(join(dir, "data.db.elsewhere"))).toBe(
              false,
            );
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );
    }
  });
} else {
  const path = process.env.EVENT_EXPORTER_RACE_PATH as string;
  let armed = true;
  // A copy taken before the mock replaces the module, so the wrapper below
  // calls the real functions and not itself.
  const real = { ...realFs };
  mock.module("node:fs", () => ({
    ...real,
    lstatSync: (target: string, ...rest: unknown[]) => {
      if (armed && target === path) {
        armed = false;
        real.mkdirSync(dirname(path), { recursive: true });
        if (CHILD === "symlink") {
          real.symlinkSync(`${path}.elsewhere`, path);
        } else {
          real.mkdirSync(path);
        }
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return (real.lstatSync as (...args: unknown[]) => unknown)(
        target,
        ...rest,
      );
    },
  }));

  test("child: the exporter refuses the path that was taken", async () => {
    const { SqliteWorkflowEventExporter } = await import(
      "../../../../src/workflows/events/sqlite/index.js"
    );
    let caught: unknown;
    try {
      new SqliteWorkflowEventExporter({ path });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string } | undefined)?.code).toBeDefined();
    expect(String((caught as Error).message)).toContain(
      "is not a regular file",
    );
    expect(armed).toBe(false);
  });
}
