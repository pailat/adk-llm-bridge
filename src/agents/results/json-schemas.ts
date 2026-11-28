import type { AgentResultSchemaId } from "./schemas.js";

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/** Lane outcome shared by `implement@1` and `tests@1`. */
function laneStatus(): Record<string, unknown> {
  return {
    description:
      "done when the work is complete, blocked when it cannot go on without outside help, failed when it was attempted and did not succeed.",
    type: "string",
    enum: ["done", "blocked", "failed"],
  };
}

/** A string property with a description. */
function text(description: string): Record<string, unknown> {
  return { description, type: "string" };
}

/** Freezes a JSON value and everything inside it. */
function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Builds the documents. They are written out by hand, not generated, so a
 * library upgrade cannot change a released version, and they use only the
 * keywords structured output support commonly accepts: `type`, `enum`,
 * `properties`, `required`, `additionalProperties` and `items`.
 */
function buildJsonSchemas(): Record<
  AgentResultSchemaId,
  Record<string, unknown>
> {
  return {
    "implement@1": {
      $schema: DRAFT_2020_12,
      title: "implement@1",
      description:
        "Result of an implement lane: whether the work is done, what it did and which paths it changed.",
      type: "object",
      properties: {
        status: laneStatus(),
        summary: text("What the lane did, or why it stopped, for people."),
        changedPaths: {
          description:
            "Paths the lane changed, relative to the project root, with forward slashes.",
          type: "array",
          items: { type: "string" },
        },
        notes: text("Anything else the next step should know."),
      },
      required: ["status", "summary", "changedPaths"],
      additionalProperties: false,
    },
    "tests@1": {
      $schema: DRAFT_2020_12,
      title: "tests@1",
      description:
        "Result of a tests lane: the tests it wrote and whether they fail before the implementation, as they should.",
      type: "object",
      properties: {
        status: laneStatus(),
        testPaths: {
          description:
            "Test files the lane wrote or changed, relative to the project root, with forward slashes.",
          type: "array",
          items: { type: "string" },
        },
        failingAsExpected: {
          description:
            "True when the new tests fail for the reason the missing implementation explains.",
          type: "boolean",
        },
      },
      required: ["status", "testPaths", "failingAsExpected"],
      additionalProperties: false,
    },
    "review@1": {
      $schema: DRAFT_2020_12,
      title: "review@1",
      description:
        "Result of a review lane: the verdict and the findings behind it.",
      type: "object",
      properties: {
        verdict: {
          description:
            "approve when the change can merge, request_changes when another change round should fix the findings, block when the change must not go on.",
          type: "string",
          enum: ["approve", "request_changes", "block"],
        },
        findings: {
          description: "Problems the review found. Empty when there are none.",
          type: "array",
          items: {
            description: "One problem the review found.",
            type: "object",
            properties: {
              severity: {
                description: "How much the problem matters.",
                type: "string",
                enum: ["high", "medium", "low"],
              },
              path: text(
                "File the problem is in, relative to the project root, with forward slashes.",
              ),
              line: {
                description: "Line the problem is on, counted from 1.",
                type: "integer",
              },
              summary: text("What is wrong, for people."),
            },
            required: ["severity", "path", "summary"],
            additionalProperties: false,
          },
        },
      },
      required: ["verdict", "findings"],
      additionalProperties: false,
    },
    "gate@1": {
      $schema: DRAFT_2020_12,
      title: "gate@1",
      description: "Result of a gate: whether it passed and the checks it ran.",
      type: "object",
      properties: {
        passed: {
          description: "True when every check the gate requires passed.",
          type: "boolean",
        },
        checks: {
          description: "Checks the gate ran, in the order it ran them.",
          type: "array",
          items: {
            description: "One check the gate ran.",
            type: "object",
            properties: {
              id: text("Id of the check, such as the name of its command."),
              exitCode: {
                description:
                  "Exit code of the check's process. 0 means it passed.",
                type: "integer",
              },
              durationMs: {
                description: "How long the check ran, in milliseconds.",
                type: "integer",
              },
            },
            required: ["id", "exitCode", "durationMs"],
            additionalProperties: false,
          },
        },
      },
      required: ["passed", "checks"],
      additionalProperties: false,
    },
  };
}

/**
 * JSON Schema (draft 2020-12) of each standard result, by schema id.
 *
 * @remarks
 * Pass one as a driver's `outputSchema` so the agent returns that shape, then
 * check the output with `parseAgentResult`. The two accept the same values,
 * except that the parser also rejects integers beyond
 * `Number.MAX_SAFE_INTEGER`. Each document's `title` is its schema id. A released
 * version never changes. The map and every document are deeply frozen; copy
 * a document before changing it.
 *
 * @experimental
 */
export const agentResultJsonSchemas: Readonly<
  Record<AgentResultSchemaId, Readonly<Record<string, unknown>>>
> = deepFreeze(buildJsonSchemas());
