import type { LlmRequest } from "@google/adk";
import type { Content, Part } from "@google/genai";
import type OpenAI from "openai";

export interface ConvertedRequest {
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
}

export function convertRequest(llmRequest: LlmRequest): ConvertedRequest {
  const messages: OpenAI.ChatCompletionMessageParam[] = [];

  const systemContent = extractSystemInstruction(llmRequest);
  if (systemContent) {
    messages.push({ role: "system", content: systemContent });
  }

  for (const content of llmRequest.contents ?? []) {
    processContent(content, messages);
  }

  return { messages, tools: convertTools(llmRequest) };
}

function extractSystemInstruction(req: LlmRequest): string | null {
  const sys = req.config?.systemInstruction;
  if (!sys) return null;
  if (typeof sys === "string") return sys;
  if ("parts" in sys) return extractText(sys.parts ?? []);
  return null;
}

function extractText(parts: Part[]): string {
  return parts
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n");
}

function processContent(
  content: Content,
  messages: OpenAI.ChatCompletionMessageParam[],
): void {
  if (!content.parts?.length) return;

  const texts: string[] = [];
  const calls: { id: string; name: string; arguments: string }[] = [];
  const responses: { id: string; content: string }[] = [];

  for (const part of content.parts) {
    if (part.text) texts.push(part.text);
    if (part.functionCall) {
      calls.push({
        id: part.functionCall.id ?? `call_${Date.now()}`,
        name: part.functionCall.name ?? "",
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    }
    if (part.functionResponse) {
      responses.push({
        id: part.functionResponse.id ?? "",
        content: JSON.stringify(part.functionResponse.response ?? {}),
      });
    }
  }

  if (content.role === "user") {
    if (texts.length)
      messages.push({ role: "user", content: texts.join("\n") });
    for (const r of responses) {
      messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
  } else if (content.role === "model") {
    if (texts.length || calls.length) {
      const msg: OpenAI.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: texts.length ? texts.join("\n") : null,
      };
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: c.arguments },
        }));
      }
      messages.push(msg);
    }
  }
}

function convertTools(
  req: LlmRequest,
): OpenAI.ChatCompletionTool[] | undefined {
  const adkTools = req.config?.tools;
  if (!adkTools?.length) return undefined;

  const tools: OpenAI.ChatCompletionTool[] = [];

  for (const group of adkTools) {
    if (
      "functionDeclarations" in group &&
      Array.isArray(group.functionDeclarations)
    ) {
      for (const fn of group.functionDeclarations) {
        tools.push({
          type: "function",
          function: {
            name: fn.name ?? "",
            description: fn.description ?? "",
            parameters: normalizeSchema(fn.parameters) ?? {
              type: "object",
              properties: {},
            },
          },
        });
      }
    }
  }

  return tools.length ? tools : undefined;
}

/**
 * Normalizes Gemini-style schema (UPPERCASE types) to OpenAI-style (lowercase types)
 */
function normalizeSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object") return undefined;

  const result: Record<string, unknown> = {};
  const input = schema as Record<string, unknown>;

  for (const [key, value] of Object.entries(input)) {
    if (key === "type" && typeof value === "string") {
      // Convert UPPERCASE type to lowercase (OBJECT -> object, STRING -> string, etc.)
      result[key] = value.toLowerCase();
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      // Recursively normalize nested objects (like properties)
      result[key] = normalizeSchema(value);
    } else if (Array.isArray(value)) {
      // Handle arrays (like required)
      result[key] = value;
    } else {
      result[key] = value;
    }
  }

  return result;
}
