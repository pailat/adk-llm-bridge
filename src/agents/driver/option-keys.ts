/**
 * The option keys each public driver config accepts. A driver refuses any
 * other key when it is built (`EXTERNAL_AGENT_OPTION_UNKNOWN`), so a
 * misspelled option, or one meant for another driver, never goes unnoticed.
 * A type test checks that each tuple equals `keyof` its config interface.
 *
 * @internal
 */

/** Keys of `ClaudeAgentSdkDriverConfig`. */
export const CLAUDE_AGENT_SDK_OPTION_KEYS = Object.freeze([
  "allowBackgroundTasks",
  "allowLocalBinding",
  "allowUnsandboxedShell",
  "debugEvents",
  "env",
  "executableSearchPaths",
  "forkSession",
  "importSdk",
  "inheritHostConfig",
  "maxTurns",
  "mcpConnectTimeoutMs",
  "mcpServers",
  "model",
  "pathToClaudeCodeExecutable",
  "requireExplicitModel",
  "requiredMcpServers",
  "resumeSessionId",
  "sdk",
  "sessionStore",
  "sessionStoreFlush",
  "sessionStoreLoadTimeoutMs",
  "settingSources",
  "smallFastModel",
  "strictBinaryResolution",
  "systemPrompt",
  "tools",
] as const);

/** Keys of `ClaudeCliDriverConfig`. */
export const CLAUDE_CLI_OPTION_KEYS = Object.freeze([
  "allowBackgroundTasks",
  "allowLocalBinding",
  "allowPolicyOverrideArgs",
  "allowUnenforcedPaths",
  "allowUnsandboxedShell",
  "args",
  "command",
  "entry",
  "env",
  "inheritHostConfig",
  "interpreter",
  "killGraceMs",
  "maxTurns",
  "model",
  "requireExplicitModel",
  "sessionStore",
  "sessionStoreFlush",
  "sessionStoreLoadTimeoutMs",
  "smallFastModel",
  "spawn",
  "systemPrompt",
  "tools",
] as const);

/** Keys of `CodexSdkDriverConfig`. */
export const CODEX_SDK_OPTION_KEYS = Object.freeze([
  "Codex",
  "allowUncontainedCodexSdk",
  "allowUnenforcedNetwork",
  "allowUnenforcedPaths",
  "apiKey",
  "baseUrl",
  "codexPathOverride",
  "config",
  "env",
  "importSdk",
  "listMcpServers",
  "model",
  "modelReasoningEffort",
  "outputSchema",
  "requireExplicitModel",
  "sdk",
  "skipGitRepoCheck",
  "strictBinaryResolution",
  "threadStateKey",
  "webSearchEnabled",
  "webSearchMode",
] as const);

/** Keys of `CodexCliDriverConfig`. */
export const CODEX_CLI_OPTION_KEYS = Object.freeze([
  "allowPolicyOverrideArgs",
  "allowUnenforcedNetwork",
  "allowUnenforcedPaths",
  "args",
  "command",
  "entry",
  "env",
  "interpreter",
  "killGraceMs",
  "listMcpServers",
  "model",
  "requireExplicitModel",
  "skipGitRepoCheck",
  "spawn",
] as const);

/** Keys of `FxCliDriverConfig`. */
export const FX_CLI_OPTION_KEYS = Object.freeze([
  "allowPolicyOverrideArgs",
  "allowUnenforcedNetwork",
  "allowUnenforcedPaths",
  "allowUnsandboxedShell",
  "args",
  "command",
  "effort",
  "entry",
  "env",
  "inheritHostConfig",
  "interpreter",
  "killGraceMs",
  "model",
  "persistSession",
  "requireExplicitModel",
  "resumeSessionId",
  "sessionStore",
  "spawn",
] as const);

/** Keys of `SubprocessJsonlDriverConfig`. */
export const SUBPROCESS_JSONL_OPTION_KEYS = Object.freeze([
  "args",
  "command",
  "entry",
  "providerId",
] as const);

/**
 * The keys only `ClaudeAgentSdkDriver` accepts: its keys that no other driver
 * lists. The unknown-option message says so when another driver gets one.
 */
export const CLAUDE_AGENT_SDK_ONLY_KEYS: ReadonlySet<string> = (() => {
  const others = new Set<string>([
    ...CLAUDE_CLI_OPTION_KEYS,
    ...CODEX_SDK_OPTION_KEYS,
    ...CODEX_CLI_OPTION_KEYS,
    ...FX_CLI_OPTION_KEYS,
    ...SUBPROCESS_JSONL_OPTION_KEYS,
  ]);
  return new Set(CLAUDE_AGENT_SDK_OPTION_KEYS.filter((k) => !others.has(k)));
})();
