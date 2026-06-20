import type * as Adk from "@google/adk";

type HelpDeskTarget = "billing" | "support";

const prompts: Record<HelpDeskTarget, { agentName: string; prompt: string }> = {
  billing: {
    agentName: "CodexBillingSpecialist",
    prompt:
      "I have a billing question. Check the status of invoice INV-001 and explain whether a refund can be considered. Use CodexBillingSpecialist.",
  },
  support: {
    agentName: "OpenRouterSupportSpecialist",
    prompt:
      "I cannot log in. Check the auth service status and send a password reset link to user@example.com. Use OpenRouterSupportSpecialist.",
  },
};

export async function main(): Promise<void> {
  // Use the runtime ESM build directly because this example's tsconfig maps
  // @google/adk to declaration files to avoid duplicate nominal ADK symbols during
  // type-checking. Bun applies paths at runtime too, so a normal value import from
  // @google/adk would try to execute a .d.ts file.
  const adkRuntime = await import(
    new URL(
      ["..", "..", "node_modules", "@google", "adk", "dist", "esm", "index.js"].join("/"),
      import.meta.url,
    ).href,
  );
  const { InMemorySessionService, Runner } = adkRuntime as typeof Adk;

  const target = readTarget();
  if (target === "support" && !process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "SMOKE_HELPDESK_TARGET=support requires OPENROUTER_API_KEY for OpenRouterSupportSpecialist.",
    );
  }
  const scenario = prompts[target];
  const prompt = process.env.SMOKE_HELPDESK_PROMPT ?? scenario.prompt;
  const { rootAgent } = await import("./agent.js");

  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: "agent",
    userId: "user",
  });
  const runner = new Runner({
    appName: "agent",
    agent: rootAgent,
    sessionService,
  });

  let streamedEvents = 0;
  let partials = 0;
  let targetFunctionCalls = 0;
  let targetFunctionResponses = 0;
  let visibleTargetEvents = 0;
  const errors: string[] = [];
  let text = "";

  for await (const event of runner.runAsync({
    userId: "user",
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: prompt }] },
  })) {
    streamedEvents++;
    if (event.partial) {
      partials++;
    }
    if (event.errorMessage) {
      errors.push(event.errorMessage);
    }
    if (event.author === scenario.agentName) {
      visibleTargetEvents++;
    }
    for (const part of event.content?.parts ?? []) {
      if (
        part.functionCall?.name === "run_adk_subagent" &&
        readAgentName(part.functionCall.args) === scenario.agentName
      ) {
        targetFunctionCalls++;
      }
      if (part.functionResponse?.name === "run_adk_subagent") {
        const response = part.functionResponse.response as { agentName?: unknown; error?: unknown } | undefined;
        if (response?.agentName === scenario.agentName) {
          targetFunctionResponses++;
        }
        if (typeof response?.error === "string") {
          errors.push(response.error);
        }
      }
      if (part.text) {
        text += `${part.text}\n`;
      }
    }
  }

  const persisted = await sessionService.getSession({
    appName: "agent",
    userId: "user",
    sessionId: session.id,
  });
  const summary = {
    target,
    expectedAgent: scenario.agentName,
    streamedEvents,
    persistedEvents: persisted?.events.length ?? 0,
    partials,
    targetFunctionCalls,
    targetFunctionResponses,
    visibleTargetEvents,
    errors,
    sample: text.slice(0, 1200),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    errors.length > 0 ||
    targetFunctionCalls < 1 ||
    targetFunctionResponses < 1 ||
    visibleTargetEvents < 1
  ) {
    process.exit(1);
  }
}

function readTarget(): HelpDeskTarget {
  const value = process.env.SMOKE_HELPDESK_TARGET ?? "billing";
  if (value === "billing" || value === "support") {
    return value;
  }
  throw new Error(`SMOKE_HELPDESK_TARGET must be billing or support. Received: ${value}`);
}

function readAgentName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const agentName = (value as { agentName?: unknown }).agentName;
  return typeof agentName === "string" ? agentName : undefined;
}

if (import.meta.main) {
  await main();
}
