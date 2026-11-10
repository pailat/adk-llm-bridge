import { describe, expect, test } from "bun:test";
import { uriScheme } from "../../src/utils/uri.js";

describe("uriScheme", () => {
  test.each([
    ["data:image/png;base64,iVBORw0KGgo=", "data"],
    ["gs://bucket/private/path.pdf", "gs"],
    ["https://example.com/a.png", "https"],
    ["file:///etc/passwd", "file"],
  ])("returns only the scheme of %s", (uri, scheme) => {
    expect(uriScheme(uri)).toBe(scheme);
  });

  test("never returns the payload or path after the scheme", () => {
    const uri = "data:text/plain;base64,c2VjcmV0";
    expect(uriScheme(uri)).not.toContain("c2VjcmV0");
    expect(uriScheme("gs://bucket/secret")).not.toContain("bucket");
  });

  test.each([
    ["no colon", "relative/path.png"],
    ["leading colon", ":data"],
    ["empty string", ""],
  ])("returns unknown for %s", (_label, uri) => {
    expect(uriScheme(uri)).toBe("unknown");
  });
});
