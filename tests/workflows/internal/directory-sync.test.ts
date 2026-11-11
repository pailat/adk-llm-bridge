import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures", "directory-sync-fault.ts");

function flush(
  platform: string,
  stage: "open" | "fsync" | "none",
  code: string,
  form: "sync" | "async",
  directory?: string,
): { ok: boolean; code?: string; flushed?: number; refused?: string } {
  const root = mkdtempSync(join(tmpdir(), "adk-directory-sync-"));
  try {
    const child = spawnSync(
      process.execPath,
      [FIXTURE, platform, stage, code, form, directory ?? root],
      { encoding: "utf8", timeout: 30_000 },
    );
    const line = child.stdout.trim().split("\n").at(-1) ?? "";
    if (!line) throw new Error(`fixture printed nothing: ${child.stderr}`);
    return JSON.parse(line);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Windows cannot flush a directory (the open is read-only and the flush is
// refused); NTFS journals the entry change itself. Only there, and only for
// these codes, the sync is skipped. Everywhere else an error is an error.
describe.each(["sync", "async"] as const)("directory sync (%s)", (form) => {
  // On Windows the real flush is refused: the runtime opens the directory
  // read-only (backup semantics) and `FlushFileBuffers` denies it (`EPERM`).
  test("flushes a real directory", () => {
    expect(flush(process.platform, "none", "-", form)).toEqual(
      process.platform === "win32"
        ? { ok: true, flushed: 0, refused: "fsync:EPERM" }
        : { ok: true, flushed: 1 },
    );
  });

  for (const code of ["EPERM", "EISDIR", "EINVAL"]) {
    for (const stage of ["open", "fsync"] as const) {
      test(`win32: ${code} from the ${stage} means the platform cannot flush a directory`, () => {
        expect(flush("win32", stage, code, form)).toEqual({
          ok: true,
          flushed: 0,
        });
      });
    }
  }

  test("win32: any other code is still an error", () => {
    expect(flush("win32", "fsync", "EIO", form)).toEqual({
      ok: false,
      code: "EIO",
    });
    expect(flush("win32", "open", "ENOENT", form)).toEqual({
      ok: false,
      code: "ENOENT",
    });
  });

  for (const platform of ["linux", "darwin", "freebsd"]) {
    for (const code of ["EPERM", "EISDIR", "EINVAL", "ENOTSUP", "EIO"]) {
      test(`${platform}: ${code} from the flush fails closed`, () => {
        expect(flush(platform, "fsync", code, form)).toEqual({
          ok: false,
          code,
        });
      });
    }
    test(`${platform}: EPERM from the open fails closed`, () => {
      expect(flush(platform, "open", "EPERM", form)).toEqual({
        ok: false,
        code: "EPERM",
      });
    });
  }

  test("a missing directory is an error on every platform", () => {
    const missing = join(tmpdir(), `adk-directory-sync-missing-${process.pid}`);
    for (const platform of ["win32", "linux"]) {
      expect(flush(platform, "none", "-", form, missing)).toMatchObject({
        ok: false,
        code: "ENOENT",
      });
    }
  });
});
