import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDurableFileSync } from "../../../src/workflows/internal/directory-lock.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "durable-file-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("writeDurableFileSync creates exclusively", () => {
  test("creates a new 0600 file", () => {
    const path = join(tempDir(), "owner.json");
    writeDurableFileSync(path, "fresh");
    expect(readFileSync(path, "utf8")).toBe("fresh");
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  test("refuses to overwrite an existing owner file (EEXIST)", () => {
    const path = join(tempDir(), "owner.json");
    writeFileSync(path, "other-owner");
    expect(() => writeDurableFileSync(path, "attacker")).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(readFileSync(path, "utf8")).toBe("other-owner");
  });

  test("does not follow a planted symlink at the owner path", () => {
    const dir = tempDir();
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "untouched");
    const path = join(dir, "owner.json");
    symlinkSync(victim, path);
    expect(() => writeDurableFileSync(path, "clobber")).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(readFileSync(victim, "utf8")).toBe("untouched");
  });
});
