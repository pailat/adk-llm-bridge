import {
  ClaudeAgent,
  ClaudeAgentSdkDriver,
  CodexAgent,
  EnvCredentialProvider,
  mapPermissionModeToPolicy,
} from "adk-llm-bridge/agents";

// External agent runtimes are opt-in and live under the /agents subpath.
// This example keeps the graph small while validating the recommended path:
// Claude Code as the root coordinator and Codex as the architecture-analysis
// ADK subagent exposed through Claude's in-process MCP bridge.
const credentialProvider = new EnvCredentialProvider();
const workingDirectory = process.cwd();
const architectureAnalysisPaths = parsePathList(
  process.env.ARCHITECTURE_ANALYSIS_PATHS,
);
const allowedPaths = [workingDirectory, ...architectureAnalysisPaths];

const codexArchitectureExpert = new CodexAgent({
  name: "CodexArchitectureExpert",
  description:
    "Uses the official Codex SDK runtime to understand, map, and explain project architecture.",
  credentialProvider,
  workingDirectory,
  permissions: {
    ...mapPermissionModeToPolicy("read-only"),
    allowedPaths,
  },
  instruction: `You are the Codex architecture expert for this repository.

Use Codex native authentication/configuration. Your job is to understand and explain the project's architecture, not to edit files.
When analyzing a project, inspect relevant files before answering. Prioritize README files, package manifests, src/, examples/, tests/, and configuration files.
Explain the main modules, entry points, runtime flow, important abstractions, and how components interact.
Keep responses structured and concise. Mention representative files you inspected. Do not modify files.`,
});

const claudeDriver = new ClaudeAgentSdkDriver({
  // Optional fallback when package-manager postinstall scripts did not install
  // the SDK's bundled native binary. Leave these unset to use driver autodetection
  // and the SDK default.
  pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE ?? process.env.CLAUDE_CODE_PATH,
});

export const rootAgent = new ClaudeAgent({
  name: "ClaudeCodeRoot",
  description:
    "Runs Claude Code as the root ADK agent and exposes CodexArchitectureExpert through the ADK subagent bridge.",
  credentialProvider,
  driver: claudeDriver,
  workingDirectory,
  permissions: {
    ...mapPermissionModeToPolicy("ask"),
    allowNetwork: false,
    allowedPaths,
  },
  instruction: `You are the root Claude Code agent for this repository.

Use the native Claude Code authentication already configured on this machine.
Review, explain, and coordinate code changes safely. Ask before making broad or destructive changes.
When the user asks to understand this project's architecture, codebase structure, major modules, runtime flow, design, technical organization, or how the repository works, delegate to the CodexArchitectureExpert ADK subagent by calling the MCP tool named run_adk_subagent.
When delegating, call run_adk_subagent immediately before producing explanatory text. Do not narrate that you are about to delegate before the tool call. After the tool returns, summarize or relay the result to the user.
When delegating, pass a clear architecture-analysis task and preserve any user constraints such as "do not modify files".
If the user asks to analyze an absolute path outside the allowed paths, explain that ARCHITECTURE_ANALYSIS_PATHS must include that path and do not fall back to broad direct file access.
If CodexArchitectureExpert reports a runtime configuration error, report the configuration error directly instead of pretending to complete the architecture analysis.
You may answer directly for simple factual questions that do not require codebase architecture analysis.

Allowed architecture analysis paths: ${allowedPaths.join(", ")}.`,
  subAgents: [codexArchitectureExpert],
});

function parsePathList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
