import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  isPathAllowed,
  normalizeAllowedDirectory,
  parseArchitectureAnalysisPaths,
} from "../../examples/external-agents/config.js";

describe("external-agents path config", () => {
  test("accepts, normalizes, and deduplicates absolute directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "external-agent-paths-"));
    try {
      expect(parseArchitectureAnalysisPaths(`${dir}, ${dir}`)).toEqual([
        realpathSync(dir),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects relative paths", () => {
    expect(() => parseArchitectureAnalysisPaths("relative/path")).toThrow(
      /absolute paths/,
    );
  });

  test("rejects missing paths", () => {
    expect(() => parseArchitectureAnalysisPaths("/definitely/missing/path")).toThrow(
      /does not exist/,
    );
  });

  test("rejects files", () => {
    const dir = mkdtempSync(join(tmpdir(), "external-agent-file-"));
    const file = join(dir, "file.txt");
    writeFileSync(file, "not a directory");
    try {
      expect(() => normalizeAllowedDirectory(file)).toThrow(/must be directories/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("checks requested paths by real directory containment", () => {
    const root = mkdtempSync(join(tmpdir(), "external-agent-root-"));
    const child = join(root, "child");
    const sibling = mkdtempSync(join(tmpdir(), "external-agent-root-sibling-"));
    mkdirSync(child);
    try {
      const allowed = [realpathSync(root)];
      expect(isPathAllowed(root, allowed)).toBe(true);
      expect(isPathAllowed(child, allowed)).toBe(true);
      expect(isPathAllowed(sibling, allowed)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});
