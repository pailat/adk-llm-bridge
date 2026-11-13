import { spawnSync } from "node:child_process";
import type * as Adk from "@google/adk";
import {
  ClaudeAgent,
  ClaudeAgentSdkDriver,
  EnvCredentialProvider,
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
// Claude (Claude Agent SDK) as an external ADK agent
// =============================================================================
//
// The ClaudeAgent runs Anthropic Claude through the official
// @anthropic-ai/claude-agent-sdk driver as the root ADK agent. Credentials come
// from the environment (ANTHROPIC_API_KEY) or from the native Claude Code CLI
// auth/OAuth already configured on this machine.

const credentialProvider = new EnvCredentialProvider();
const workingDirectory = process.cwd();

const claudeDriver = new ClaudeAgentSdkDriver({
  // Optional fallback when package-manager postinstall scripts did not install
  // the SDK's bundled native binary. Leave unset to use driver autodetection
  // and the SDK default.
  pathToClaudeCodeExecutable:
    process.env.CLAUDE_CODE_EXECUTABLE ?? process.env.CLAUDE_CODE_PATH,
});

export const rootAgent = new ClaudeAgent({
  name: "ClaudeAssistant",
  description: "A simple Claude assistant running as the root ADK agent.",
  credentialProvider,
  driver: claudeDriver,
  workingDirectory,
  permissions: {
    ...mapPermissionModeToPolicy("read-only"),
    allowNetwork: false,
    allowedPaths: [workingDirectory],
  },
  instruction: `You are a friendly assistant running as a Claude ADK agent.

Answer the user's question clearly and concisely. Do not modify files.`,
});

// =============================================================================
// Smoke script: send ONE simple prompt
// =============================================================================
//
// Typechecks and builds without credentials. At runtime, if no credential or
// Claude Code CLI is available, print a clear message and exit 0.

/**
 * Reports whether a local Claude Code CLI is logged in, using
 * `claude auth status --json`. Any failure (no CLI, timeout, bad JSON) counts
 * as "not logged in".
 */
function hasLoggedInClaudeCli(): boolean {
  try {
    const result = spawnSync("claude", ["auth", "status", "--json"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.status !== 0) return false;
    const status = JSON.parse(result.stdout) as { loggedIn?: unknown };
    return status.loggedIn === true;
  } catch {
    return false;
  }
}

function hasClaudeCredential(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      process.env.CLAUDE_CODE_EXECUTABLE ||
      process.env.CLAUDE_CODE_PATH ||
      hasLoggedInClaudeCli(),
  );
}

export async function main(): Promise<void> {
  if (!hasClaudeCredential()) {
    console.log(
      "set ANTHROPIC_API_KEY or log in with the Claude Code CLI (`claude auth login`) to run this example",
    );
    process.exit(0);
  }

  const prompt =
    process.env.SMOKE_PROMPT ??
    "In one sentence, what is the Google Agent Development Kit (ADK)?";

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
    for (const part of event.content?.parts ?? []) {
      if (part.text) {
        text += part.text;
      }
    }
  }

  console.log(text.trim());
}

if (import.meta.main) {
  await main();
}
