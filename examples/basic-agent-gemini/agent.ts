import type * as Adk from "@google/adk";
import {
  EnvCredentialProvider,
  GEMINI_CLI_AGENT_DEFINITION,
  GeminiCliAgent,
  type GeminiCliAgentConfig,
  mapPermissionModeToPolicy,
} from "adk-llm-bridge/agents";

// This example maps @google/adk to declaration files for local type-checking.
// Import the runtime ESM build directly so Bun does not execute a .d.ts file.
const adkRuntime = await import(
  new URL(
    [
      "..",
      "..",
      "node_modules",
      "@google",
      "adk",
      "dist",
      "esm",
      "index.js",
    ].join("/"),
    import.meta.url,
  ).href
);
const { InMemorySessionService, Runner } = adkRuntime as typeof Adk;

// =============================================================================
// Gemini external agent (Gemini CLI driver)
// =============================================================================
//
// GeminiCliAgent runs Google Gemini as an external ADK agent by driving the
// local `gemini` CLI. Credentials resolve from the environment (GEMINI_API_KEY
// or GOOGLE_API_KEY), or from a `gemini` CLI that is already authenticated on
// this machine. The agent definition wires up the default credential provider
// and the GeminiCliDriver for you; pass only the agent-specific config.

const geminiConfig: GeminiCliAgentConfig = {
  name: "GeminiAssistant",
  description: "A helpful assistant running Google Gemini via the Gemini CLI.",
  credentialProvider: new EnvCredentialProvider(),
  workingDirectory: process.cwd(),
  permissions: mapPermissionModeToPolicy("read-only"),
  instruction: `You are a concise, helpful assistant running as a Gemini ADK agent.

Answer the user's question directly and briefly. Do not modify files.`,
};

export const rootAgent = new GeminiCliAgent(geminiConfig);

// =============================================================================
// Smoke script: send ONE simple prompt
// =============================================================================
//
// Run with `bun run smoke`. This typechecks and builds even when no credentials
// are configured; at runtime it prints a clear hint and exits 0 if neither a
// credential nor a local `gemini` CLI is available, instead of crashing.

function hasGeminiCredential(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

function hasGeminiCli(): boolean {
  const command = GEMINI_CLI_AGENT_DEFINITION.provider.command ?? "gemini";
  try {
    const proc = Bun.spawnSync(["which", command]);
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export async function main(): Promise<void> {
  if (!hasGeminiCredential() && !hasGeminiCli()) {
    console.log(
      "set GEMINI_API_KEY (or local gemini CLI) to run this example",
    );
    process.exit(0);
  }

  const prompt =
    process.env.SMOKE_PROMPT ?? "In one sentence, what is the Google ADK?";

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

  let text = "";
  for await (const event of runner.runAsync({
    userId: "user",
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: prompt }] },
  })) {
    if (event.errorMessage) {
      console.error(`Gemini agent error: ${event.errorMessage}`);
    }
    for (const part of event.content?.parts ?? []) {
      if (part.text) {
        text += part.text;
      }
    }
  }

  console.log(JSON.stringify({ prompt, response: text.trim() }, null, 2));
}

if (import.meta.main) {
  await main();
}
