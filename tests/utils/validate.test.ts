import { describe, expect, it } from "bun:test";
import { clampPositive, redactUrl } from "../../src/utils/validate.js";

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

describe("redactUrl", () => {
  it("masks user:pass, bare user and each sensitive query param", () => {
    expect(redactUrl("http://u:p@h/x")).toBe("http://***:***@h/x");
    expect(redactUrl("http://tokenvalue@h/x")).toBe("http://***@h/x");
    expect(
      redactUrl(
        "http://h/x?key=1&API_KEY=2&token=3&access_token=4&secret=5&password=6&signature=7&q=ok#frag",
      ),
    ).toBe(
      "http://h/x?key=***&API_KEY=***&token=***&access_token=***&secret=***&password=***&signature=***&q=ok#frag",
    );
  });

  it("leaves clean URLs and non-URL text untouched", () => {
    expect(redactUrl("http://localhost:11434/v1")).toBe(
      "http://localhost:11434/v1",
    );
    expect(redactUrl("not-a-url")).toBe("not-a-url");
    expect(redactUrl("http://h/?monkey=banana")).toBe(
      "http://h/?monkey=banana",
    );
  });

  it("masks credentials in malformed URLs (slash in the password, no scheme, fragment)", () => {
    expect(redactUrl("https://u:pa/ss@host")).toBe("https://***:***@host");
    expect(redactUrl("not a url user:secret@host")).toBe(
      "not a url ***:***@host",
    );
    expect(redactUrl("https://host/v1#sig=zz&x=1")).toBe(
      "https://host/v1#sig=***&x=1",
    );
    expect(redactUrl("https://u:p@ss@host/v1")).toBe("https://***:***@host/v1");
  });
});
