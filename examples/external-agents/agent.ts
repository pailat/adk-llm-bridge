import { LlmAgent } from "@google/adk";
import { AIGateway } from "adk-llm-bridge";
import {
  ClaudeAgent,
  CodexAgent,
  EnvCredentialProvider,
  GeminiCliAgent,
  mapPermissionModeToPolicy,
} from "adk-llm-bridge/agents";

// External agent runtimes are opt-in and live under the /agents subpath.
// The foundation exports ADK-compatible agent classes and shared configuration
// shapes. Provider-specific runtime drivers are intentionally not bundled here.
const credentialProvider = new EnvCredentialProvider();

const codeReviewer = new ClaudeAgent({
  name: "ClaudeCodeReviewer",
  description: "Reviews repository changes with Claude Code when a driver is supplied.",
  credentialProvider,
  workingDirectory: process.cwd(),
  permissions: {
    ...mapPermissionModeToPolicy("ask"),
    allowNetwork: false,
    allowedPaths: [process.cwd()],
  },
  instruction:
    "Review the proposed change. Focus on correctness, safety, and maintainability.",
});

const codexImplementer = new CodexAgent({
  name: "CodexImplementer",
  description: "Implements scoped code changes with Codex when a driver is supplied.",
  credentialProvider,
  workingDirectory: process.cwd(),
  permissions: mapPermissionModeToPolicy("workspace-write"),
  instruction: "Make the smallest safe code change that satisfies the request.",
});

const geminiResearcher = new GeminiCliAgent({
  name: "GeminiResearcher",
  description: "Explores large codebases with Gemini CLI when a driver is supplied.",
  credentialProvider,
  workingDirectory: process.cwd(),
  permissions: mapPermissionModeToPolicy("read-only"),
  instruction: "Summarize the relevant files and call out open questions.",
});

export const rootAgent = new LlmAgent({
  name: "ExternalRuntimeCoordinator",
  model: AIGateway("anthropic/claude-sonnet-4"),
  description:
    "Routes requests between an LLM coordinator and opt-in external agent runtimes.",
  instruction: `You coordinate work across specialist agents.

Use external runtime sub-agents only for tasks that explicitly need their CLI/runtime.
Keep normal chat, planning, and tool use in the LLM coordinator.`,
  subAgents: [codeReviewer, codexImplementer, geminiResearcher],
});
