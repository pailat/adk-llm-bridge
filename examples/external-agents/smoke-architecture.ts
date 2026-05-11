import type * as Adk from "@google/adk";
import { rootAgent } from "./agent.js";

async function main(): Promise<void> {
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

  const prompt = process.env.SMOKE_ARCHITECTURE_PROMPT ??
    "Entiende la arquitectura de este ejemplo external-agents y explica sus componentes principales. No modifiques archivos.";

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
  let functionCalls = 0;
  let functionResponses = 0;
  let visibleSubagentEvents = 0;
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
    if (event.author === "CodexArchitectureExpert") {
      visibleSubagentEvents++;
    }
    for (const part of event.content?.parts ?? []) {
      if (part.functionCall?.name === "run_adk_subagent") {
        functionCalls++;
      }
      if (part.functionResponse?.name === "run_adk_subagent") {
        functionResponses++;
        const response = part.functionResponse.response as { error?: unknown } | undefined;
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
  const persistedEvents = persisted?.events.length ?? 0;
  const summary = {
    streamedEvents,
    persistedEvents,
    partials,
    functionCalls,
    functionResponses,
    visibleSubagentEvents,
    errors,
    hasArchitectureContent: /arquitectura|architecture|componentes|components/i.test(text),
    sample: text.slice(0, 1200),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    errors.length > 0 ||
    functionCalls < 1 ||
    functionResponses < 1 ||
    visibleSubagentEvents > 0 ||
    !summary.hasArchitectureContent
  ) {
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
