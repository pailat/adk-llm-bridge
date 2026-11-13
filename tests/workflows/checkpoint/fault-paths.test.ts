import { describe, expect, test } from "bun:test";
import {
  isLockOwnerPath,
  isLockPath,
  samePath,
} from "./fixtures/fault-paths.js";

// The fault fixture acts when the store touches a lock path. Windows paths use
// backslashes; a check that only knows `/` never fires there.
describe("fault fixture path checks", () => {
  test("a lock owner file matches with either separator", () => {
    expect(isLockOwnerPath("/tmp/r/ab/abcd.json.lock/owner.json")).toBe(true);
    expect(isLockOwnerPath("C:\\r\\ab\\abcd.json.lock\\owner.json")).toBe(true);
  });

  test("other files are not a lock owner file", () => {
    expect(isLockOwnerPath("C:\\r\\ab\\abcd.json")).toBe(false);
    expect(isLockOwnerPath("C:\\r\\ab\\abcd.json.lock")).toBe(false);
    expect(isLockOwnerPath("/tmp/r/ab/abcd.json.lock/other.json")).toBe(false);
  });

  test("a lock path matches with either separator", () => {
    expect(isLockPath("/tmp/r/ab/abcd.json.lock")).toBe(true);
    expect(isLockPath("C:\\r\\ab\\abcd.json.lock")).toBe(true);
    expect(isLockPath("C:\\r\\ab\\abcd.json.lock\\owner.json")).toBe(true);
    expect(isLockPath("C:\\r\\ab\\abcd.json")).toBe(false);
  });

  test("the same path matches across separators, a different one does not", () => {
    expect(samePath("C:\\r\\ab\\x.json.lock", "C:/r/ab/x.json.lock")).toBe(
      true,
    );
    expect(samePath("C:\\r\\ab\\x.json.lock", "C:\\r\\ab\\y.json.lock")).toBe(
      false,
    );
  });
});
