/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { promises as fs, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Content, Part } from "@google/genai";
import { flattenContentsToPrompt } from "../runtime/content-collector.js";

export type CodexInputPart =
  | { type: "text"; text: string }
  | { type: "local_image"; path: string };

export interface CodexInputMapping {
  input: string | CodexInputPart[];
  cleanup: () => Promise<void>;
}

export interface CodexInputMapperOptions {
  tmpDir?: string;
  idPrefix?: string;
}

const noopCleanup: () => Promise<void> = async () => {};

/**
 * Convert an ADK Content (the current user turn) into Codex SDK input.
 *
 * Codex accepts either a string or an array of text / local_image parts.
 * Non-text/image parts (file URIs, tool calls/responses, code) are flattened
 * into short text markers that mirror Phase-1's transcript style.
 */
export function userContentToCodexInput(
  content: Content,
  opts: CodexInputMapperOptions = {},
): CodexInputMapping {
  const parts = content.parts ?? [];
  const tmpDir = opts.tmpDir ?? tmpdir();
  const idPrefix = opts.idPrefix ?? "turn";

  // Fast path: a single text part becomes a string (Codex's preferred shape).
  if (parts.length === 1) {
    const only = parts[0];
    if (typeof only.text === "string" && isPlainText(only)) {
      return { input: only.text, cleanup: noopCleanup };
    }
  }

  const tmpFiles: string[] = [];
  const result: CodexInputPart[] = [];

  parts.forEach((part, index) => {
    if (part.thought) {
      return;
    }
    if (typeof part.text === "string" && part.text.length > 0) {
      result.push({ type: "text", text: part.text });
      return;
    }
    if (part.inlineData) {
      const mime = part.inlineData.mimeType ?? "application/octet-stream";
      if (mime.startsWith("image/") && typeof part.inlineData.data === "string") {
        const ext = extensionForMime(mime);
        const path = join(tmpDir, `codex-${idPrefix}-${index}.${ext}`);
        try {
          const bytes = Buffer.from(part.inlineData.data, "base64");
          // Synchronous write keeps the API non-async; the file count is small.
          writeFileSync(path, bytes);
          tmpFiles.push(path);
          result.push({ type: "local_image", path });
        } catch {
          result.push({ type: "text", text: `[image: ${mime} (write failed)]` });
        }
        return;
      }
      result.push({ type: "text", text: markerForInlineData(mime) });
      return;
    }
    if (part.fileData) {
      const mime = part.fileData.mimeType ?? "application/octet-stream";
      const uri = part.fileData.fileUri ?? "<unknown>";
      result.push({ type: "text", text: `[file: ${uri} (${mime})]` });
      return;
    }
    if (part.functionCall) {
      const name = part.functionCall.name ?? "<unknown>";
      const args = part.functionCall.args ?? {};
      result.push({
        type: "text",
        text: `[tool_call ${name}(${safeJsonStringify(args)})]`,
      });
      return;
    }
    if (part.functionResponse) {
      const name = part.functionResponse.name ?? "<unknown>";
      const response = part.functionResponse.response ?? {};
      result.push({
        type: "text",
        text: `[tool_result ${name}: ${safeJsonStringify(response)}]`,
      });
      return;
    }
    if (part.executableCode) {
      const lang = part.executableCode.language ?? "PLAINTEXT";
      const code = part.executableCode.code ?? "";
      result.push({ type: "text", text: `[code (${lang}): ${code}]` });
      return;
    }
    if (part.codeExecutionResult) {
      const outcome = part.codeExecutionResult.outcome ?? "OUTCOME_UNSPECIFIED";
      const output = part.codeExecutionResult.output ?? "";
      result.push({ type: "text", text: `[exec ${outcome}: ${output}]` });
      return;
    }
    result.push({ type: "text", text: "[unsupported-part]" });
  });

  // If everything filtered out (e.g. only thoughts), keep an empty text block
  // so Codex still gets a valid input.
  if (result.length === 0) {
    return { input: "", cleanup: noopCleanup };
  }

  // Collapse single-text result back to string form.
  if (result.length === 1 && result[0].type === "text") {
    return { input: result[0].text, cleanup: noopCleanup };
  }

  const cleanup = async (): Promise<void> => {
    await Promise.all(
      tmpFiles.map(async (path) => {
        try {
          await fs.unlink(path);
        } catch {
          // best-effort: swallow ENOENT and other transient errors.
        }
      }),
    );
  };

  return { input: result, cleanup };
}

/**
 * Render every content except the last (the current user turn) into a textual
 * transcript suitable for prepending to a fresh Codex thread when no saved
 * thread id exists. Returns "" when there is no prior history.
 */
export function summarizeHistoryForColdStart(
  contents: ReadonlyArray<Content>,
): string {
  if (contents.length <= 1) {
    return "";
  }
  return flattenContentsToPrompt(contents.slice(0, -1));
}

// --- helpers ---------------------------------------------------------------

function isPlainText(part: Part): boolean {
  return !(
    part.inlineData ||
    part.fileData ||
    part.functionCall ||
    part.functionResponse ||
    part.executableCode ||
    part.codeExecutionResult ||
    part.thought
  );
}

function extensionForMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower === "image/png") return "png";
  if (lower === "image/jpeg" || lower === "image/jpg") return "jpg";
  if (lower === "image/gif") return "gif";
  if (lower === "image/webp") return "webp";
  if (lower === "image/bmp") return "bmp";
  if (lower === "image/svg+xml") return "svg";
  const slash = lower.indexOf("/");
  if (slash >= 0 && slash < lower.length - 1) {
    return lower.slice(slash + 1).replace(/[^a-z0-9]+/g, "") || "bin";
  }
  return "bin";
}

function markerForInlineData(mime: string): string {
  if (mime.startsWith("image/")) return `[image: ${mime}]`;
  if (mime.startsWith("audio/")) return `[audio: ${mime}]`;
  if (mime.startsWith("video/")) return `[video: ${mime}]`;
  return `[document: ${mime}]`;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}
