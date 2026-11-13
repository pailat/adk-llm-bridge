import { describe, expect, test } from "bun:test";
import { InMemoryRunner } from "@google/adk";
import { FxAgent } from "../../../src/agents/index.js";
import { baseConfig, FX_SUCCESS, recordingSpawn } from "./helpers.js";

const SESSION_ID = "sR9HE8eyKMz1";

/** Runs one user turn and drains the runner. */
async function turn(
  runner: InMemoryRunner,
  sessionId: string,
  text: string,
): Promise<void> {
  for await (const _event of runner.runAsync({
    userId: "u",
    sessionId,
    newMessage: { role: "user", parts: [{ text }] },
  })) {
    // drain
  }
}

describe("FxAgent over two turns of one ADK session", () => {
  test("turn 1 saves the fx session id in state and turn 2 resumes it", async () => {
    const fake = recordingSpawn([
      `${JSON.stringify({ ...FX_SUCCESS, session_id: SESSION_ID })}\n`,
    ]);
    const agent = new FxAgent({
      name: "fx_agent",
      driverOptions: baseConfig({ spawn: fake.spawn }),
      permissions: { mode: "ask", allowNetwork: true },
    });
    const runner = new InMemoryRunner({ agent, appName: "app" });
    const session = await runner.sessionService.createSession({
      appName: "app",
      userId: "u",
    });

    await turn(runner, session.id, "my name is Ada");
    const first = fake.calls[0]?.args ?? [];
    expect(first).not.toContain("--no-save");
    expect(first).not.toContain("--resume-id");

    const stored = await runner.sessionService.getSession({
      appName: "app",
      userId: "u",
      sessionId: session.id,
    });
    expect(stored?.state["fx_session:fx_agent"]).toBe(SESSION_ID);

    await turn(runner, session.id, "what is my name?");
    expect(fake.calls).toHaveLength(2);
    const second = fake.calls[1]?.args ?? [];
    expect(second).not.toContain("--no-save");
    expect(second[second.indexOf("--resume-id") + 1]).toBe(SESSION_ID);
  });

  test("another ADK session does not resume that fx session", async () => {
    const fake = recordingSpawn([
      `${JSON.stringify({ ...FX_SUCCESS, session_id: SESSION_ID })}\n`,
    ]);
    const agent = new FxAgent({
      name: "fx_agent",
      driverOptions: baseConfig({ spawn: fake.spawn }),
      permissions: { mode: "ask", allowNetwork: true },
    });
    const runner = new InMemoryRunner({ agent, appName: "app" });
    const a = await runner.sessionService.createSession({
      appName: "app",
      userId: "u",
    });
    const b = await runner.sessionService.createSession({
      appName: "app",
      userId: "u",
    });
    await turn(runner, a.id, "one");
    await turn(runner, b.id, "two");
    expect(fake.calls[1]?.args).not.toContain("--resume-id");
  });
});
