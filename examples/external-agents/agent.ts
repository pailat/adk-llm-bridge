import {
  ClaudeAgent,
  CodexAgent,
  EnvCredentialProvider,
  GeminiCliAgent,
  mapPermissionModeToPolicy,
} from "adk-llm-bridge/agents";

// External agent runtimes are opt-in and live under the /agents subpath.
// ClaudeAgent is the root agent here, so it uses Claude Code's native CLI auth
// cache/OAuth token (or allowlisted env vars) instead of an LLM provider API key.
const credentialProvider = new EnvCredentialProvider();

const codexImplementer = new CodexAgent({
  name: "CodexImplementer",
  description:
    "Implements scoped code changes with Codex when a driver is supplied.",
  credentialProvider,
  workingDirectory: process.cwd(),
  permissions: mapPermissionModeToPolicy("workspace-write"),
  instruction: "Make the smallest safe code change that satisfies the request.",
});

const geminiResearcher = new GeminiCliAgent({
  name: "GeminiResearcher",
  description:
    "Explores large codebases with Gemini CLI when a driver is supplied.",
  credentialProvider,
  workingDirectory: process.cwd(),
  permissions: mapPermissionModeToPolicy("read-only"),
  instruction: "Summarize the relevant files and call out open questions.",
});

export const rootAgent = new ClaudeAgent({
  name: "ClaudeCodeRoot",
  description:
    "Runs Claude Code as the root ADK agent using native Claude CLI authentication.",
  credentialProvider,
  workingDirectory: process.cwd(),
  permissions: {
    ...mapPermissionModeToPolicy("ask"),
    allowNetwork: false,
    allowedPaths: [process.cwd()],
  },
  instruction: `You are the root Claude Code agent for this repository.

Use the native Claude CLI authentication already configured on this machine.
Review, explain, and coordinate code changes safely. Ask before making broad or destructive changes.
Delegate to specialist agents only when the task explicitly benefits from Codex or Gemini CLI.`,
  subAgents: [codexImplementer, geminiResearcher],
});
