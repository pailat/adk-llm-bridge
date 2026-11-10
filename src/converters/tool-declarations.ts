/**
 * Internal request-conversion helpers shared by the OpenAI-compatible and the
 * Anthropic request converters: system text, tool declarations and tool
 * response payloads. Not part of the public API.
 */

import type { LlmRequest } from "@google/adk";
import type { Part } from "@google/genai";
import { LogCode, type WarningScope, warn } from "../utils/log.js";
import { normalizeJsonSchemaCounts, normalizeSchema } from "./schema.js";

/**
 * Keys of ADK tool groups for built-in tools that only Gemini/Vertex runs
 * (grounding, code execution, retrieval, and so on). Other providers have no
 * equivalent, so the converters skip them and warn once per request.
 */
const GEMINI_ONLY_TOOL_KEYS = [
  "googleSearch",
  "googleSearchRetrieval",
  "codeExecution",
  "urlContext",
  "retrieval",
  "googleMaps",
  "enterpriseWebSearch",
  "computerUse",
  "fileSearch",
  "parallelAiSearch",
  "mcpServers",
] as const;

/**
 * A function declaration ready to be written in a provider's tool format.
 *
 * @internal
 */
export interface ToolDeclaration {
  /** Tool name. */
  name: string;
  /** Tool description; `""` when the declaration has none. */
  description: string;
  /** JSON Schema object of the arguments. */
  parameters: Record<string, unknown>;
}

/**
 * Joins the text parts of `parts` with newlines.
 *
 * @param parts - Content parts.
 * @returns The text.
 * @internal
 */
export function extractText(parts: Part[]): string {
  return parts
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n");
}

/**
 * Reads the system instruction of a request as text.
 *
 * @param req - The ADK request.
 * @returns The system instruction as text, or `null` when there is none.
 * @internal
 */
export function extractSystemInstruction(req: LlmRequest): string | null {
  const sys = req.config?.systemInstruction;
  if (!sys) return null;
  if (typeof sys === "string") return sys;
  if ("parts" in sys) return extractText(sys.parts ?? []);
  return null;
}

/**
 * Resolves the JSON Schema of a function declaration's arguments.
 *
 * @remarks
 * A `parametersJsonSchema` object (set by custom tools and third-party
 * toolsets) wins and is forwarded unchanged except for string int64 counts,
 * which become integers. Otherwise the Gemini-style `parameters` are
 * normalized to lowercase JSON Schema types. A `parametersJsonSchema` that is
 * not an object (an array, a string) is ignored, since providers reject it.
 *
 * @param fn - The declaration.
 * @returns A JSON Schema object; `{ type: "object", properties: {} }` when
 *   there is no usable schema.
 * @internal
 */
export function toolParameters(fn: {
  parameters?: unknown;
  parametersJsonSchema?: unknown;
}): Record<string, unknown> {
  const jsonSchema = fn.parametersJsonSchema;
  if (isJsonSchemaObject(jsonSchema)) {
    return normalizeJsonSchemaCounts(jsonSchema);
  }
  return normalizeSchema(fn.parameters) ?? { type: "object", properties: {} };
}

/**
 * Normalizes string int64 counts in a JSON Schema value.
 *
 * @param schema - A JSON Schema (for example `responseJsonSchema`).
 * @returns The schema with string int64 counts as integers when it is an
 *   object; any other value as is.
 * @internal
 */
export function normalizeJsonSchemaValue(schema: unknown): unknown {
  return isJsonSchemaObject(schema)
    ? normalizeJsonSchemaCounts(schema)
    : schema;
}

/**
 * Reads the function declarations of a request.
 *
 * @remarks
 * Only `functionDeclarations` are read. A declaration without a name is
 * skipped with a warning (once per `warnings` scope). Gemini-only built-in
 * tool groups are skipped, and one warning names them.
 *
 * @param req - The ADK request.
 * @param warnings - The request's warning scope.
 * @returns The declarations, in order; empty when the request has none.
 * @internal
 */
export function readToolDeclarations(
  req: LlmRequest,
  warnings: WarningScope,
): ToolDeclaration[] {
  const groups = req.config?.tools;
  if (!groups?.length) return [];

  const declarations: ToolDeclaration[] = [];
  const droppedBuiltins = new Set<string>();

  for (const group of groups) {
    if (
      "functionDeclarations" in group &&
      Array.isArray(group.functionDeclarations)
    ) {
      for (const fn of group.functionDeclarations) {
        if (!fn.name) {
          warnings.warnOnce(
            LogCode.TOOL_DECLARATION_MISSING_NAME,
            "Tool function missing name, skipping",
          );
          continue;
        }
        declarations.push({
          name: fn.name,
          description: fn.description ?? "",
          parameters: toolParameters(fn),
        });
      }
    }

    const record = group as Record<string, unknown>;
    for (const key of GEMINI_ONLY_TOOL_KEYS) {
      if (record[key] !== undefined && record[key] !== null) {
        droppedBuiltins.add(key);
      }
    }
  }

  if (droppedBuiltins.size > 0) {
    warn(
      LogCode.BUILTIN_TOOLS_DROPPED,
      `dropping Gemini-only built-in tool(s) not supported on this provider: ${[
        ...droppedBuiltins,
      ].join(", ")}`,
    );
  }

  return declarations;
}

/**
 * Serializes a function response as the text sent to the provider.
 *
 * @param response - A `functionResponse.response`.
 * @returns The JSON text sent as the tool result; `{}` when absent.
 * @internal
 */
export function serializeToolResponse(response: unknown): string {
  return JSON.stringify(response ?? {});
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
