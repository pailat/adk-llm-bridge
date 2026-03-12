import { describe, expect, it } from "bun:test";
import {
  clampPositive,
  requireNonEmpty,
  requireValidURL,
} from "../../src/utils/validate";

describe("requireNonEmpty", () => {
  it("returns value when non-empty", () => {
    expect(requireNonEmpty("hello", "field", "test")).toBe("hello");
  });

  it("throws on empty string", () => {
    expect(() => requireNonEmpty("", "apiKey", "provider")).toThrow(
      "[provider] apiKey is required but was empty",
    );
  });

  it("throws on whitespace-only string", () => {
    expect(() => requireNonEmpty("   ", "apiKey", "provider")).toThrow(
      "[provider] apiKey is required but was empty",
    );
  });
});

describe("requireValidURL", () => {
  it("returns value for valid HTTP URL", () => {
    expect(
      requireValidURL("http://localhost:11434/v1", "baseURL", "test"),
    ).toBe("http://localhost:11434/v1");
  });

  it("returns value for valid HTTPS URL", () => {
    expect(
      requireValidURL("https://api.example.com/v1", "baseURL", "test"),
    ).toBe("https://api.example.com/v1");
  });

  it("throws on invalid URL", () => {
    expect(() =>
      requireValidURL("not-a-url", "baseURL", "custom"),
    ).toThrow('[custom] Invalid baseURL: "not-a-url"');
  });

  it("throws on empty string", () => {
    expect(() => requireValidURL("", "baseURL", "custom")).toThrow(
      "[custom] Invalid baseURL",
    );
  });
});

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
