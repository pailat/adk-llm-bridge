import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  summarizeHistoryForColdStart,
  userContentToCodexInput,
} from "../../../src/agents/driver/codex-input-mapper.js";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function freshTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "codex-mapper-test-"));
}

describe("userContentToCodexInput", () => {
  test("single text part becomes a plain string with a no-op cleanup", async () => {
    const mapping = userContentToCodexInput({
      role: "user",
      parts: [{ text: "hello" }],
    });
    expect(mapping.input).toBe("hello");
    // cleanup is safe even when no tmp files exist.
    await mapping.cleanup();
  });

  test("two text parts produce an array of two text entries", async () => {
    const mapping = userContentToCodexInput({
      role: "user",
      parts: [{ text: "alpha" }, { text: "beta" }],
    });
    expect(mapping.input).toEqual([
      { type: "text", text: "alpha" },
      { type: "text", text: "beta" },
    ]);
    await mapping.cleanup();
  });

  test("PNG inlineData writes a tmp file and cleanup removes it", async () => {
    const dir = freshTmpDir();
    const mapping = userContentToCodexInput(
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "image/png",
              data: PNG_BYTES.toString("base64"),
            },
          },
          { text: "describe" },
        ],
      },
      { tmpDir: dir, idPrefix: "png" },
    );

    expect(Array.isArray(mapping.input)).toBe(true);
    const parts = mapping.input as Array<
      { type: "text"; text: string } | { type: "local_image"; path: string }
    >;
    expect(parts[0].type).toBe("local_image");
    const imagePath = (parts[0] as { path: string }).path;
    expect(imagePath.endsWith(".png")).toBe(true);
    expect(existsSync(imagePath)).toBe(true);
    expect(readFileSync(imagePath)).toEqual(PNG_BYTES);

    await mapping.cleanup();
    expect(existsSync(imagePath)).toBe(false);
  });

  test("JPEG inlineData uses a .jpg extension", async () => {
    const dir = freshTmpDir();
    const mapping = userContentToCodexInput(
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "image/jpeg",
              data: JPEG_BYTES.toString("base64"),
            },
          },
        ],
      },
      { tmpDir: dir, idPrefix: "jpeg" },
    );

    const parts = mapping.input as Array<{ type: string; path?: string }>;
    expect(parts[0].type).toBe("local_image");
    expect(parts[0].path?.endsWith(".jpg")).toBe(true);
    await mapping.cleanup();
  });

  test("mixed text + image preserves input order", async () => {
    const dir = freshTmpDir();
    const mapping = userContentToCodexInput(
      {
        role: "user",
        parts: [
          { text: "before" },
          {
            inlineData: {
              mimeType: "image/png",
              data: PNG_BYTES.toString("base64"),
            },
          },
          { text: "after" },
        ],
      },
      { tmpDir: dir, idPrefix: "mix" },
    );
    const parts = mapping.input as Array<{ type: string }>;
    expect(parts.map((p) => p.type)).toEqual(["text", "local_image", "text"]);
    await mapping.cleanup();
  });

  test("fileData becomes a [file: ...] marker", () => {
    const mapping = userContentToCodexInput({
      role: "user",
      parts: [
        {
          fileData: {
            mimeType: "application/pdf",
            fileUri: "gs://bucket/doc.pdf",
          },
        },
        { text: "summarize" },
      ],
    });
    const parts = mapping.input as Array<{ type: string; text?: string }>;
    expect(parts[0].text).toBe("[file: gs://bucket/doc.pdf (application/pdf)]");
  });

  test("functionCall becomes a [tool_call ...] marker", () => {
    const mapping = userContentToCodexInput({
      role: "user",
      parts: [
        { functionCall: { name: "search", args: { q: "ADK" } } },
        { text: "go" },
      ],
    });
    const parts = mapping.input as Array<{ type: string; text?: string }>;
    expect(parts[0].text).toBe(`[tool_call search({"q":"ADK"})]`);
  });

  test("thought parts are dropped", () => {
    const mapping = userContentToCodexInput({
      role: "user",
      parts: [
        { text: "reasoning omitted", thought: true },
        { text: "ask" },
      ],
    });
    expect(mapping.input).toBe("ask");
  });
});

describe("summarizeHistoryForColdStart", () => {
  test("returns empty string for an empty list", () => {
    expect(summarizeHistoryForColdStart([])).toBe("");
  });

  test("includes all roles except the last current-turn content", () => {
    const transcript = summarizeHistoryForColdStart([
      { role: "user", parts: [{ text: "Q1" }] },
      { role: "model", parts: [{ text: "A1" }] },
      { role: "user", parts: [{ text: "Q2 (current)" }] },
    ]);
    expect(transcript).toContain("Q1");
    expect(transcript).toContain("A1");
    expect(transcript).not.toContain("Q2 (current)");
  });
});
