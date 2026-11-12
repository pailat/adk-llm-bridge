/**
 * Each built-in provider definition lives in its own module; the type module
 * and the `./agents` barrel re-export the same objects.
 */

import { describe, expect, test } from "bun:test";
import * as agents from "../../src/agents/index.js";
import { CLAUDE_PROVIDER } from "../../src/agents/provider/claude.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/codex.js";
import { FX_PROVIDER } from "../../src/agents/provider/fx.js";
import * as schema from "../../src/agents/provider/schema.js";

describe("provider definition modules", () => {
  test("Claude, Codex and fx each have their own module", () => {
    expect(CLAUDE_PROVIDER.id).toBe("claude");
    expect(CODEX_PROVIDER.id).toBe("codex");
    expect(FX_PROVIDER.id).toBe("fx");
  });

  test("the type module and the barrel re-export the same objects", () => {
    expect(schema.CLAUDE_PROVIDER).toBe(CLAUDE_PROVIDER);
    expect(schema.CODEX_PROVIDER).toBe(CODEX_PROVIDER);
    expect(agents.CLAUDE_PROVIDER).toBe(CLAUDE_PROVIDER);
    expect(agents.CODEX_PROVIDER).toBe(CODEX_PROVIDER);
    expect(agents.FX_PROVIDER).toBe(FX_PROVIDER);
  });
});
