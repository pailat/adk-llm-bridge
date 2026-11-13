import { promises as fs, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Content, Part } from "@google/genai";

// The cold-start transcript lives with the content collector so every
// driver without native resume renders history the same way.
export { summarizeHistoryForColdStart } from "../runtime/content-collector.js";

/** One part of a multi-part Codex input: text, or an image file on disk. */
export type CodexInputPart =
  | { type: "text"; text: string }
  | { type: "local_image"; path: string };

/** The Codex input for one turn, and how to release its temporary files. */
export interface CodexInputMapping {
  /** A plain string for a text-only turn, otherwise the list of parts. */
  input: string | CodexInputPart[];
  /** Removes the private directory that holds the temporary image files; best-effort, never rejects. Call it when the turn ends. */
  cleanup: () => Promise<void>;
}

/** Options for {@link userContentToCodexInput}. */
export interface CodexInputMapperOptions {
  /**
   * Parent directory for the temporary image files.
   *
   * @remarks
   * Each mapping with images creates its own private directory under it
   * (mode `0o700`) and writes the files there; `cleanup` removes that
   * directory.
   *
   * @defaultValue The operating system temp directory.
   */
  tmpDir?: string;
  /**
   * Prefix of the temporary file names (`codex-<prefix>-<index>.<ext>`).
   *
   * @remarks
   * Characters other than letters, digits, `_` and `-` are replaced with
   * `_`, so the prefix cannot name another directory. Files never collide
   * across mappings, because each mapping has its own directory.
   *
   * @defaultValue "turn"
   */
  idPrefix?: string;
}

const noopCleanup: () => Promise<void> = async () => {};

/**
 * Converts an ADK `Content` (the current user turn) into Codex SDK input.
 *
 * @remarks
 * Codex accepts either a string or an array of text and `local_image` parts.
 * Inline images are written to temporary files in a private directory
 * created for this mapping (so the caller must call `cleanup`, which removes
 * the directory). Each file is created new with mode `0o600` and never
 * follows an existing file or symbolic link. Thought parts are dropped; other
 * parts (file URIs, tool calls and responses, code) are flattened into short
 * text markers such as `[tool_call name(args)]`, the same style as the
 * history transcript. A write failure degrades to a text marker instead of
 * throwing. If the mapping throws anyway (a malformed part), the directory is
 * removed before the error propagates.
 *
 * @param content - The user turn.
 * @param opts - Temporary file location and naming.
 * @returns The input and a cleanup function for the temporary files.
 */
export function userContentToCodexInput(
  content: Content,
  opts: CodexInputMapperOptions = {},
): CodexInputMapping {
  const parts = content.parts ?? [];
  const tmpDir = opts.tmpDir ?? tmpdir();
  const idPrefix = (opts.idPrefix ?? "turn").replace(/[^A-Za-z0-9_-]/g, "_");

  // Fast path: a single text part becomes a string (Codex's preferred shape).
  if (parts.length === 1) {
    const only = parts[0];
    if (typeof only.text === "string" && isPlainText(only)) {
      return { input: only.text, cleanup: noopCleanup };
    }
  }

  // Created on the first image only, so text-only turns touch no disk.
  let runDir: string | undefined;
  const result: CodexInputPart[] = [];

  const mapPart = (part: Part, index: number): void => {
    if (part.thought) {
      return;
    }
    if (typeof part.text === "string" && part.text.length > 0) {
      result.push({ type: "text", text: part.text });
      return;
    }
    if (part.inlineData) {
      const mime =
        typeof part.inlineData.mimeType === "string"
          ? part.inlineData.mimeType
          : "application/octet-stream";
      if (
        mime.startsWith("image/") &&
        typeof part.inlineData.data === "string"
      ) {
        const ext = extensionForMime(mime);
        try {
          // mkdtemp makes an unpredictable directory with mode 0o700, so other
          // users cannot pre-create or swap the files inside it.
          runDir ??= mkdtempSync(join(tmpDir, "codex-input-"));
          const path = join(runDir, `codex-${idPrefix}-${index}.${ext}`);
          const bytes = Buffer.from(part.inlineData.data, "base64");
          // `wx` fails on any existing entry, symbolic links included. The
          // synchronous write keeps the API non-async; the file count is small.
          writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
          result.push({ type: "local_image", path });
        } catch {
          result.push({
            type: "text",
            text: `[image: ${mime} (write failed)]`,
          });
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
  };

  try {
    parts.forEach(mapPart);
  } catch (error) {
    // No cleanup reaches the caller on a throw: remove the images here.
    if (runDir !== undefined) {
      rmSync(runDir, { recursive: true, force: true });
    }
    throw error;
  }

  const dir = runDir;
  const cleanup =
    dir === undefined
      ? noopCleanup
      : async (): Promise<void> => {
          try {
            await fs.rm(dir, { recursive: true, force: true });
          } catch {
            // best-effort: a failed removal must not mask the turn result.
          }
        };

  // If everything filtered out (e.g. only thoughts), keep an empty text block
  // so Codex still gets a valid input.
  if (result.length === 0) {
    return { input: "", cleanup };
  }

  // Collapse single-text result back to string form.
  if (result.length === 1 && result[0].type === "text") {
    return { input: result[0].text, cleanup };
  }

  return { input: result, cleanup };
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
