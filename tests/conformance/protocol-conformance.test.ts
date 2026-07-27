import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { LlmRequest, LlmResponse } from "@google/adk";
import { createCustomLlm } from "../../src/index.js";
import {
  type FixtureServer,
  RUNTIME_FIXTURES,
  type RuntimeFixtureProfile,
  startFixtureServer,
} from "./fixtures/chat-completions-server.js";

let fixtureServer: FixtureServer;

beforeAll(() => {
  fixtureServer = startFixtureServer();
});

afterAll(() => {
  fixtureServer.stop();
});

function request(
  text: string,
  overrides: Partial<LlmRequest> = {},
): LlmRequest {
  return {
    contents: [{ role: "user", parts: [{ text }] }],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  } as LlmRequest;
}

function toolRequest(text: string): LlmRequest {
  return request(text, {
    config: {
      tools: [
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description: "Return the current weather for a city.",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              } as Record<string, unknown>,
            },
          ],
        },
      ],
    },
  });
}

async function drain(
  generator: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of generator) responses.push(response);
  return responses;
}

function llm(
  profile: RuntimeFixtureProfile,
  providerOptions: Record<string, unknown> = {},
) {
  return createCustomLlm({
    name: profile.id,
    model: profile.model,
    baseURL: fixtureServer.baseURL(profile.id),
    maxRetries: 0,
    timeout: 2_000,
    providerOptions,
  });
}

function label(profile: RuntimeFixtureProfile, feature: string): string {
  return `runtime=${profile.id} model=${profile.model} feature=${feature}`;
}

function lastResponse(responses: readonly LlmResponse[]): LlmResponse {
  const response = responses.at(-1);
  if (!response) throw new Error("Expected at least one response");
  return response;
}

function terminalResponse(
  responses: readonly LlmResponse[],
  scenario: string,
): LlmResponse {
  const response = lastResponse(responses);
  if (response.turnComplete !== true) {
    throw new Error(`${scenario} ended without a terminal turnComplete`);
  }
  return response;
}

function assertCancellationStopped(
  responsesAfterAbort: readonly LlmResponse[],
): void {
  if (responsesAfterAbort.some(({ turnComplete }) => turnComplete === true)) {
    throw new Error("stream completed normally after cancellation");
  }
  const error = responsesAfterAbort.find(({ errorCode }) => errorCode);
  if (error) {
    throw new Error(
      `cancellation became a provider error: ${error.errorCode} ${
        error.errorMessage ?? ""
      }`,
    );
  }
}

function assertUnsupportedFeatureError(
  response: LlmResponse,
  profile: RuntimeFixtureProfile,
): void {
  const status = /^API_ERROR_(\d{3})$/.exec(response.errorCode ?? "")?.[1];
  const statusCode = status ? Number(status) : undefined;
  if (statusCode !== 400 && statusCode !== 422) {
    throw new Error(
      `Expected a 400 or 422 unsupported-feature error, received ${
        response.errorCode ?? "no error code"
      }`,
    );
  }

  const message = response.errorMessage ?? "";
  const hasRuntimeContext = message.includes(`runtime=${profile.id}`);
  const hasModelContext = message.includes(`model=${profile.model}`);
  const hasProtocolContext = message.includes("response_format.type=xml");
  const explainsRejection =
    /\b(?:invalid|unsupported|not supported|unknown)\b/i.test(message);
  if (
    !hasRuntimeContext ||
    !hasModelContext ||
    !hasProtocolContext ||
    !explainsRejection
  ) {
    throw new Error(
      "Unsupported-feature error lacked runtime, model, protocol, or rejection context",
    );
  }
  if (response.turnComplete !== true) {
    throw new Error("Unsupported-feature error was not terminal");
  }
}

for (const profile of RUNTIME_FIXTURES) {
  describe(`${profile.id} deterministic Chat Completions conformance`, () => {
    it(`${label(profile, "non-streaming-text")}`, async () => {
      const responses = await drain(
        llm(profile).generateContentAsync(request("hello")),
      );

      expect(lastResponse(responses)).toMatchObject({
        content: {
          role: "model",
          parts: [{ text: "fixture text response" }],
        },
        turnComplete: true,
      });
    });

    it(`${label(profile, "streaming-partial-text")}`, async () => {
      const responses = await drain(
        llm(profile).generateContentAsync(request("stream hello"), true),
      );

      expect(
        responses
          .filter(({ partial }) => partial)
          .flatMap(({ content }) => content?.parts ?? [])
          .map(({ text }) => text)
          .filter(Boolean),
      ).toEqual(["Hello", " from fixtures"]);
      expect(terminalResponse(responses, "streaming text")).toMatchObject({
        content: {
          parts: [{ text: "Hello from fixtures" }],
        },
        turnComplete: true,
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 3,
          totalTokenCount: 8,
        },
      });
    });

    it(`${label(profile, "tool-call-result-final-answer")}`, async () => {
      const bridge = llm(profile);
      const requestedCity = "Guadalajara";
      const weatherResult = { temperature: -7.25, unit: "C" };
      const first = lastResponse(
        await drain(
          bridge.generateContentAsync(
            toolRequest(
              `Use get_weather. Pass ${requestedCity} as the city argument.`,
            ),
          ),
        ),
      );
      const functionCall = first.content?.parts?.[0]?.functionCall;

      expect(functionCall).toEqual({
        id: "call_weather_1",
        name: "get_weather",
        args: { city: requestedCity },
      });

      const finalRequest = toolRequest(
        `Use get_weather. Pass ${requestedCity} as the city argument.`,
      );
      finalRequest.contents = [
        ...(finalRequest.contents ?? []),
        { role: "model", parts: [{ functionCall }] },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: functionCall?.id,
                name: functionCall?.name ?? "get_weather",
                response: weatherResult,
              },
            },
          ],
        },
      ];

      const final = lastResponse(
        await drain(bridge.generateContentAsync(finalRequest)),
      );
      expect(final.content?.parts?.[0]?.text).toBe(
        "The temperature is -7.25 C.",
      );

      const wireRequest = fixtureServer.requests.at(-1)?.body;
      expect(wireRequest?.messages?.at(-1)).toMatchObject({
        role: "tool",
        tool_call_id: "call_weather_1",
        content: JSON.stringify(weatherResult),
      });
    });

    it(`${label(profile, "fragmented-streamed-tool-arguments")}`, async () => {
      const requestedCity = "Monterrey";
      const responses = await drain(
        llm(profile).generateContentAsync(
          toolRequest(
            `Pass ${requestedCity} as the city argument and stream a tool call.`,
          ),
          true,
        ),
      );

      expect(responses.filter(({ partial }) => partial)).toHaveLength(0);
      expect(
        terminalResponse(responses, "streamed tool call").content?.parts?.[0]
          ?.functionCall,
      ).toEqual({
        id: "call_weather_stream",
        name: "get_weather",
        args: { city: requestedCity },
      });
    });

    it(`${label(profile, "structured-json")}`, async () => {
      const schema = {
        type: "object",
        properties: {
          runtime: { type: "string" },
          conformant: { type: "boolean" },
        },
        required: ["runtime", "conformant"],
        additionalProperties: false,
      };
      const structuredConfig =
        profile.structuredOutput === "json_schema"
          ? { responseJsonSchema: schema }
          : { responseMimeType: "application/json" };
      const responses = await drain(
        llm(profile).generateContentAsync(
          request("return JSON", { config: structuredConfig }),
        ),
      );
      const text = lastResponse(responses).content?.parts?.[0]?.text;

      expect(JSON.parse(text ?? "")).toEqual({
        runtime: profile.id,
        conformant: true,
      });
      const responseFormat =
        fixtureServer.requests.at(-1)?.body.response_format;
      expect(responseFormat).toEqual(
        profile.structuredOutput === "json_schema"
          ? {
              type: "json_schema",
              json_schema: { name: "response", strict: false, schema },
            }
          : { type: "json_object" },
      );
    });

    it(`${label(profile, "incomplete-json-schema-is-rejected")}`, async () => {
      const response = lastResponse(
        await drain(
          llm(profile, {
            response_format: { type: "json_schema" },
          }).generateContentAsync(request("return structured JSON")),
        ),
      );

      expect(response).toMatchObject({
        errorCode: "API_ERROR_400",
        turnComplete: true,
      });
      expect(response.errorMessage).toContain(
        `runtime=${profile.id} model=${profile.model} response_format.json_schema envelope is incomplete`,
      );
    });

    it(`${label(profile, "cancellation")}`, async () => {
      const controller = new AbortController();
      const responses = llm(profile).generateContentAsync(
        request("[conformance:cancellation] keep streaming"),
        true,
        controller.signal,
      );

      expect(await responses.next()).toMatchObject({
        done: false,
        value: { partial: true },
      });
      controller.abort();
      const responsesAfterAbort = await drain(responses);
      assertCancellationStopped(responsesAfterAbort);
      expect(responsesAfterAbort).toEqual([]);
    });

    it(`${label(profile, "ignored-cancellation-is-rejected")}`, async () => {
      const controller = new AbortController();
      const responses = llm(profile).generateContentAsync(
        request(
          "[conformance:cancellation-ignore-abort] keep streaming normally",
        ),
        true,
        controller.signal,
      );

      expect(await responses.next()).toMatchObject({
        done: false,
        value: { partial: true },
      });
      controller.abort();
      const responsesAfterAbort = await drain(responses);
      expect(() => assertCancellationStopped(responsesAfterAbort)).toThrow(
        "stream completed normally after cancellation",
      );
    });

    it(`${label(profile, "partial-stream-eof-is-rejected")}`, async () => {
      const responses = await drain(
        llm(profile).generateContentAsync(
          request("[conformance:stream-partial-eof] stream then truncate"),
          true,
        ),
      );

      expect(responses.some(({ partial }) => partial)).toBe(true);
      expect(() => terminalResponse(responses, "truncated stream")).toThrow(
        "truncated stream ended without a terminal turnComplete",
      );
    });

    it(`${label(profile, "optional-missing-api-key")}`, async () => {
      const responses = await drain(
        llm(profile).generateContentAsync(request("no caller API key")),
      );

      expect(lastResponse(responses).errorCode).toBeUndefined();
      expect(fixtureServer.requests.at(-1)?.authorization).toBe(
        "Bearer adk-llm-bridge-custom-provider",
      );
    });

    it(`${label(profile, "unsupported-feature-error-reporting")}`, async () => {
      const responses = await drain(
        llm(profile, {
          response_format: { type: "xml" },
        }).generateContentAsync(request("unsupported")),
      );
      const response = lastResponse(responses);

      expect(response.errorCode).toBe("API_ERROR_400");
      assertUnsupportedFeatureError(response, profile);
      expect(fixtureServer.requests.at(-1)?.body.response_format).toEqual({
        type: "xml",
      });
    });

    it(`${label(profile, "unsupported-5xx-is-rejected")}`, async () => {
      const response = lastResponse(
        await drain(
          llm(profile, {
            response_format: { type: "xml" },
          }).generateContentAsync(
            request("[conformance:unsupported-5xx] unsupported"),
          ),
        ),
      );

      expect(response.errorCode).toBe("API_ERROR_503");
      expect(() => assertUnsupportedFeatureError(response, profile)).toThrow(
        "Expected a 400 or 422 unsupported-feature error",
      );
    });

    it(`${label(profile, "unsupported-connection-is-rejected")}`, async () => {
      const response = lastResponse(
        await drain(
          llm(profile, {
            response_format: { type: "xml" },
          }).generateContentAsync(
            request("[conformance:unsupported-connection] unsupported"),
          ),
        ),
      );

      expect(() => assertUnsupportedFeatureError(response, profile)).toThrow(
        "Expected a 400 or 422 unsupported-feature error",
      );
      expect(response.errorCode).not.toMatch(/^API_ERROR_4\d\d$/);
      expect(response.errorMessage).not.toContain(
        `response_format.type=xml is not supported`,
      );
    });
  });
}
