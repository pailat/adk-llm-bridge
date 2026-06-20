/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { Content, Part } from "@google/genai";

/**
 * Anthropic ContentBlockParam variant subset we emit. The full union from
 * `@anthropic-ai/sdk/resources/messages` is much broader, but we only use a
 * handful of block kinds when translating ADK history into Claude messages.
 */
export type ClaudeBase64ImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

export type ClaudeBase64ImageSource = {
  type: "base64";
  media_type: ClaudeBase64ImageMediaType;
  data: string;
};

export type ClaudeURLImageSource = {
  type: "url";
  url: string;
};

export type ClaudeBase64PDFSource = {
  type: "base64";
  media_type: "application/pdf";
  data: string;
};

export type ClaudeURLDocumentSource = {
  type: "url";
  url: string;
};

export type ClaudeTextBlockParam = { type: "text"; text: string };
export type ClaudeImageBlockParam = {
  type: "image";
  source: ClaudeBase64ImageSource | ClaudeURLImageSource;
};
export type ClaudeDocumentBlockParam = {
  type: "document";
  source: ClaudeBase64PDFSource | ClaudeURLDocumentSource;
};
export type ClaudeToolUseBlockParam = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type ClaudeToolResultBlockParam = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

export type ClaudeContentBlockParam =
  | ClaudeTextBlockParam
  | ClaudeImageBlockParam
  | ClaudeDocumentBlockParam
  | ClaudeToolUseBlockParam
  | ClaudeToolResultBlockParam;

export type ClaudeMessageParam = {
  role: "user" | "assistant";
  content: ClaudeContentBlockParam[];
};

/**
 * Minimal structural type matching `SDKUserMessage` from
 * `@anthropic-ai/claude-agent-sdk`. We avoid importing the SDK type directly
 * because the SDK is an optional dependency.
 */
export type SDKUserMessage = {
  type: "user";
  message: ClaudeMessageParam;
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  shouldQuery?: boolean;
};

const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/**
 * Translate ADK history (`Content[]`) into a sequence of Claude SDK user
 * messages with native multimodal `ContentBlockParam` blocks. The final
 * emitted message is marked `shouldQuery: true` so the SDK triggers an
 * assistant turn; preceding messages are appended as synthetic transcript
 * entries.
 */
export function contentsToSdkMessages(
  contents: ReadonlyArray<Content>,
): SDKUserMessage[] {
  const messages: SDKUserMessage[] = [];

  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    let role: "user" | "assistant" = content.role === "model" ? "assistant" : "user";
    const blocks: ClaudeContentBlockParam[] = [];

    const parts = content.parts ?? [];
    let hasFunctionCall = false;
    let hasFunctionResponse = false;
    for (const part of parts) {
      if (part.functionCall) hasFunctionCall = true;
      if (part.functionResponse) hasFunctionResponse = true;
    }
    if (hasFunctionResponse) {
      role = "user";
    } else if (hasFunctionCall) {
      role = "assistant";
    }

    for (let p = 0; p < parts.length; p++) {
      const block = mapPart(parts[p], i, p);
      if (block) {
        blocks.push(block);
      }
    }

    if (blocks.length === 0) {
      continue;
    }

    messages.push({
      type: "user",
      parent_tool_use_id: null,
      message: { role, content: blocks },
    });
  }

  if (messages.length === 0) {
    return messages;
  }

  for (let i = 0; i < messages.length - 1; i++) {
    messages[i].isSynthetic = true;
    messages[i].shouldQuery = false;
  }
  messages[messages.length - 1].shouldQuery = true;

  return messages;
}

function mapPart(
  part: Part,
  contentIndex: number,
  partIndex: number,
): ClaudeContentBlockParam | undefined {
  if (part.thought) {
    return undefined;
  }
  if (typeof part.text === "string" && part.text.length > 0) {
    return { type: "text", text: part.text };
  }
  if (part.inlineData) {
    const mime = part.inlineData.mimeType ?? "application/octet-stream";
    const data = part.inlineData.data ?? "";
    if (IMAGE_MEDIA_TYPES.has(mime)) {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: mime as ClaudeBase64ImageMediaType,
          data,
        },
      };
    }
    if (mime === "application/pdf") {
      return {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data },
      };
    }
    return { type: "text", text: `[document: ${mime}]` };
  }
  if (part.fileData) {
    const uri = part.fileData.fileUri ?? "<unknown>";
    const mime = part.fileData.mimeType ?? "application/octet-stream";
    if (uri.startsWith("http://") || uri.startsWith("https://")) {
      return { type: "document", source: { type: "url", url: uri } };
    }
    return { type: "text", text: `[file: ${uri} (${mime})]` };
  }
  if (part.functionCall) {
    const id = part.functionCall.id ?? generatedId(contentIndex, partIndex);
    return {
      type: "tool_use",
      id,
      name: part.functionCall.name ?? "<unknown>",
      input: (part.functionCall.args ?? {}) as Record<string, unknown>,
    };
  }
  if (part.functionResponse) {
    const id = part.functionResponse.id ?? generatedId(contentIndex, partIndex);
    return {
      type: "tool_result",
      tool_use_id: id,
      content: stringifyFunctionResponse(part.functionResponse.response),
    };
  }
  if (part.executableCode) {
    const lang = part.executableCode.language ?? "PLAINTEXT";
    const code = part.executableCode.code ?? "";
    return { type: "text", text: `[code (${lang}): ${code}]` };
  }
  if (part.codeExecutionResult) {
    const outcome = part.codeExecutionResult.outcome ?? "OUTCOME_UNSPECIFIED";
    const output = part.codeExecutionResult.output ?? "";
    return { type: "text", text: `[exec ${outcome}: ${output}]` };
  }
  return undefined;
}

function generatedId(contentIndex: number, partIndex: number): string {
  return `tool_${contentIndex}_${partIndex}`;
}

function stringifyFunctionResponse(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
