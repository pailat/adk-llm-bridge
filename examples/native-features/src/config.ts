/**
 * Typed environment resolution + validation.
 *
 * No dotenv dependency: Bun auto-loads `.env` from the current working
 * directory, so these examples must be run from this folder. Fails fast with a
 * friendly hint when the required API key is missing.
 */
import type { AppConfig, ProviderName } from "./types";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
export const DEFAULT_OPENAI_MODEL = "gpt-4o";

function resolveProvider(raw: string | undefined): ProviderName {
  const value = (raw ?? "anthropic").toLowerCase();
  if (value === "openai") return "openai";
  if (value === "anthropic") return "anthropic";
  throw new Error(
    `Unknown provider "${raw}". Supported: anthropic, openai.`,
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

  const model =
    overrides?.model ??
    process.env.MODEL ??
    (provider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL);

  const envKey = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const apiKey = process.env[envKey];

  if (!apiKey) {
    throw new Error(
      `Missing ${envKey}. Set it in .env (run: cp .env.example .env).`,
    );
  }

  if (provider !== "anthropic") {
    console.warn(
      `[config] Provider "${provider}" selected. Note: the reasoning and ` +
        `multimodal demos are tuned for Anthropic (claude-sonnet-4-6); ` +
        `behavior may differ on other providers/models.`,
    );
  }

  return { provider, model, apiKey };
}
