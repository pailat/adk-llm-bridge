/**
 * Typed environment resolution + validation.
 *
 * No dotenv dependency: Bun auto-loads `.env` from the current working
 * directory, so these examples must be run from this folder. Fails fast with a
 * friendly hint when the required API key is missing.
 */
import type { AppConfig, ProviderName } from "./types";

/** All supported providers, their default model, and required env key. */
export const PROVIDERS: Record<
  ProviderName,
  { defaultModel: string; envKey: string }
> = {
  anthropic: { defaultModel: "claude-sonnet-4-6", envKey: "ANTHROPIC_API_KEY" },
  openai: { defaultModel: "gpt-4o", envKey: "OPENAI_API_KEY" },
  "ai-gateway": {
    defaultModel: "anthropic/claude-sonnet-4.6",
    envKey: "AI_GATEWAY_API_KEY",
  },
  openrouter: {
    defaultModel: "openai/gpt-4o",
    envKey: "OPENROUTER_API_KEY",
  },
  xai: { defaultModel: "grok-4.3", envKey: "XAI_API_KEY" },
};

// Reasoning/thinking is model-gated; only these providers' default models reason.
const REASONING_PROVIDERS: ReadonlySet<ProviderName> = new Set([
  "anthropic",
  "xai",
]);

/**
 * A reasoning-capable model per provider. The `reasoning` demo uses these so it
 * always exercises extended thinking — verified to emit thought parts and/or
 * `thoughtsTokenCount`. Override with `--model` to try another reasoning model.
 */
export const REASONING_MODELS: Record<ProviderName, string> = {
  anthropic: "claude-sonnet-4-6", // native extended thinking (thought parts)
  openai: "gpt-5.5", // reasoning_effort + reasoning_tokens
  "ai-gateway": "openai/gpt-5.5", // OpenAI reasoning via the gateway
  openrouter: "deepseek/deepseek-r1", // returns reasoning content
  xai: "grok-4.3", // Grok reasoning (thought parts)
};

/** The reasoning model for a config: an explicit --model wins, else the default reasoner. */
export function reasoningModelFor(config: AppConfig): string {
  return config.modelExplicit
    ? config.model
    : REASONING_MODELS[config.provider];
}

function resolveProvider(raw: string | undefined): ProviderName {
  const value = (raw ?? "anthropic").toLowerCase();
  if (value in PROVIDERS) return value as ProviderName;
  throw new Error(
    `Unknown provider "${raw}". Supported: ${Object.keys(PROVIDERS).join(", ")}.`,
  );
}

/**
 * Resolve config from env + optional CLI overrides.
 * Priority for each field: override > env > default.
 */
export function loadConfig(overrides?: {
  provider?: string;
  model?: string;
}): AppConfig {
  const provider = resolveProvider(overrides?.provider ?? process.env.PROVIDER);
  const { defaultModel, envKey } = PROVIDERS[provider];

  const explicitModel = overrides?.model ?? process.env.MODEL;
  const model = explicitModel ?? defaultModel;
  const apiKey = process.env[envKey];

  if (!apiKey) {
    throw new Error(
      `Missing ${envKey}. Set it in .env (run: cp .env.example .env).`,
    );
  }

  if (!REASONING_PROVIDERS.has(provider) && !explicitModel) {
    console.warn(
      `[config] "${model}" is not a reasoning model, so the reasoning demo ` +
        `will use "${REASONING_MODELS[provider]}" for ${provider} ` +
        `(override with --model). All other demos use "${model}".`,
    );
  }

  return { provider, model, apiKey, modelExplicit: explicitModel !== undefined };
}
