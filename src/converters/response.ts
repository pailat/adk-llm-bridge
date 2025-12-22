import type { LlmResponse } from "@google/adk";
import type { Part } from "@google/genai";
import type OpenAI from "openai";
import type { StreamAccumulator, StreamChunkResult } from "../types";

export function convertResponse(response: OpenAI.ChatCompletion): LlmResponse {
  const choice = response.choices[0];
  if (!choice) {
    return {
      errorCode: "NO_CHOICE",
      errorMessage: "No response choice",
      turnComplete: true,
    };
  }

  const parts: Part[] = [];

  if (choice.message.content) {
    parts.push({ text: choice.message.content });
  }

  for (const tc of choice.message.tool_calls ?? []) {
    parts.push({
      functionCall: {
        id: tc.id,
        name: tc.function.name,
        args: safeJsonParse(tc.function.arguments),
      },
    });
  }

  return {
    content: parts.length ? { role: "model", parts } : undefined,
    turnComplete: true,
    usageMetadata: response.usage
      ? {
          promptTokenCount: response.usage.prompt_tokens,
          candidatesTokenCount: response.usage.completion_tokens,
          totalTokenCount: response.usage.total_tokens,
        }
      : undefined,
  };
}

export function convertStreamChunk(
  chunk: OpenAI.ChatCompletionChunk,
  acc: StreamAccumulator,
): StreamChunkResult {
  const choice = chunk.choices[0];
  if (!choice) return { isComplete: false };

  const delta = choice.delta;

  if (delta?.content) {
    acc.text += delta.content;
    return {
      response: {
        content: { role: "model", parts: [{ text: delta.content }] },
        partial: true,
      },
      isComplete: false,
    };
  }

  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      let a = acc.toolCalls.get(idx);
      if (!a) {
        a = { id: "", name: "", arguments: "" };
        acc.toolCalls.set(idx, a);
      }
      if (tc.id) a.id = tc.id;
      if (tc.function?.name) a.name += tc.function.name;
      if (tc.function?.arguments) a.arguments += tc.function.arguments;
    }
  }

  if (choice.finish_reason) {
    const parts: Part[] = [];
    if (acc.text) parts.push({ text: acc.text });
    for (const tc of Array.from(acc.toolCalls.values())) {
      if (tc.name) {
        parts.push({
          functionCall: {
            id: tc.id,
            name: tc.name,
            args: safeJsonParse(tc.arguments),
          },
        });
      }
    }

    acc.text = "";
    acc.toolCalls.clear();

    return {
      response: {
        content: parts.length ? { role: "model", parts } : undefined,
        turnComplete: true,
      },
      isComplete: true,
    };
  }

  return { isComplete: false };
}

export function createStreamAccumulator(): StreamAccumulator {
  return { text: "", toolCalls: new Map() };
}

function safeJsonParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
