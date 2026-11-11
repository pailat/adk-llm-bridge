import { describe, expect, test } from "bun:test";
import { findExecutable } from "../../../src/agents/driver/shared.js";

describe("findExecutable with a lazy candidate list", () => {
  test("an explicit path wins without building the candidates", () => {
    let built = 0;
    const result = findExecutable([undefined, "/opt/claude"], () => {
      built++;
      return ["/bin/sh"];
    });
    expect(result).toEqual({ path: "/opt/claude", checked: ["/opt/claude"] });
    expect(built).toBe(0);
  });

  test("without an explicit path the candidates are built once and probed in order", () => {
    let built = 0;
    const result = findExecutable([undefined, ""], () => {
      built++;
      return ["/does/not/exist", "/bin/sh", "/z"];
    });
    expect(result).toEqual({
      path: "/bin/sh",
      checked: ["/does/not/exist", "/bin/sh"],
    });
    expect(built).toBe(1);
  });
});
