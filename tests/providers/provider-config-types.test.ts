/**
 * Provider classes, factories and register functions take their provider's
 * own config type. The `@ts-expect-error` lines and the typed calls are
 * checked by `tsc` once test files are type-checked; at run time the tests
 * check that the options reach the client.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { resetAllConfigs } from "../../src/config.js";
import {
  AIGateway,
  AIGatewayLlm,
  AnthropicLlm,
  type AnthropicRegisterOptions,
  OpenAI,
  OpenAILlm,
  type OpenAIRegisterOptions,
  OpenRouter,
  OpenRouterLlm,
  type OpenRouterRegisterOptions,
  type RegisterOptions,
  registerAIGateway,
  registerAnthropic,
  registerOpenAI,
  registerOpenRouter,
  registerXAI,
  XAI,
  XAILlm,
  type XAIRegisterOptions,
} from "../../src/index.js";
import { _resetAIGatewayRegistration } from "../../src/providers/ai-gateway/index.js";
import { _resetAnthropicRegistration } from "../../src/providers/anthropic/index.js";
import { _resetOpenAIRegistration } from "../../src/providers/openai/index.js";
import { _resetOpenRouterRegistration } from "../../src/providers/openrouter/index.js";
import { _resetXAIRegistration } from "../../src/providers/xai/index.js";

type ClientView = {
  client: {
    baseURL: string;
    timeout: number;
    maxRetries: number;
    _options: { defaultHeaders?: Record<string, string> };
  };
};
const clientOf = (llm: unknown) => (llm as ClientView).client;

afterEach(() => {
  _resetOpenAIRegistration();
  _resetXAIRegistration();
  _resetAIGatewayRegistration();
  _resetOpenRouterRegistration();
  _resetAnthropicRegistration();
  resetAllConfigs();
});

describe("provider classes and factories take their own config type", () => {
  it("OpenAI accepts organization and project", () => {
    const llm = OpenAI("gpt-4o", {
      apiKey: "k",
      organization: "org-1",
      project: "proj-1",
    });
    const viaClass = new OpenAILlm({
      model: "gpt-4o",
      apiKey: "k",
      organization: "org-2",
    });
    expect(clientOf(llm)._options.defaultHeaders).toMatchObject({
      "OpenAI-Organization": "org-1",
      "OpenAI-Project": "proj-1",
    });
    expect(clientOf(viaClass)._options.defaultHeaders).toMatchObject({
      "OpenAI-Organization": "org-2",
    });
  });

  it("OpenRouter accepts provider preferences, siteUrl and appName", () => {
    const llm = OpenRouter("anthropic/claude-sonnet-4", {
      apiKey: "k",
      siteUrl: "https://example.com",
      appName: "demo",
      provider: { order: ["Anthropic"], sort: "price" },
    });
    const viaClass = new OpenRouterLlm({
      model: "anthropic/claude-sonnet-4",
      apiKey: "k",
      provider: { only: ["Anthropic"] },
    });
    expect(clientOf(llm)._options.defaultHeaders).toMatchObject({
      "HTTP-Referer": "https://example.com",
      "X-Title": "demo",
    });
    expect(viaClass.model).toBe("anthropic/claude-sonnet-4");
  });

  it("xAI and AI Gateway classes take model and apiKey", () => {
    const xai = new XAILlm({ model: "grok-4", apiKey: "k", timeout: 5000 });
    const gateway = new AIGatewayLlm({ model: "openai/gpt-4o", apiKey: "k" });
    expect(clientOf(xai).timeout).toBe(5000);
    expect(gateway.model).toBe("openai/gpt-4o");
    expect(XAI("grok-4", { apiKey: "k" }).model).toBe("grok-4");
    expect(AIGateway("openai/gpt-4o", { apiKey: "k" }).model).toBe(
      "openai/gpt-4o",
    );
  });

  it("rejects options of another provider at compile time", () => {
    // @ts-expect-error `provider` is an OpenRouter option, not an OpenAI one.
    OpenAI("gpt-4o", { apiKey: "k", provider: { order: [] } });
    // @ts-expect-error `organization` is an OpenAI option.
    XAI("grok-4", { apiKey: "k", organization: "org" });
    expect(true).toBe(true);
  });
});

describe("register options take timeout, maxRetries and baseURL", () => {
  it("typed register options accept the documented fields", () => {
    const gateway: RegisterOptions = { timeout: 1000, maxRetries: 1 };
    const openRouter: OpenRouterRegisterOptions = {
      timeout: 1000,
      maxRetries: 1,
    };
    const openai: OpenAIRegisterOptions = {
      baseURL: "https://proxy.example.com/v1",
      timeout: 1000,
      maxRetries: 1,
    };
    const xai: XAIRegisterOptions = {
      baseURL: "https://proxy.example.com/v1",
      timeout: 1000,
      maxRetries: 1,
    };
    const anthropic: AnthropicRegisterOptions = {
      baseURL: "https://proxy.example.com",
    };
    expect([gateway, openRouter, openai, xai, anthropic]).toHaveLength(5);
  });

  it("each register function takes its own typed options", () => {
    const gateway: RegisterOptions = { apiKey: "k", timeout: 1000 };
    const openRouter: OpenRouterRegisterOptions = {
      apiKey: "k",
      maxRetries: 1,
    };
    const openai: OpenAIRegisterOptions = {
      apiKey: "k",
      baseURL: "http://localhost:1/v1",
    };
    const xai: XAIRegisterOptions = {
      apiKey: "k",
      baseURL: "http://localhost:2/v1",
    };
    const anthropic: AnthropicRegisterOptions = { apiKey: "k" };
    registerAIGateway(gateway);
    registerOpenRouter(openRouter);
    registerOpenAI(openai);
    registerXAI(xai);
    registerAnthropic(anthropic);
    expect(clientOf(new OpenAILlm({ model: "gpt-4o" })).baseURL).toBe(
      "http://localhost:1/v1",
    );
  });

  it("rejects an unknown register option at compile time", () => {
    _resetOpenAIRegistration();
    _resetXAIRegistration();
    _resetAIGatewayRegistration();
    _resetOpenRouterRegistration();
    _resetAnthropicRegistration();
    // @ts-expect-error `apiKy` is not an option.
    registerOpenRouter({ apiKy: "k" });
    // @ts-expect-error `apiKy` is not an option.
    registerOpenAI({ apiKy: "k" });
    // @ts-expect-error `apiKy` is not an option.
    registerXAI({ apiKy: "k" });
    // @ts-expect-error `apiKy` is not an option.
    registerAIGateway({ apiKy: "k" });
    // @ts-expect-error `apiKy` is not an option.
    registerAnthropic({ apiKy: "k" });
    expect(true).toBe(true);
  });

  it("the registered options reach models created afterwards", () => {
    registerOpenAI({
      apiKey: "k",
      baseURL: "https://openai-proxy.example.com/v1",
      timeout: 7000,
      maxRetries: 0,
    });
    registerXAI({ apiKey: "k", baseURL: "https://xai-proxy.example.com/v1" });
    registerAIGateway({ apiKey: "k", timeout: 9000, maxRetries: 4 });

    const openai = clientOf(new OpenAILlm({ model: "gpt-4o" }));
    expect(openai.baseURL).toBe("https://openai-proxy.example.com/v1");
    expect(openai.timeout).toBe(7000);
    expect(openai.maxRetries).toBe(0);
    expect(clientOf(new XAILlm({ model: "grok-4" })).baseURL).toBe(
      "https://xai-proxy.example.com/v1",
    );
    const gateway = clientOf(new AIGatewayLlm({ model: "openai/gpt-4o" }));
    expect(gateway.timeout).toBe(9000);
    expect(gateway.maxRetries).toBe(4);
  });

  it("OpenRouter and Anthropic register options reach their clients", () => {
    registerOpenRouter({ apiKey: "k", timeout: 6000, maxRetries: 2 });
    registerAnthropic({
      apiKey: "k",
      baseURL: "https://anthropic-proxy.example.com",
      timeout: 8000,
      maxRetries: 1,
    });

    const openRouter = clientOf(
      new OpenRouterLlm({ model: "anthropic/claude-sonnet-4" }),
    );
    expect(openRouter.timeout).toBe(6000);
    expect(openRouter.maxRetries).toBe(2);
    const anthropic = clientOf(new AnthropicLlm({ model: "claude-sonnet-4" }));
    expect(anthropic.baseURL).toBe("https://anthropic-proxy.example.com");
    expect(anthropic.timeout).toBe(8000);
    expect(anthropic.maxRetries).toBe(1);
  });
});
