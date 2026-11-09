import {
  createExternalAgentConfig,
  type ExternalAgentDefinition,
  type ExternalAgentDefinitionConfig,
} from "./agent-schema.js";
import { EnvCredentialProvider } from "./auth/env.js";
import {
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkDriverConfig,
} from "./driver/claude-agent-sdk.js";
import { ExternalAgent } from "./external-agent.js";
import { CLAUDE_PROVIDER } from "./provider/claude.js";

/** Default definition of the Claude agent: the Claude Agent SDK driver and env credentials. */
export const CLAUDE_AGENT_DEFINITION: ExternalAgentDefinition<ClaudeAgentSdkDriverConfig> =
  {
    provider: CLAUDE_PROVIDER,
    runtime: "sdk",
    createCredentialProvider: () => new EnvCredentialProvider(),
    createDriver: (options) => new ClaudeAgentSdkDriver(options),
  };

/**
 * Options for {@link ClaudeAgent}: everything {@link ExternalAgent} accepts
 * except the provider, plus the options of the default driver.
 */
export interface ClaudeAgentConfig
  extends ExternalAgentDefinitionConfig<ClaudeAgentSdkDriverConfig> {
  /**
   * Options for the default {@link ClaudeAgentSdkDriver}, for example
   * `tools` (the Claude Code built-in tools, not the ADK `tools` of the
   * agent), `inheritHostConfig`, `allowUnsandboxedShell`,
   * `requiredMcpServers` or `model`. `requiredMcpServers` other than
   * `adk_bridge` need `inheritHostConfig: true`; the driver throws
   * `InputValidationError` at construction otherwise.
   *
   * @remarks
   * Give either `driver` or `driverOptions`. With both, the constructor
   * throws an `InputValidationError`, because the options would be ignored.
   * A clone reuses the built driver; to clone with other options, pass a
   * new `driver` to `clone()`.
   */
  driverOptions?: ClaudeAgentSdkDriverConfig;
}

/**
 * An ADK agent that runs Claude Code through the Claude Agent SDK.
 *
 * @example
 * ```ts
 * const agent = new ClaudeAgent({
 *   name: "claude",
 *   description: "Reviews and edits code",
 *   workingDirectory: process.cwd(),
 * });
 * ```
 */
export class ClaudeAgent extends ExternalAgent {
  /** The definition this class is built from. */
  static readonly definition = CLAUDE_AGENT_DEFINITION;

  /**
   * Creates an external agent backed by the Claude Agent SDK.
   *
   * @param config - Agent options. `driver` replaces the default Claude Agent SDK
   * driver; `driverOptions` configure it.
   * @throws {@link InputValidationError} when both `driver` and
   * `driverOptions` are given.
   */
  constructor(config: ClaudeAgentConfig) {
    super(createExternalAgentConfig(CLAUDE_AGENT_DEFINITION, config));
  }
}
