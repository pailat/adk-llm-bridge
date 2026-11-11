/**
 * The model a driver runs is the driver's `model` option and nothing else.
 * This module holds the checks every built-in driver shares: the model id
 * grammar, the router and default aliases `requireExplicitModel` refuses,
 * the `args` and config keys that would set or route the model, and the
 * environment variables that would remap it.
 *
 * @internal
 */

import {
  EXTERNAL_AGENT_MODEL_INVALID,
  EXTERNAL_AGENT_MODEL_OVERRIDE,
  EXTERNAL_AGENT_MODEL_REQUIRED,
  ExternalAgentPolicyError,
} from "./policy-errors.js";
import { findPinnedArgOverride, type PinnedFlags } from "./subprocess-jsonl.js";

/** Longest model id a driver accepts. */
export const MODEL_ID_MAX_LENGTH = 256;

/**
 * Whether a value is a usable model id: a string of 1 to 256 characters with
 * no whitespace and no control character, which does not start with `-`
 * (so a CLI can never read it as a flag).
 *
 * @param value - The configured model.
 * @returns `true` for a well-formed id.
 * @internal
 */
export function isModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MODEL_ID_MAX_LENGTH &&
    !/[\s\p{Cc}]/u.test(value) &&
    !value.startsWith("-")
  );
}

/** Model names that let a runtime choose the model, per built-in provider id. */
export interface ModelAliasDenylist {
  /** Names refused as a whole (compared case-insensitively). */
  readonly exact: readonly string[];
  /** Names refused when the id starts with one of them (case-insensitive). */
  readonly prefixes: readonly string[];
}

/**
 * The router and default aliases of each built-in runtime. With
 * `requireExplicitModel`, a driver (and the workflow factory, for these
 * provider ids) refuses them: they name no model, the runtime or account
 * picks one. Plain aliases such as `opus` stay allowed.
 *
 * Claude: `default` is the account or organization default, `best` picks a
 * model family by availability, and `opusplan` switches models between
 * planning and execution. Gemini: `auto` and `auto-*` hand each turn to the
 * CLI's router. Codex has none. Reviewed against
 * {@link MODEL_ALIAS_DENYLIST_REVIEW}.
 *
 * @internal
 */
export const MODEL_ALIAS_DENYLIST: Readonly<
  Record<"claude" | "codex" | "gemini-cli", ModelAliasDenylist>
> = Object.freeze({
  claude: Object.freeze({
    exact: Object.freeze(["default", "best", "opusplan", "opusplan[1m]"]),
    prefixes: Object.freeze([]),
  }),
  codex: Object.freeze({
    exact: Object.freeze([]),
    prefixes: Object.freeze([]),
  }),
  "gemini-cli": Object.freeze({
    exact: Object.freeze(["auto"]),
    prefixes: Object.freeze(["auto-"]),
  }),
});

/**
 * Where the alias denylist comes from.
 *
 * @internal
 */
export const MODEL_ALIAS_DENYLIST_REVIEW = Object.freeze({
  claude:
    "literals in the Claude Code 2.1.319 bundle (@anthropic-ai/claude-agent-sdk 0.3.319)",
  "gemini-cli": "Gemini CLI router aliases from the upstream documentation",
});

/**
 * Whether `model` is one of the aliases in `denylist`. The match ignores
 * case and does not trim: the grammar already refuses whitespace.
 *
 * @param model - A well-formed model id.
 * @param denylist - The runtime's aliases.
 * @returns `true` when the runtime would choose the model.
 * @internal
 */
export function isRouterAlias(
  model: string,
  denylist: ModelAliasDenylist,
): boolean {
  const name = model.toLowerCase();
  return (
    denylist.exact.includes(name) ||
    denylist.prefixes.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * Checks a driver's `model` option when the driver is built.
 *
 * @param driver - Driver name for the message.
 * @param model - The configured `model`.
 * @param requireExplicitModel - The driver option of the same name.
 * @param denylist - The runtime's router and default aliases.
 * @returns The model id, or `undefined` when none is configured.
 * @throws {@link ExternalAgentPolicyError} `EXTERNAL_AGENT_MODEL_INVALID`
 * when `model` is given and is not a well-formed id (see {@link isModelId}).
 * @throws {@link ExternalAgentPolicyError} `EXTERNAL_AGENT_MODEL_REQUIRED`
 * when `requireExplicitModel` is set and `model` is absent or an alias in
 * `denylist`.
 * @internal
 */
export function assertModelOption(
  driver: string,
  model: unknown,
  requireExplicitModel: boolean,
  denylist: ModelAliasDenylist,
): string | undefined {
  if (model !== undefined && !isModelId(model)) {
    throw new ExternalAgentPolicyError(
      EXTERNAL_AGENT_MODEL_INVALID,
      `${driver}: model must be a model id: a string of 1 to ${MODEL_ID_MAX_LENGTH} characters, without whitespace or control characters, that does not start with "-".`,
    );
  }
  if (!requireExplicitModel) {
    return model;
  }
  if (model === undefined) {
    throw new ExternalAgentPolicyError(
      EXTERNAL_AGENT_MODEL_REQUIRED,
      `${driver}: requireExplicitModel is set, so the driver needs a model. Set model to the id the agent must run.`,
    );
  }
  if (isRouterAlias(model, denylist)) {
    throw new ExternalAgentPolicyError(
      EXTERNAL_AGENT_MODEL_REQUIRED,
      `${driver}: requireExplicitModel is set, and "${model}" lets the runtime choose the model. Set model to a model id or a plain alias such as "opus".`,
    );
  }
  return model;
}

/**
 * Claude CLI flags that set the model or switch it during the run. `args`
 * may never pass them, even with `allowPolicyOverrideArgs`.
 *
 * @internal
 */
export const CLAUDE_CLI_MODEL_FLAGS: PinnedFlags = Object.freeze({
  // No one-letter spelling: a cluster such as `-pv` cannot set the model.
  flags: Object.freeze(["--model", "--fallback-model"]),
});

/**
 * Codex config keys that set the model, or the provider, endpoint, model
 * catalog or profile that decides which model answers. Refused in Codex CLI `-c`/`--config`
 * args and anywhere in the Codex SDK `config` object. A key also covers the
 * keys below it (`profiles` covers `profiles.x.model`), but not a longer
 * name (`model_reasoning_effort` stays allowed).
 *
 * @internal
 */
export const CODEX_MODEL_CONFIG_KEYS: readonly string[] = Object.freeze([
  "model",
  "model_provider",
  "model_providers",
  "oss_provider",
  "openai_base_url",
  "chatgpt_base_url",
  "model_catalog_json",
  "model_catalog_url",
  "profile",
  "profiles",
]);

/**
 * Codex CLI flags and config keys that set or route the model. `args` may
 * never pass them, even with `allowPolicyOverrideArgs`.
 *
 * @internal
 */
export const CODEX_CLI_MODEL_FLAGS: PinnedFlags = Object.freeze({
  flags: Object.freeze([
    "--model",
    "-m",
    "--oss",
    "--local-provider",
    "--profile",
    "-p",
  ]),
  configFlags: Object.freeze(["-c", "--config"]),
  configKeys: CODEX_MODEL_CONFIG_KEYS,
  // Clap reads `-hm x` as `-h -m x`.
  booleanShortFlags: Object.freeze(["-h", "-V"]),
});

/**
 * What the model flag tables were last reviewed against. The version-bump
 * test compares these with the installed SDKs, like the policy flag lists.
 *
 * @internal
 */
export const MODEL_FLAGS_REVIEW = Object.freeze({
  claudeCliVersion: "2.1.319",
  claudeSource: "flag strings in the Claude Code bundle of the Agent SDK",
  codexCliVersion: "0.167.0",
  codexSource:
    "`codex exec --help` and the config keys read by the @openai/codex binary",
});

function overrideMessage(driver: string, what: string): string {
  return `${driver}: ${what} sets or routes the model, which only the driver's model option may do, so the model the bridge reports would be wrong. Remove it and set model instead. allowPolicyOverrideArgs does not lift this.`;
}

/**
 * Refuses extra `args` that set or route the model. Unlike the policy flag
 * check, `allowPolicyOverrideArgs` does not lift it.
 *
 * @param driver - Driver name for the message.
 * @param args - The configured extra arguments, already checked to be
 * strings.
 * @param table - The runtime's model flags.
 * @throws {@link ExternalAgentPolicyError} `EXTERNAL_AGENT_MODEL_OVERRIDE`
 * when an entry matches the table.
 * @internal
 */
export function assertNoModelOverride(
  driver: string,
  args: readonly string[] | undefined,
  table: PinnedFlags,
): void {
  if (args === undefined) {
    return;
  }
  const override = findPinnedArgOverride(args, table);
  if (override !== undefined) {
    throw new ExternalAgentPolicyError(
      EXTERNAL_AGENT_MODEL_OVERRIDE,
      overrideMessage(driver, `the args entry "${override}"`),
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenInto(value: unknown, prefix: string, keys: string[]): void {
  const entries = Object.entries(value as Record<string, unknown>);
  if (prefix && entries.length === 0) {
    keys.push(prefix);
    return;
  }
  for (const [key, child] of entries) {
    if (child === undefined) {
      continue;
    }
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) {
      flattenInto(child, path, keys);
    } else {
      keys.push(path);
    }
  }
}

/**
 * The keys of the `--config key=value` overrides `@openai/codex-sdk` builds
 * from a `config` object: nested plain objects become dotted paths, an empty
 * nested object is sent as `path={}`, and `undefined` values are skipped.
 * Mirrors the SDK's own flattening, which a parity test checks.
 *
 * @param config - The Codex SDK `config` object.
 * @returns The keys, in the order the SDK sends them.
 * @internal
 */
export function flattenCodexConfigKeys(config: unknown): string[] {
  const keys: string[] = [];
  if (isPlainObject(config)) {
    flattenInto(config, "", keys);
  }
  return keys;
}

/**
 * Refuses a Codex SDK `config` object that sets or routes the model, at any
 * depth and in any spelling the SDK would send (`{profiles: {x: {model}}}`,
 * `{'"model"': …}`, `{"model_providers.x": …}`).
 *
 * @param driver - Driver name for the message.
 * @param config - The Codex SDK `config` object.
 * @throws {@link ExternalAgentPolicyError} `EXTERNAL_AGENT_MODEL_OVERRIDE`
 * when a key matches {@link CODEX_MODEL_CONFIG_KEYS}.
 * @internal
 */
export function assertNoCodexConfigModelOverride(
  driver: string,
  config: unknown,
): void {
  const args = flattenCodexConfigKeys(config).flatMap((key) => [
    "--config",
    `${key}=`,
  ]);
  const override = findPinnedArgOverride(args, {
    flags: [],
    configFlags: ["--config"],
    configKeys: CODEX_MODEL_CONFIG_KEYS,
  });
  if (override !== undefined) {
    const key = override.replace(/^--config /, "").replace(/=$/, "");
    throw new ExternalAgentPolicyError(
      EXTERNAL_AGENT_MODEL_OVERRIDE,
      overrideMessage(driver, `the config key "${key}"`),
    );
  }
}

/**
 * Environment variables that make Claude Code run another model than
 * `--model`, or remap the aliases it resolves.
 *
 * @internal
 */
export const CLAUDE_MODEL_ENV: readonly string[] = Object.freeze([
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
]);

/**
 * Environment variables that send Codex requests to another endpoint or
 * local provider, so another model than `--model` may answer.
 *
 * @internal
 */
export const CODEX_MODEL_ENV: readonly string[] = Object.freeze([
  "OPENAI_BASE_URL",
  "CODEX_OSS_BASE_URL",
  "CODEX_OSS_PORT",
]);

/**
 * Environment variables that set the Gemini CLI model.
 *
 * @internal
 */
export const GEMINI_MODEL_ENV: readonly string[] = Object.freeze([
  "GEMINI_MODEL",
]);

/**
 * Where the model env tables come from.
 *
 * @internal
 */
export const MODEL_ENV_REVIEW = Object.freeze({
  claude:
    "variable names in the Claude Code 2.1.319 bundle (@anthropic-ai/claude-agent-sdk 0.3.319)",
  codex: "variable names in the @openai/codex 0.167.0 binary",
  gemini: "Gemini CLI configuration reference",
});

/**
 * The first variable of `env` whose name (compared case-insensitively) is in
 * `names`.
 *
 * @param env - The complete environment the run would start with.
 * @param names - The runtime's model variables.
 * @returns The variable's name as it appears in `env`, or `undefined`.
 * @internal
 */
export function findModelEnv(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string | undefined {
  return Object.keys(env).find(
    (name) => env[name] !== undefined && names.includes(name.toUpperCase()),
  );
}

/**
 * The refusal for a run whose environment would carry a model variable. The
 * message names the variable, never its value.
 *
 * @param driver - Driver name for the message.
 * @param env - The complete environment the run would start with.
 * @param names - The runtime's model variables.
 * @returns An `EXTERNAL_AGENT_MODEL_OVERRIDE` error, or `undefined` when the
 * environment carries none.
 * @internal
 */
export function modelEnvRefusal(
  driver: string,
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): ExternalAgentPolicyError | undefined {
  const name = findModelEnv(env, names);
  return name === undefined
    ? undefined
    : new ExternalAgentPolicyError(
        EXTERNAL_AGENT_MODEL_OVERRIDE,
        `${driver}: the run's environment sets ${name}, which would change the model the runtime runs, so the model the bridge reports would be wrong. Remove ${name} from the provider's envAllowlist or the credential, and set the driver's model option instead.`,
      );
}

/**
 * The reason of the Gemini CLI read-only refusal.
 *
 * @internal
 */
export const GEMINI_PLAN_MODE_REASON =
  "Gemini CLI plan mode (read-only) may route turns to another model than `model`";
