import { InputValidationError } from "@google/adk";
import type { ExternalAgentCredentialProvider } from "./auth/credential-provider.js";
import { ExternalAgent, type ExternalAgentConfig } from "./external-agent.js";
import type { ExternalAgentDriver } from "./external-agent-driver.js";
import type { ExternalAgentProviderDefinition } from "./provider/schema.js";

/** How a runtime is integrated: through an SDK, a CLI subprocess, or a JSONL stream. Other strings are accepted. */
export type ExternalAgentRuntimeKind = "sdk" | "cli" | "jsonl" | (string & {});

/**
 * Everything needed to build an agent for one provider: its metadata, default
 * driver and default credential provider.
 *
 * @typeParam DriverOptions - Options of the default driver, passed as
 * `driverOptions` to {@link createExternalAgent}, `registry.create()` or the
 * provider agent's constructor.
 */
export interface ExternalAgentDefinition<DriverOptions = unknown> {
  /** Provider metadata used in events, auth, and registry lookups. */
  provider: ExternalAgentProviderDefinition;
  /** Runtime integration style. Useful for docs, diagnostics, and future factories. */
  runtime?: ExternalAgentRuntimeKind;
  /**
   * Creates the default driver for this runtime.
   *
   * @param options - The agent's `driverOptions`, when given.
   */
  createDriver?(options?: DriverOptions): ExternalAgentDriver;
  /** Creates the default credential provider for this runtime. */
  createCredentialProvider?: () => ExternalAgentCredentialProvider;
}

/**
 * Agent options for a given definition: {@link ExternalAgentConfig} without
 * the provider, which the definition supplies, plus the options of the
 * definition's default driver.
 *
 * @typeParam DriverOptions - Options of the default driver.
 */
export type ExternalAgentDefinitionConfig<DriverOptions = unknown> = Omit<
  ExternalAgentConfig,
  "provider"
> & {
  /**
   * Options for the definition's default driver.
   *
   * @remarks
   * Give either `driver` or `driverOptions`: `driverOptions` configure the
   * default driver, which `driver` replaces. A clone reuses the built
   * driver; to clone with other options, pass a new `driver` to `clone()`.
   */
  driverOptions?: DriverOptions;
};

/**
 * Merges a definition's defaults into agent options.
 *
 * @remarks
 * A `driver` or `credentialProvider` in `config` wins over the definition's
 * default. `driverOptions` are passed to the definition's `createDriver` and
 * are not part of the result, so `clone()` reuses the built driver. The
 * provider always comes from the definition.
 *
 * @param definition - The agent definition.
 * @param config - Agent options.
 * @returns A complete {@link ExternalAgentConfig}.
 * @throws {@link InputValidationError} when both `driver` and
 * `driverOptions` are given, or when `driverOptions` are given and the
 * definition has no `createDriver`: in both cases the options would be
 * ignored.
 */
export function createExternalAgentConfig<DriverOptions>(
  definition: ExternalAgentDefinition<DriverOptions>,
  config: ExternalAgentDefinitionConfig<DriverOptions>,
): ExternalAgentConfig {
  const { driverOptions: given, ...rest } = config;
  // `null` from untyped code counts as no options.
  const driverOptions = given ?? undefined;
  if (driverOptions !== undefined) {
    if (rest.driver !== undefined) {
      throw new InputValidationError(
        `Agent "${config.name}": pass either \`driver\` or \`driverOptions\`, not both. \`driverOptions\` configure the default driver, which \`driver\` replaces.`,
      );
    }
    if (!definition.createDriver) {
      throw new InputValidationError(
        `Agent "${config.name}": the "${definition.provider.id}" definition has no default driver, so \`driverOptions\` cannot be applied. Pass a \`driver\` instead.`,
      );
    }
  }
  const driver =
    rest.driver ??
    (driverOptions === undefined
      ? definition.createDriver?.()
      : definition.createDriver?.(driverOptions));
  const credentialProvider =
    rest.credentialProvider ?? definition.createCredentialProvider?.();

  return {
    ...rest,
    provider: definition.provider,
    ...(driver ? { driver } : {}),
    ...(credentialProvider ? { credentialProvider } : {}),
  };
}

/**
 * Creates an {@link ExternalAgent} from a definition.
 *
 * @param definition - The agent definition.
 * @param config - Agent options, including `driverOptions` for the default
 * driver.
 * @returns The new agent.
 * @throws {@link InputValidationError} as {@link createExternalAgentConfig}.
 */
export function createExternalAgent<DriverOptions>(
  definition: ExternalAgentDefinition<DriverOptions>,
  config: ExternalAgentDefinitionConfig<DriverOptions>,
): ExternalAgent {
  return new ExternalAgent(createExternalAgentConfig(definition, config));
}
