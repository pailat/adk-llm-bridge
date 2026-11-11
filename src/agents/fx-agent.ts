import {
  createExternalAgentConfig,
  type ExternalAgentDefinition,
  type ExternalAgentDefinitionConfig,
} from "./agent-schema.js";
import { EnvCredentialProvider } from "./auth/env.js";
import { FxCliDriver, type FxCliDriverConfig } from "./driver/fx-cli.js";
import { ExternalAgent } from "./external-agent.js";
import { FX_PROVIDER } from "./provider/fx.js";

/** Default definition of the fx agent: the CLI driver and env credentials. */
export const FX_AGENT_DEFINITION: ExternalAgentDefinition<FxCliDriverConfig> = {
  provider: FX_PROVIDER,
  runtime: "cli",
  createCredentialProvider: () => new EnvCredentialProvider(),
  createDriver: (options) => new FxCliDriver(options),
};

/**
 * Options for {@link FxAgent}: everything {@link ExternalAgent} accepts
 * except the provider, plus the options of the default driver.
 */
export interface FxAgentConfig
  extends ExternalAgentDefinitionConfig<FxCliDriverConfig> {
  /**
   * Options for the default {@link FxCliDriver}, for example `model`,
   * `inheritHostConfig` or `allowUnenforcedNetwork`.
   *
   * @remarks
   * Give either `driver` or `driverOptions`. With both, the constructor
   * throws an `InputValidationError`, because the options would be ignored.
   * A clone reuses the built driver; to clone with other options, pass a
   * new `driver` to `clone()`.
   */
  driverOptions?: FxCliDriverConfig;
}

/**
 * An ADK agent that runs the fx coding agent as a subprocess.
 *
 * @remarks
 * fx has no sandbox, so the agent refuses what it cannot enforce: see
 * {@link FxCliDriver}. A model and `inheritHostConfig: true` are required.
 *
 * @example
 * ```ts
 * const agent = new FxAgent({
 *   name: "fx",
 *   description: "Answers questions about the repository",
 *   driverOptions: {
 *     model: "anthropic/claude-haiku-5.5",
 *     inheritHostConfig: true,
 *   },
 *   permissions: { mode: "ask", allowNetwork: true },
 * });
 * ```
 */
export class FxAgent extends ExternalAgent {
  /** The definition this class is built from. */
  static readonly definition = FX_AGENT_DEFINITION;

  /**
   * Creates an external agent backed by the fx CLI.
   *
   * @param config - Agent options. `driver` replaces the default fx driver;
   * `driverOptions` configure it.
   * @throws {@link InputValidationError} when both `driver` and
   * `driverOptions` are given.
   * @throws {@link ExternalAgentPolicyError} as {@link FxCliDriver}.
   */
  constructor(config: FxAgentConfig) {
    super(createExternalAgentConfig(FX_AGENT_DEFINITION, config));
  }
}
