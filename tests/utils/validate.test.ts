import { describe, expect, it } from "bun:test";
import { clampPositive } from "../../src/utils/validate.js";

describe("clampPositive", () => {
  it("returns value when above min", () => {
    expect(clampPositive(5000, 3000, 1000)).toBe(5000);
  });

  it("clamps to min when below", () => {
    expect(clampPositive(500, 3000, 1000)).toBe(1000);
  });

  it("uses fallback for NaN", () => {
    expect(clampPositive(Number.NaN, 3000, 1000)).toBe(3000);
  });

  it("uses fallback for Infinity", () => {
    expect(clampPositive(Number.POSITIVE_INFINITY, 3000, 1000)).toBe(3000);
  });

  it("defaults min to 0", () => {
    expect(clampPositive(-5, 10)).toBe(0);
  });

  it("allows zero when min is 0", () => {
    expect(clampPositive(0, 10, 0)).toBe(0);
  });
});
