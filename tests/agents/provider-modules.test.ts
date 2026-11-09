/**
 * Each built-in provider definition lives in its own module; the type module
 * and the `./agents` barrel re-export the same objects.
 */

import { describe, expect, test } from "bun:test";
import * as agents from "../../src/agents/index.js";
import { CLAUDE_PROVIDER } from "../../src/agents/provider/claude.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/codex.js";
import { GEMINI_CLI_PROVIDER } from "../../src/agents/provider/gemini-cli.js";
import * as schema from "../../src/agents/provider/schema.js";

describe("provider definition modules", () => {
  test("Claude, Codex and Gemini each have their own module", () => {
    expect(CLAUDE_PROVIDER.id).toBe("claude");
    expect(CODEX_PROVIDER.id).toBe("codex");
    expect(GEMINI_CLI_PROVIDER.id).toBe("gemini-cli");
  });

  test("the type module and the barrel re-export the same objects", () => {
    expect(schema.CLAUDE_PROVIDER).toBe(CLAUDE_PROVIDER);
    expect(schema.CODEX_PROVIDER).toBe(CODEX_PROVIDER);
    expect(agents.CLAUDE_PROVIDER).toBe(CLAUDE_PROVIDER);
    expect(agents.CODEX_PROVIDER).toBe(CODEX_PROVIDER);
    expect(agents.GEMINI_CLI_PROVIDER).toBe(GEMINI_CLI_PROVIDER);
  });
});
