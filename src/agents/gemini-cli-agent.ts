import {
  createExternalAgentConfig,
  type ExternalAgentDefinition,
  type ExternalAgentDefinitionConfig,
} from "./agent-schema.js";
import { EnvCredentialProvider } from "./auth/env.js";
import {
  GeminiCliDriver,
  type GeminiCliDriverConfig,
} from "./driver/gemini-cli.js";
import { ExternalAgent } from "./external-agent.js";
import { GEMINI_CLI_PROVIDER } from "./provider/gemini-cli.js";

/** Default definition of the Gemini CLI agent: the CLI driver and env credentials. */
export const GEMINI_CLI_AGENT_DEFINITION: ExternalAgentDefinition<GeminiCliDriverConfig> =
  {
    provider: GEMINI_CLI_PROVIDER,
    runtime: "cli",
    createCredentialProvider: () => new EnvCredentialProvider(),
    createDriver: (options) => new GeminiCliDriver(options),
  };

/**
 * Options for {@link GeminiCliAgent}: everything {@link ExternalAgent} accepts
 * except the provider, plus the options of the default driver.
 */
export interface GeminiCliAgentConfig
  extends ExternalAgentDefinitionConfig<GeminiCliDriverConfig> {
  /**
   * Options for the default {@link GeminiCliDriver}, for example
   * `killGraceMs`, `allowUnenforcedNetwork` or `command`.
   *
   * @remarks
   * Give either `driver` or `driverOptions`. With both, the constructor
   * throws an `InputValidationError`, because the options would be ignored.
   * A clone reuses the built driver; to clone with other options, pass a
   * new `driver` to `clone()`.
   */
  driverOptions?: GeminiCliDriverConfig;
}

/**
 * An ADK agent that runs the Gemini CLI as a subprocess.
 *
 * @example
 * ```ts
 * const agent = new GeminiCliAgent({
 *   name: "gemini",
 *   description: "Answers questions about the repository",
 * });
 * ```
 */
export class GeminiCliAgent extends ExternalAgent {
  /** The definition this class is built from. */
  static readonly definition = GEMINI_CLI_AGENT_DEFINITION;

  /**
   * Creates an external agent backed by the Gemini CLI.
   *
   * @param config - Agent options. `driver` replaces the default Gemini CLI
   * driver; `driverOptions` configure it.
   * @throws {@link InputValidationError} when both `driver` and
   * `driverOptions` are given.
   */
  constructor(config: GeminiCliAgentConfig) {
    super(createExternalAgentConfig(GEMINI_CLI_AGENT_DEFINITION, config));
  }
}
