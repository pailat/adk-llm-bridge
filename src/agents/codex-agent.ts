import {
  createExternalAgentConfig,
  type ExternalAgentDefinition,
  type ExternalAgentDefinitionConfig,
} from "./agent-schema.js";
import { EnvCredentialProvider } from "./auth/env.js";
import {
  CodexSdkDriver,
  type CodexSdkDriverConfig,
} from "./driver/codex-sdk.js";
import { ExternalAgent } from "./external-agent.js";
import { CODEX_PROVIDER } from "./provider/codex.js";

/**
 * Default definition of the Codex agent: the Codex SDK driver and env
 * credentials.
 *
 * @remarks
 * Like the Claude and fx agents, it reads credentials with an
 * {@link EnvCredentialProvider}, which copies only the provider's
 * `envAllowlist` (for example `CODEX_API_KEY`) from `process.env`.
 */
export const CODEX_AGENT_DEFINITION: ExternalAgentDefinition<CodexSdkDriverConfig> =
  {
    provider: CODEX_PROVIDER,
    runtime: "sdk",
    createCredentialProvider: () => new EnvCredentialProvider(),
    createDriver: (options) => new CodexSdkDriver(options),
  };

/**
 * Options for {@link CodexAgent}: everything {@link ExternalAgent} accepts
 * except the provider, plus the options of the default driver.
 */
export interface CodexAgentConfig
  extends ExternalAgentDefinitionConfig<CodexSdkDriverConfig> {
  /**
   * Options for the default {@link CodexSdkDriver}, for example `model`,
   * `allowUnenforcedNetwork` or `webSearchMode`.
   *
   * @remarks
   * Give either `driver` or `driverOptions`. With both, the constructor
   * throws an `InputValidationError`, because the options would be ignored.
   * A clone reuses the built driver; to clone with other options, pass a
   * new `driver` to `clone()`.
   */
  driverOptions?: CodexSdkDriverConfig;
}

/**
 * An ADK agent that runs OpenAI Codex through the Codex SDK.
 *
 * @example
 * ```ts
 * const agent = new CodexAgent({
 *   name: "codex",
 *   description: "Edits code in the repository",
 *   workingDirectory: process.cwd(),
 * });
 * ```
 */
export class CodexAgent extends ExternalAgent {
  /** The definition this class is built from. */
  static readonly definition = CODEX_AGENT_DEFINITION;

  /**
   * Creates an external agent backed by the Codex SDK.
   *
   * @param config - Agent options. `driver` replaces the default Codex SDK
   * driver; `driverOptions` configure it.
   * @throws {@link InputValidationError} when both `driver` and
   * `driverOptions` are given.
   */
  constructor(config: CodexAgentConfig) {
    super(createExternalAgentConfig(CODEX_AGENT_DEFINITION, config));
  }
}
