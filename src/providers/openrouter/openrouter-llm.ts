import { OpenAICompatibleLlm } from "../../core/openai-compatible-llm";
import { getProviderConfig } from "../../config";
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_MODEL_PATTERNS,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  OPENROUTER_ENV,
} from "../../constants";
import type { OpenRouterConfig } from "../../types";

/**
 * LLM implementation for OpenRouter.
 * Supports 100+ models with advanced routing and fallback features.
 *
 * @example
 * ```typescript
 * const llm = new OpenRouterLlm({
 *   model: "anthropic/claude-sonnet-4",
 *   siteUrl: "https://myapp.com",
 *   appName: "My App",
 *   provider: {
 *     sort: "latency",
 *     allow_fallbacks: true,
 *   },
 * });
 * ```
 */
export class OpenRouterLlm extends OpenAICompatibleLlm {
  static readonly supportedModels = OPENROUTER_MODEL_PATTERNS;

  private readonly openRouterConfig: OpenRouterConfig;

  constructor(config: OpenRouterConfig) {
    const globalConfig = getProviderConfig("openrouter") ?? {};

    const baseURL =
      config.baseURL ?? globalConfig.baseURL ?? OPENROUTER_BASE_URL;

    const apiKey =
      config.apiKey ??
      globalConfig.apiKey ??
      process.env[OPENROUTER_ENV.API_KEY] ??
      "";

    // Build default headers for OpenRouter ranking
    const defaultHeaders: Record<string, string> = {};

    const siteUrl =
      config.siteUrl ??
      globalConfig.siteUrl ??
      process.env[OPENROUTER_ENV.SITE_URL];

    const appName =
      config.appName ??
      globalConfig.appName ??
      process.env[OPENROUTER_ENV.APP_NAME];

    if (siteUrl) {
      defaultHeaders["HTTP-Referer"] = siteUrl;
    }
    if (appName) {
      defaultHeaders["X-Title"] = appName;
    }

    super(config, {
      baseURL,
      apiKey,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      defaultHeaders:
        Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
    });

    this.openRouterConfig = config;
  }

  protected getErrorPrefix(): string {
    return "OPENROUTER";
  }

  /**
   * Add OpenRouter-specific request options (provider preferences).
   */
  protected getProviderRequestOptions(): Record<string, unknown> {
    const options: Record<string, unknown> = {};

    if (this.openRouterConfig.provider) {
      options.provider = this.openRouterConfig.provider;
    }

    return options;
  }
}
