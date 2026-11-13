import { describe, expect, test } from "bun:test";
import type { InvocationContext } from "@google/adk";
import {
  EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED,
  ExternalAgent,
  type ExternalAgentCredential,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";

class RecordingDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;
  requests: ExternalAgentRunRequest[] = [];
  async *run(
    request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    this.requests.push(request);
    yield { type: "output", content: "ran" };
    yield { type: "completed", exitCode: 0 };
  }
}

function agentWith(credential: unknown) {
  const driver = new RecordingDriver();
  const agent = new ExternalAgent({
    name: "codex_agent",
    provider: CODEX_PROVIDER,
    driver,
    credentialProvider: {
      getCredential: async () => credential as ExternalAgentCredential,
    },
  });
  return { agent, driver };
}

async function collect(agent: ExternalAgent) {
  const events = [];
  for await (const event of agent.runAsync({
    invocationId: "inv-1",
    branch: "root.codex_agent",
  } as InvocationContext)) {
    events.push(event);
  }
  return events;
}

describe("credential kinds", () => {
  test("an env credential reaches the driver", async () => {
    const { agent, driver } = agentWith({
      kind: "env",
      env: { CODEX_API_KEY: "test-value" },
    });
    await collect(agent);
    expect(driver.requests[0]?.credential?.kind).toBe("env");
  });

  test("kind none runs the driver on the runtime's own login", async () => {
    const { agent, driver } = agentWith({ kind: "none" });
    const events = await collect(agent);
    expect(driver.requests).toHaveLength(1);
    expect(events.some((event) => event.errorCode)).toBe(false);
  });

  test("an unsupported kind stops the run before the driver starts", async () => {
    const { agent, driver } = agentWith({
      kind: "custom",
      label: "vault:codex",
    } as unknown as ExternalAgentCredential);
    const events = await collect(agent);

    expect(driver.requests).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.errorCode).toBe(EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED);
    expect(events[0]?.errorCode).toBe("EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED");
    expect(events[0]?.errorMessage).toContain('"custom"');
    expect(events[0]?.errorMessage).toContain("codex");
  });

  for (const [label, credential] of [
    ["an empty kind", { kind: "", env: { CODEX_API_KEY: "v" } }],
    [
      "a missing kind with env",
      { kind: undefined, env: { CODEX_API_KEY: "v" } },
    ],
    ["an upper-case ENV", { kind: "ENV", env: { CODEX_API_KEY: "v" } }],
    ["a string credential", "env"],
    ["an array credential", [{ kind: "env" }]],
  ] as const) {
    test(`${label} is refused before the driver starts`, async () => {
      const { agent, driver } = agentWith(credential);
      const events = await collect(agent);
      expect(driver.requests).toHaveLength(0);
      expect(events).toHaveLength(1);
      expect(events[0]?.errorCode).toBe(EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED);
    });
  }

  test("a null credential counts as no credential", async () => {
    const { agent, driver } = agentWith(null);
    const events = await collect(agent);
    expect(driver.requests).toHaveLength(1);
    expect(driver.requests[0]?.credential).toBeUndefined();
    expect(events.some((event) => event.errorCode)).toBe(false);
  });

  test("the credential is read once and the driver gets a frozen copy", async () => {
    let kindReads = 0;
    let envReads = 0;
    const credential = {
      get kind() {
        kindReads++;
        return kindReads === 1 ? "env" : "custom";
      },
      get env() {
        envReads++;
        return envReads === 1
          ? { CODEX_API_KEY: "first" }
          : { CODEX_API_KEY: "second" };
      },
      label: "codex:env",
    };
    const { agent, driver } = agentWith(credential);
    await collect(agent);

    const received = driver.requests[0]?.credential;
    expect(received).toEqual({
      kind: "env",
      label: "codex:env",
      env: { CODEX_API_KEY: "first" },
    });
    expect(received).not.toBe(credential as never);
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received?.env)).toBe(true);
    expect(kindReads).toBe(1);
    expect(envReads).toBe(1);
    // Reading it again in the driver cannot flip the kind.
    expect(received?.kind).toBe("env");
  });

  test("non-string env values and a malformed env are not passed on", async () => {
    const { agent, driver } = agentWith({
      kind: "env",
      env: { CODEX_API_KEY: "v", OTHER: 42 },
    });
    await collect(agent);
    expect(driver.requests[0]?.credential?.env).toEqual({ CODEX_API_KEY: "v" });

    const refused = agentWith({ kind: "env", env: "CODEX_API_KEY=v" });
    const events = await collect(refused.agent);
    expect(refused.driver.requests).toHaveLength(0);
    expect(events[0]?.errorCode).toBe(EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED);
  });
});
