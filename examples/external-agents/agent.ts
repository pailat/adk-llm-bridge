import {
  ClaudeAgent,
  ClaudeAgentSdkDriver,
  CodexAgent,
  EnvCredentialProvider,
  mapPermissionModeToPolicy,
} from "adk-llm-bridge/agents";

// External agent runtimes are opt-in and live under the /agents subpath.
// This example intentionally keeps the graph small while validating the current
// recommended path: Claude Code as the root coordinator and Codex as the only
// ADK subagent exposed through Claude's in-process MCP bridge.
const credentialProvider = new EnvCredentialProvider();
const workingDirectory = process.cwd();

const codexImplementer = new CodexAgent({
  name: "CodexImplementer",
  description:
    "Uses the official Codex SDK runtime for scoped repository analysis and implementation tasks.",
  credentialProvider,
  workingDirectory,
  permissions: mapPermissionModeToPolicy("workspace-write"),
  instruction: `You are the Codex specialist for this repository.

Use Codex native authentication/configuration. Keep changes minimal and scoped to the user's request.
When asked to analyze only, do not modify files. Report concise findings and mention any files you inspected.`,
});

const claudeDriver = process.env.CLAUDE_CODE_EXECUTABLE
  ? new ClaudeAgentSdkDriver({
      // Optional fallback when package-manager postinstall scripts did not install
      // the SDK's bundled native binary. Leave CLAUDE_CODE_EXECUTABLE unset to
      // use the SDK default.
      pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE,
    })
  : undefined;

export const rootAgent = new ClaudeAgent({
  name: "ClaudeCodeRoot",
  description:
    "Runs Claude Code as the root ADK agent and exposes CodexImplementer through the ADK subagent bridge.",
  credentialProvider,
  ...(claudeDriver ? { driver: claudeDriver } : {}),
  workingDirectory,
  permissions: {
    ...mapPermissionModeToPolicy("ask"),
    allowNetwork: false,
    allowedPaths: [workingDirectory],
  },
  instruction: `You are the root Claude Code agent for this repository.

Use the native Claude Code authentication already configured on this machine.
Review, explain, and coordinate code changes safely. Ask before making broad or destructive changes.
When the user explicitly asks you to use CodexImplementer or run_adk_subagent, call the MCP tool named run_adk_subagent and delegate to the CodexImplementer ADK subagent.`,
  subAgents: [codexImplementer],
});
