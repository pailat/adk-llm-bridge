/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import type { Content } from "@google/genai";
import {
  type ClaudeDocumentBlockParam,
  type ClaudeImageBlockParam,
  type ClaudeTextBlockParam,
  contentsToSdkMessages,
} from "../../../src/agents/driver/claude-message-mapper.js";

describe("contentsToSdkMessages", () => {
  test("single text-only user content emits one message with shouldQuery", () => {
    const contents: Content[] = [
      { role: "user", parts: [{ text: "hello" }] },
    ];
    const messages = contentsToSdkMessages(contents);
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message.type).toBe("user");
    expect(message.parent_tool_use_id).toBeNull();
    expect(message.shouldQuery).toBe(true);
    expect(message.isSynthetic).toBeUndefined();
    expect(message.message.role).toBe("user");
    expect(message.message.content).toEqual([{ type: "text", text: "hello" }]);
  });

  test("multi-turn history marks earlier messages synthetic and last shouldQuery", () => {
    const contents: Content[] = [
      { role: "user", parts: [{ text: "first" }] },
      { role: "model", parts: [{ text: "reply" }] },
    ];
    const messages = contentsToSdkMessages(contents);
    expect(messages).toHaveLength(2);
    expect(messages[0].isSynthetic).toBe(true);
    expect(messages[0].shouldQuery).toBe(false);
    expect(messages[0].message.role).toBe("user");
    expect(messages[1].shouldQuery).toBe(true);
    expect(messages[1].isSynthetic).toBeUndefined();
    // USER-ONLY: even a model turn is emitted as a user-role message because
    // the SDK streaming-input channel rejects assistant-role input messages.
    expect(messages[1].message.role).toBe("user");
  });

  test("mixed history [user, model, user] never emits an assistant-role message", () => {
    const contents: Content[] = [
      { role: "user", parts: [{ text: "first" }] },
      { role: "model", parts: [{ text: "reply" }] },
      { role: "user", parts: [{ text: "second" }] },
    ];
    const messages = contentsToSdkMessages(contents);
    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message.message.role).toBe("user");
    }
  });

  test("inlineData PNG becomes base64 image block", () => {
    const contents: Content[] = [
      {
        role: "user",
        parts: [
          {
            inlineData: { mimeType: "image/png", data: "AAAA" },
          },
        ],
      },
    ];
    const [message] = contentsToSdkMessages(contents);
    const block = message.message.content[0] as ClaudeImageBlockParam;
    expect(block.type).toBe("image");
    expect(block.source.type).toBe("base64");
    if (block.source.type === "base64") {
      expect(block.source.media_type).toBe("image/png");
      expect(block.source.data).toBe("AAAA");
    }
  });

  test("inlineData PDF becomes base64 document block", () => {
    const contents: Content[] = [
      {
        role: "user",
        parts: [
          {
            inlineData: { mimeType: "application/pdf", data: "BBBB" },
          },
        ],
      },
    ];
    const [message] = contentsToSdkMessages(contents);
    const block = message.message.content[0] as ClaudeDocumentBlockParam;
    expect(block.type).toBe("document");
    expect(block.source.type).toBe("base64");
    if (block.source.type === "base64") {
      expect(block.source.media_type).toBe("application/pdf");
      expect(block.source.data).toBe("BBBB");
    }
  });

  test("fileData with https URL becomes URL document block", () => {
    const contents: Content[] = [
      {
        role: "user",
        parts: [
          {
            fileData: {
              fileUri: "https://example.com/file.pdf",
              mimeType: "application/pdf",
            },
          },
        ],
      },
    ];
    const [message] = contentsToSdkMessages(contents);
    const block = message.message.content[0] as ClaudeDocumentBlockParam;
    expect(block.type).toBe("document");
    expect(block.source.type).toBe("url");
    if (block.source.type === "url") {
      expect(block.source.url).toBe("https://example.com/file.pdf");
    }
  });

  test("fileData with gs:// URI falls back to text marker", () => {
    const contents: Content[] = [
      {
        role: "user",
        parts: [
          {
            fileData: { fileUri: "gs://bucket/file.bin", mimeType: "application/octet-stream" },
          },
        ],
      },
    ];
    const [message] = contentsToSdkMessages(contents);
    const block = message.message.content[0] as ClaudeTextBlockParam;
    expect(block.type).toBe("text");
    expect(block.text).toBe("[file: gs://bucket/file.bin (application/octet-stream)]");
  });

  test("functionCall on model content renders user-role text (no tool_use block)", () => {
    const contents: Content[] = [
      {
        role: "model",
        parts: [
          { functionCall: { id: "call-1", name: "lookup", args: { q: "x" } } },
        ],
      },
    ];
    const [message] = contentsToSdkMessages(contents);
    // USER-ONLY: model tool-calls become user-role text markers, never an
    // assistant-role message nor an input `tool_use` block.
    expect(message.message.role).toBe("user");
    const block = message.message.content[0] as ClaudeTextBlockParam;
    expect(block.type).toBe("text");
    expect(block.text).toBe('[assistant tool-call lookup({"q":"x"})]');
    for (const b of message.message.content) {
      expect(b.type).not.toBe("tool_use");
    }
  });

  test("functionResponse renders user-role text (no orphan tool_result block)", () => {
    const contents: Content[] = [
      {
        role: "model",
        parts: [
          {
            functionResponse: {
              id: "call-1",
              name: "lookup",
              response: { value: 42 },
            },
          },
        ],
      },
    ];
    const [message] = contentsToSdkMessages(contents);
    expect(message.message.role).toBe("user");
    const block = message.message.content[0] as ClaudeTextBlockParam;
    expect(block.type).toBe("text");
    expect(block.text).toBe('[tool lookup result: {"value":42}]');
    for (const b of message.message.content) {
      expect(b.type).not.toBe("tool_result");
    }
  });

  test("thought parts are dropped", () => {
    const contents: Content[] = [
      {
        role: "model",
        parts: [
          { text: "kept" },
          { thought: true, text: "hidden" },
        ],
      },
    ];
    const [message] = contentsToSdkMessages(contents);
    expect(message.message.content).toEqual([{ type: "text", text: "kept" }]);
  });

  test("content with only thought parts is not emitted", () => {
    const contents: Content[] = [
      { role: "model", parts: [{ thought: true, text: "hidden" }] },
      { role: "user", parts: [{ text: "real" }] },
    ];
    const messages = contentsToSdkMessages(contents);
    expect(messages).toHaveLength(1);
    expect(messages[0].message.role).toBe("user");
  });

  test("functionCall without id renders deterministic user-role text", () => {
    const contents: Content[] = [
      {
        role: "model",
        parts: [{ functionCall: { name: "go", args: {} } }],
      },
    ];
    const first = contentsToSdkMessages(contents);
    const second = contentsToSdkMessages(contents);
    const blockA = first[0].message.content[0] as ClaudeTextBlockParam;
    const blockB = second[0].message.content[0] as ClaudeTextBlockParam;
    expect(blockA.type).toBe("text");
    expect(blockA.text).toBe("[assistant tool-call go({})]");
    expect(blockA.text).toBe(blockB.text);
  });
});
