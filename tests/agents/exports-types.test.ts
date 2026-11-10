import { describe, expect, test } from "bun:test";
import type * as Agents from "../../src/agents/index.js";

// Each removed type must fail to resolve; `typecheck:all` reports an unused
// `@ts-expect-error` if one is exported again.
export type RemovedAgentTypes = [
  // @ts-expect-error internal: the base class's own config
  Agents.SubprocessJsonlDriverConfig,
  // @ts-expect-error internal: options of the Codex input mapper
  Agents.CodexInputMapperOptions,
  // @ts-expect-error internal: result of the Codex input mapper
  Agents.CodexInputMapping,
  // @ts-expect-error internal: flags of the removed generic mapper
  Agents.ProviderPermissionFlags,
  // @ts-expect-error removed: never used by any driver
  Agents.AgentRuntimeRequestMetadata,
  // @ts-expect-error internal: options of the internal tool bridge factory
  Agents.AdkToolCallbacks,
];

describe("./agents type exports", () => {
  test("types named by public signatures stay exported", () => {
    const part: Agents.CodexInputPart = { type: "text", text: "hi" };
    const content: Agents.ClaudeContentBlockParam = {
      type: "text",
      text: "hi",
    };
    const message: Agents.ClaudeMessageParam = {
      role: "user",
      content: [content],
    };
    const user: Agents.SDKUserMessage = {
      type: "user",
      message,
      parent_tool_use_id: null,
    };
    expect(part.type).toBe("text");
    expect(user.message.role).toBe("user");
  });
});
