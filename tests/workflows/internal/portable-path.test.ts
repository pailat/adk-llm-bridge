import { describe, expect, test } from "bun:test";
import {
  MAX_PORTABLE_PATH_LENGTH,
  normalizePortablePath,
  portablePathContains,
  portablePathProblem,
} from "../../../src/workflows/internal/portable-path.js";
import { validateWorkflowPath } from "../../../src/workflows/orchestration/json.js";
import { normalizeWorkspacePath } from "../../../src/workflows/workspace/workspace-adapter.js";

const REJECTED_EVERYWHERE: ReadonlyArray<readonly [string, string]> = [
  ["", "must be a non-empty string"],
  ["   ", "must be a non-empty string"],
  ["a\0b", "must not contain NUL characters"],
  ["/etc/passwd", "must be relative"],
  ["C:/repo", "must be relative"],
  ["c:repo", "must be relative"],
  ["C:\\repo", "must be relative"],
  ["src\\file.ts", "must use forward slashes"],
  ["..", "must not traverse parent directories"],
  ["src/../secret", "must not traverse parent directories"],
  ["x".repeat(MAX_PORTABLE_PATH_LENGTH + 1), "must be at most 4096 characters"],
];

describe("portable paths", () => {
  test.each(REJECTED_EVERYWHERE)(
    "rejects %j in every form",
    (input, reason) => {
      expect(portablePathProblem(input)).toBe(reason);
      expect(portablePathProblem(input, { allowRoot: true })).toBe(reason);
      expect(portablePathProblem(input, { canonical: true })).toBe(reason);
      expect(() => normalizeWorkspacePath(input)).toThrow(reason);
      expect(() => validateWorkflowPath(input)).toThrow(
        "must be a normalized repository-relative path",
      );
    },
  );

  test("normalizes alternate spellings to the canonical form", () => {
    expect(normalizePortablePath("./src//a/./b/")).toBe("src/a/b");
    expect(normalizePortablePath("src/a")).toBe("src/a");
    expect(normalizePortablePath("./", { allowRoot: true })).toBe(".");
    expect(normalizeWorkspacePath(".")).toBe(".");
  });

  test("the strict form accepts only the canonical spelling", () => {
    for (const spelling of ["./src", "src//a", "src/", "src/./a"]) {
      expect(portablePathProblem(spelling, { canonical: true })).toBe(
        "must be canonical",
      );
      expect(() => validateWorkflowPath(spelling)).toThrow(
        "must be a normalized repository-relative path",
      );
    }
    expect(portablePathProblem("src/a", { canonical: true })).toBeUndefined();
    expect(
      portablePathProblem(".", { canonical: true, allowRoot: true }),
    ).toBeUndefined();
    expect(
      portablePathProblem("./", { canonical: true, allowRoot: true }),
    ).toBe("must be canonical");
  });

  test("the root is accepted only when asked for", () => {
    expect(portablePathProblem(".")).toBe(
      "must identify an entry below the root",
    );
    expect(() => normalizePortablePath(".")).toThrow(TypeError);
    expect(() => validateWorkflowPath(".")).toThrow();
  });

  test("names that only look special are kept", () => {
    expect(normalizePortablePath("...")).toBe("...");
    expect(normalizePortablePath("ab:c")).toBe("ab:c");
    expect(normalizePortablePath("src/c:d")).toBe("src/c:d");
    expect(normalizePortablePath(" a ")).toBe(" a ");
  });

  test("containment works on canonical paths", () => {
    expect(portablePathContains(".", "src/a")).toBe(true);
    expect(portablePathContains("src", "src/a")).toBe(true);
    expect(portablePathContains("src", "src")).toBe(true);
    expect(portablePathContains("src", "srcs/a")).toBe(false);
  });
});
