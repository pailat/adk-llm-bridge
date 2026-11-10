import { describe, expect, test } from "bun:test";
import { InMemoryRunner } from "@google/adk";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../../src/agents/index.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

/**
 * Renders the prompt the real Claude SDK driver would send, when the run
 * starts (its prompt builder is pure: no binary runs), then answers "ok".
 */
class RecordingDriver implements ExternalAgentDriver {
  readonly providerId = CLAUDE_PROVIDER.id;
  readonly prompts: unknown[] = [];
  readonly #claude = new ClaudeAgentSdkDriver({
    pathToClaudeCodeExecutable: "/nonexistent/claude",
  });
  async *run(
    request: ExternalAgentRunRequest,
  ): AsyncGenerator<ExternalAgentEvent> {
    this.prompts.push(this.#claude.buildPromptInput(request));
    yield { type: "output", content: "ok" };
  }
}

describe("Claude SDK prompt through a Runner", () => {
  test("the current user turn appears once in the flattened prompt", async () => {
    const driver = new RecordingDriver();
    const runner = new InMemoryRunner({
      agent: new ExternalAgent({
        name: "worker",
        provider: CLAUDE_PROVIDER,
        driver,
      }),
      appName: "app",
    });
    const session = await runner.sessionService.createSession({
      appName: "app",
      userId: "user",
    });
    for (const text of ["first question", "second question"]) {
      for await (const _ of runner.runAsync({
        userId: "user",
        sessionId: session.id,
        newMessage: { role: "user", parts: [{ text }] },
      })) {
        // drain
      }
    }

    const prompt = driver.prompts[1];
    expect(typeof prompt).toBe("string");
    expect(String(prompt).split("second question")).toHaveLength(2);
    expect(String(prompt).split("first question")).toHaveLength(2);
    expect(String(prompt)).toBe(
      "user:\nfirst question\n\nassistant:\nok\n\nuser:\nsecond question",
    );
  });
});
