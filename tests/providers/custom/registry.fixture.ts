import { LLMRegistry, type LlmRequest } from "@google/adk";
import type OpenAI from "openai";
import {
  AIGatewayLlm,
  Custom,
  CustomLlm,
  OpenRouterLlm,
  registerAIGateway,
  registerCustomProvider,
  registerOpenRouter,
} from "../../../src/index.js";

function writeResult(result: unknown): void {
  process.stdout.write(JSON.stringify(result));
}

function errorMessage(callback: () => void): string {
  try {
    callback();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected callback to throw");
}

async function main(): Promise<void> {
  switch (process.argv[2]) {
    case "coexist": {
      registerCustomProvider("issue84-ollama", {
        baseURL: "http://localhost:11434/v1",
        apiKey: "ollama-key",
        models: ["llama3"],
      });
      registerCustomProvider("issue84-vllm", {
        baseURL: "http://localhost:8000/v1",
        apiKey: "vllm-key",
        models: ["meta-llama/Llama-3-8b"],
      });

      const ollama = LLMRegistry.newLlm("issue84-ollama/llama3");
      const vllm = LLMRegistry.newLlm("issue84-vllm/meta-llama/Llama-3-8b");
      writeResult({
        ollamaIsCustom: ollama instanceof CustomLlm,
        ollamaModel: ollama.model,
        vllmIsCustom: vllm instanceof CustomLlm,
        vllmModel: vllm.model,
      });
      return;
    }

    case "captured": {
      const config = {
        baseURL: "https://registry.example.test/v1",
        apiKey: "captured-secret",
        headers: { "X-Registration": "captured" },
        models: ["team/remote-model"],
        providerOptions: {
          routing: {
            fallbacks: ["original-fallback"],
            metadata: { tier: "captured-tier" },
          },
        },
      };
      registerCustomProvider("issue84-captured", config);

      config.apiKey = "mutated-secret";
      config.headers["X-Registration"] = "mutated";
      config.models[0] = "mutated/model";
      config.providerOptions.routing.fallbacks[0] = "mutated-fallback";
      config.providerOptions.routing.metadata.tier = "mutated-tier";

      const llm = LLMRegistry.newLlm("issue84-captured/team/remote-model");
      const client = (
        llm as CustomLlm & {
          client: OpenAI;
        }
      ).client;
      const calls: Array<{
        model: string;
        routing?: {
          fallbacks: string[];
          metadata: { tier: string };
        };
      }> = [];
      client.chat.completions.create = (async (params: {
        model: string;
        routing?: {
          fallbacks: string[];
          metadata: { tier: string };
        };
      }) => {
        calls.push(params);
        return {
          id: "registry-test",
          object: "chat.completion",
          created: 0,
          model: "remote",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "ok",
                refusal: null,
              },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
        } as OpenAI.ChatCompletion;
      }) as typeof client.chat.completions.create;

      const request = {
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        liveConnectConfig: {},
        toolsDict: {},
      } as LlmRequest;
      for await (const _ of llm.generateContentAsync(request)) {
        // Drain the response so the SDK spy observes the complete request.
      }

      writeResult({
        apiKey: client.apiKey,
        header: (
          client as OpenAI & {
            _options: { defaultHeaders: Record<string, string> };
          }
        )._options.defaultHeaders["X-Registration"],
        model: calls[0]?.model,
        routing: calls[0]?.routing,
      });
      return;
    }

    case "validation": {
      registerCustomProvider("issue84-duplicate", {
        baseURL: "http://localhost:1234/v1",
        models: ["model"],
      });
      const duplicate = errorMessage(() =>
        registerCustomProvider("issue84-duplicate", {
          baseURL: "http://localhost:5678/v1",
          models: ["model"],
        }),
      );

      writeResult({ duplicate });
      return;
    }

    case "whitespace-model": {
      const prefix = "issue84-whitespace-model";
      const invalidRoute = `${prefix}/ \t\n`;
      const invalidModel = errorMessage(() =>
        registerCustomProvider(prefix, {
          baseURL: "http://localhost:1234/v1",
          models: [" \t\n"],
        }),
      );
      const invalidRouteResolution = errorMessage(() =>
        LLMRegistry.resolve(invalidRoute),
      );

      registerCustomProvider(prefix, {
        baseURL: "http://localhost:1234/v1",
        models: ["valid-model"],
      });
      const validLlm = LLMRegistry.newLlm(`${prefix}/valid-model`);

      writeResult({
        invalidModel,
        invalidRouteResolution,
        validIsCustom: validLlm instanceof CustomLlm,
        validModel: validLlm.model,
      });
      return;
    }

    case "partial-overlap": {
      class ExistingNamedLlm extends CustomLlm {
        static readonly supportedModels = [/issue84-partial\/owned-.*/];

        constructor({ model }: { model: string }) {
          super({
            model,
            baseURL: "http://localhost:1234/v1",
          });
        }
      }

      LLMRegistry.register(ExistingNamedLlm);
      const conflict = errorMessage(() =>
        registerCustomProvider("issue84-partial", {
          baseURL: "http://localhost:5678/v1",
          models: ["free-model", "owned-model"],
        }),
      );

      writeResult({
        conflict,
        freeRoute: errorMessage(() =>
          LLMRegistry.resolve("issue84-partial/free-model"),
        ),
        ownedRouteIsExisting:
          LLMRegistry.resolve("issue84-partial/owned-model") ===
          ExistingNamedLlm,
      });
      return;
    }

    case "unverifiable-registry": {
      class InvalidPatternLlm extends CustomLlm {
        static readonly supportedModels = ["["];

        constructor({ model }: { model: string }) {
          super({
            model,
            baseURL: "http://localhost:1234/v1",
          });
        }
      }

      LLMRegistry.register(InvalidPatternLlm);
      const error = errorMessage(() =>
        registerCustomProvider("issue84-unverifiable", {
          baseURL: "http://localhost:5678/v1",
          models: ["model"],
        }),
      );

      writeResult({ error });
      return;
    }

    case "ai-gateway-before-custom": {
      registerAIGateway({ apiKey: "gateway-key" });

      const conflict = errorMessage(() =>
        registerCustomProvider("issue84-ai-gateway-before", {
          baseURL: "http://localhost:1234/v1",
          models: ["model"],
        }),
      );

      writeResult({
        conflict,
        resolvesToExpected:
          LLMRegistry.resolve("issue84-ai-gateway-before/model") ===
          AIGatewayLlm,
      });
      return;
    }

    case "openrouter-before-custom": {
      registerOpenRouter({ apiKey: "openrouter-key" });

      const conflict = errorMessage(() =>
        registerCustomProvider("issue84-openrouter-before", {
          baseURL: "http://localhost:1234/v1",
          models: ["model"],
        }),
      );

      writeResult({
        conflict,
        resolvesToExpected:
          LLMRegistry.resolve("issue84-openrouter-before/model") ===
          OpenRouterLlm,
      });
      return;
    }

    case "custom-before-broad": {
      registerCustomProvider("issue84-custom-before", {
        baseURL: "http://localhost:1234/v1",
        models: ["model"],
      });
      registerAIGateway({ apiKey: "gateway-key" });
      registerOpenRouter({ apiKey: "openrouter-key" });

      const llm = LLMRegistry.newLlm("issue84-custom-before/model");
      writeResult({
        isCustom: llm instanceof CustomLlm,
        model: llm.model,
      });
      return;
    }

    case "direct": {
      const direct = Custom("direct/model", {
        baseURL: "http://localhost:1234/v1",
      });
      writeResult({
        isCustom: direct instanceof CustomLlm,
        model: direct.model,
        unregistered: errorMessage(() =>
          LLMRegistry.resolve("issue84-unregistered-model"),
        ),
      });
      return;
    }

    default:
      throw new Error(`Unknown registry fixture scenario: ${process.argv[2]}`);
  }
}

await main();
