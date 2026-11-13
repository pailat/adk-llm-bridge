import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { LlmRequest } from "@google/adk";
import { convertRequest } from "../../src/converters/request.js";
import { captureWarnings } from "../helpers/fake-logger.js";

// Pins the non-http fileData warning text and keeps the
// degradation matrix row in docs/openai-compatible-feature-matrix.md in sync.

function warningsFor(fileUri: string): string[] {
  const request = {
    contents: [
      {
        role: "user",
        parts: [
          { text: "hi" },
          { fileData: { mimeType: "image/png", fileUri } },
        ],
      },
    ],
    liveConnectConfig: {},
    toolsDict: {},
  } as unknown as LlmRequest;
  const spy = captureWarnings();
  try {
    convertRequest(request);
  } finally {
    spy.mockRestore();
  }
  return spy.mock.calls.map((c) => String(c[0]));
}

describe("non-http fileData warning", () => {
  it("emits the exact message with the scheme only", () => {
    const warns = warningsFor("gs://bucket/secret/img.png");
    const matches = warns.filter((w) =>
      w.includes("dropping non-http fileData URI"),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatch(
      /(?:^|\] )dropping non-http fileData URI \(scheme: gs\)$/,
    );
    expect(warns.join("\n")).not.toContain("bucket");
  });

  it("names other schemes the same way", () => {
    const warns = warningsFor("file:///etc/img.png");
    expect(
      warns.some((w) =>
        w.endsWith("dropping non-http fileData URI (scheme: file)"),
      ),
    ).toBe(true);
  });

  it("the feature matrix documents the current message", () => {
    const doc = readFileSync(
      new URL(
        "../../docs/openai-compatible-feature-matrix.md",
        import.meta.url,
      ),
      "utf8",
    );
    const row = doc
      .split("\n")
      .find((line) => line.includes("non-HTTP `fileData`"));
    expect(row).toBeDefined();
    expect(row).toContain("`dropping non-http fileData URI (scheme: X)`");
  });
});
