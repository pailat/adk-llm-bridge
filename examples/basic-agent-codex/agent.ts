import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as Adk from "@google/adk";
import {
  CodexAgent,
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

// =============================================================================
// Codex External Agent (via the Codex SDK driver)
// =============================================================================
//
// CodexAgent runs OpenAI Codex as an external ADK agent. It uses the bundled
// CodexSdkDriver (the default for CODEX_AGENT_DEFINITION), which talks to the
// @openai/codex-sdk package. The SDK ships its OWN bundled `codex` binary, so a
// `codex` on PATH is NOT the availability signal — what matters is a usable
// credential: a CODEX_API_KEY, a readable ~/.codex/auth.json, or an explicit
// CODEX_EXECUTABLE/CODEX_CLI_PATH.

const credentialProvider = new EnvCredentialProvider();
const workingDirectory = process.cwd();

export const rootAgent = new CodexAgent({
  name: "CodexAssistant",
  description:
    "A general-purpose assistant running OpenAI Codex as an external ADK agent.",
  credentialProvider,
  workingDirectory,
  permissions: {
    // Read-only keeps the smoke run from modifying files. Restrict reachable
    // paths to this example directory.
    ...mapPermissionModeToPolicy("read-only"),
    allowNetwork: false,
    allowedPaths: [workingDirectory],
  },
  instruction: `You are a concise, friendly assistant running as a Codex ADK agent.

Answer the user's question directly. Do not modify files. Keep responses short.`,
});

// =============================================================================
// Smoke script: send ONE simple prompt through an ADK runner.
//
// Typechecks and builds with no credentials. At runtime, if no usable Codex
// credential is available, it prints a clear hint and exits 0 instead of
// crashing.
// =============================================================================

const SMOKE_PROMPT =
  process.env.SMOKE_PROMPT ?? "In one sentence, what is OpenAI Codex?";

/**
 * Resolve `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) and report
 * whether it is readable. The SDK reads this file for native CLI auth, so its
 * presence is a valid availability signal even without a `codex` on PATH.
 */
function hasReadableCodexAuthJson(): boolean {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  try {
    accessSync(join(home, "auth.json"), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function codexCredentialsAvailable(): boolean {
  // Note: OPENAI_API_KEY is accepted only as a convenience signal — it is NOT a
  // Codex CLI credential variable, so when set (without CODEX_API_KEY) it is
  // mapped onto CODEX_API_KEY below so the guard and the driver agree.
  return Boolean(
    process.env.CODEX_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.CODEX_EXECUTABLE ||
      process.env.CODEX_CLI_PATH ||
      hasReadableCodexAuthJson(),
  );
}

export async function main(): Promise<void> {
  if (!codexCredentialsAvailable()) {
    console.log(
      "set CODEX_API_KEY, or sign in so ~/.codex/auth.json exists " +
        "(or set CODEX_EXECUTABLE/CODEX_CLI_PATH) to run this example",
    );
    process.exit(0);
  }

  // OPENAI_API_KEY is not a Codex CLI credential variable; map it onto
  // CODEX_API_KEY so the guard above and the driver's credential resolution
  // agree. The driver itself does NOT add an OPENAI_API_KEY fallback.
  if (process.env.OPENAI_API_KEY && !process.env.CODEX_API_KEY) {
    process.env.CODEX_API_KEY = process.env.OPENAI_API_KEY;
  }

  const { InMemorySessionService, Runner } = adkRuntime as typeof Adk;

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
    newMessage: { role: "user", parts: [{ text: SMOKE_PROMPT }] },
  })) {
    if (event.errorMessage) {
      console.error(`Codex error: ${event.errorMessage}`);
    }
    for (const part of event.content?.parts ?? []) {
      if (part.text) {
        text += part.text;
      }
    }
  }

  console.log(`Prompt: ${SMOKE_PROMPT}`);
  console.log(`Response: ${text.trim() || "(no text response)"}`);
}

if (import.meta.main) {
  await main();
}
