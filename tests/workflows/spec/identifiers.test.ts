import { describe, expect, test } from "bun:test";
import {
  isWorkflowIdentifier,
  type WorkflowIdentifierGrammar,
} from "../../../src/workflows/internal/identifiers.js";
import {
  RunSpecLaneSchema,
  RunSpecV1Schema,
} from "../../../src/workflows/spec/schema.js";

/**
 * Candidate ids: every character from U+0000 to U+017F and a few astral
 * ones, first and after a valid letter, plus the length boundaries.
 */
function candidates(): string[] {
  const characters: string[] = [];
  for (let code = 0; code <= 0x17f; code++) {
    characters.push(String.fromCharCode(code));
  }
  characters.push("\u{1F600}", " ", "﻿", "​");
  const values = ["", "a".repeat(256), "a".repeat(257), "a".repeat(512)];
  for (const character of characters) {
    values.push(character, `a${character}`, `a${character}b`);
  }
  return values;
}

const FIELDS: readonly {
  readonly name: string;
  readonly grammar: WorkflowIdentifierGrammar;
  readonly accepts: (value: string) => boolean;
}[] = [
  {
    name: "lane taskId",
    grammar: "record",
    accepts: (value) => RunSpecLaneSchema.shape.taskId.safeParse(value).success,
  },
  {
    name: "workflowId",
    grammar: "opaque",
    accepts: (value) =>
      RunSpecV1Schema.shape.workflowId.safeParse(value).success,
  },
  {
    name: "workflowVersion",
    grammar: "opaque",
    accepts: (value) =>
      RunSpecV1Schema.shape.workflowVersion.safeParse(value).success,
  },
];

describe("id grammars repeated in the run spec schema", () => {
  for (const field of FIELDS) {
    test(`${field.name} accepts exactly the ${field.grammar} identifiers of the workflow layer`, () => {
      const differ = candidates().filter(
        (value) =>
          field.accepts(value) !== isWorkflowIdentifier(value, field.grammar),
      );
      expect(differ.map((value) => JSON.stringify(value))).toEqual([]);
    });
  }
});
