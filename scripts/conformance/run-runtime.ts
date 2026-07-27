import type { LlmRequest, LlmResponse } from "@google/adk";
import { FunctionCallingConfigMode } from "@google/genai";
import { createCustomLlm } from "../../src/index.js";

type FeatureStatus = "pass" | "fail" | "skip";

interface FeatureResult {
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly model: string;
  readonly feature: string;
  readonly status: FeatureStatus;
  readonly detail: string;
  readonly durationMs: number;
}

const runtime = requiredEnvironment("CONFORMANCE_RUNTIME");
const runtimeVersion = requiredEnvironment("CONFORMANCE_RUNTIME_VERSION");
const baseURL = requiredEnvironment("CONFORMANCE_BASE_URL").replace(/\/$/, "");
const reportedBaseURL = sanitizeBaseURL(baseURL);
const model = requiredEnvironment("CONFORMANCE_MODEL");
const apiKey = process.env.CONFORMANCE_API_KEY;
const expectStructuredJson =
  process.env.CONFORMANCE_EXPECT_STRUCTURED_JSON !== "false";
const results: FeatureResult[] = [];

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sanitizeBaseURL(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`.replace(/\/$/, "");
}

function redactSecrets(value: string): string {
  const endpoint = new URL(baseURL);
  const sensitiveValues = [
    apiKey,
    endpoint.username,
    endpoint.password,
    ...endpoint.searchParams.values(),
  ].filter((candidate): candidate is string => Boolean(candidate));
  let redacted = value.replaceAll(baseURL, reportedBaseURL);
  for (const sensitiveValue of sensitiveValues) {
    redacted = redacted
      .replaceAll(sensitiveValue, "[REDACTED]")
      .replaceAll(encodeURIComponent(sensitiveValue), "[REDACTED]");
  }
  return redacted;
}

function context(feature: string): string {
  return `runtime=${runtime} runtimeVersion=${runtimeVersion} model=${model} feature=${feature}`;
}

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

function toolsConfig(mode: FunctionCallingConfigMode) {
  return {
    tools: [
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Return the current weather for a city.",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string", description: "City name" },
              },
              required: ["city"],
            } as Record<string, unknown>,
          },
        ],
      },
    ],
    toolConfig: { functionCallingConfig: { mode } },
  };
}

function bridge(options?: {
  readonly apiKey?: string;
  readonly providerOptions?: Record<string, unknown>;
}) {
  return createCustomLlm({
    name: runtime,
    model,
    baseURL,
    apiKey: options?.apiKey,
    providerOptions: options?.providerOptions,
    maxRetries: 0,
    timeout: 120_000,
  });
}

async function drain(
  generator: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of generator) responses.push(response);
  return responses;
}

function finalResponse(responses: readonly LlmResponse[]): LlmResponse {
  const final = responses.at(-1);
  if (!final) throw new Error("runtime returned no response");
  if (final.errorCode) {
    throw new Error(
      `${final.errorCode}: ${final.errorMessage ?? "unknown error"}`,
    );
  }
  return final;
}

function completedStreamResponse(
  responses: readonly LlmResponse[],
): LlmResponse {
  const final = finalResponse(responses);
  assert(
    final.turnComplete === true,
    "stream ended without a terminal turnComplete response",
  );
  return final;
}

function responseText(response: LlmResponse): string {
  return (response.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalizedWords(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function validatedToolCity(args: unknown, requestedCity: string): string {
  assert(
    typeof args === "object" && args !== null && !Array.isArray(args),
    "tool arguments were not an object",
  );
  const city = (args as Record<string, unknown>).city;
  assert(
    typeof city === "string" && city.trim().length > 0,
    "tool arguments omitted a non-empty city",
  );
  const normalizedCity = normalizedWords(city);
  const requiredTerms = normalizedWords(requestedCity)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  assert(
    requiredTerms.every((term) => normalizedCity.includes(term)),
    `tool city did not match requested location: ${JSON.stringify(city)}`,
  );
  return city;
}

function assertUsesWeatherResult(text: string): void {
  assert(
    /(?:^|\D)17[.,]5(?:0+)?(?!\d)/.test(text),
    "final answer omitted the supplied temperature 17.5",
  );
  assert(
    /\bcelsius\b|\bcentigrade\b|°\s*c\b|\bdegrees?\s*c\b|(?:^|\D)17[.,]5(?:0+)?\s*c\b/i.test(
      text,
    ),
    "final answer omitted the supplied Celsius unit",
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function check(
  feature: string,
  operation: () => Promise<string>,
): Promise<void> {
  const started = performance.now();
  try {
    const detail = redactSecrets(await operation());
    results.push({
      runtime,
      runtimeVersion,
      model,
      feature,
      status: "pass",
      detail,
      durationMs: Math.round(performance.now() - started),
    });
    console.log(`[PASS] ${context(feature)} detail=${detail}`);
  } catch (error) {
    const detail = redactSecrets(
      error instanceof Error ? error.message : String(error),
    );
    results.push({
      runtime,
      runtimeVersion,
      model,
      feature,
      status: "fail",
      detail,
      durationMs: Math.round(performance.now() - started),
    });
    console.error(`[FAIL] ${context(feature)} detail=${detail}`);
  }
}

function skip(feature: string, detail: string): void {
  results.push({
    runtime,
    runtimeVersion,
    model,
    feature,
    status: "skip",
    detail,
    durationMs: 0,
  });
  console.log(`[SKIP] ${context(feature)} detail=${detail}`);
}

async function bridgeStreamedToolArguments(): Promise<string> {
  const requestedCity = "San Francisco";
  const responses = await drain(
    bridge({ apiKey }).generateContentAsync(
      request(`Call get_weather for ${requestedCity}. Do not answer in text.`, {
        config: toolsConfig(FunctionCallingConfigMode.ANY),
      }),
      true,
    ),
  );
  const functionCall = completedStreamResponse(responses).content?.parts?.find(
    (part) => part.functionCall,
  )?.functionCall;
  assert(functionCall?.name === "get_weather", "get_weather was not called");
  const city = validatedToolCity(functionCall.args, requestedCity);
  return `tool=${functionCall.name} reconstructedCity=${JSON.stringify(city)}`;
}

await check("non-streaming-text", async () => {
  const final = finalResponse(
    await drain(
      bridge({ apiKey }).generateContentAsync(
        request("Reply with a short plain-text conformance greeting."),
      ),
    ),
  );
  assert(responseText(final), "response text was empty");
  return "text received";
});

await check("streaming-partial-text", async () => {
  const responses = await drain(
    bridge({ apiKey }).generateContentAsync(
      request("Write three short sentences about protocol conformance."),
      true,
    ),
  );
  const partials = responses.filter(({ partial }) => partial);
  assert(partials.length > 0, "no partial text responses were emitted");
  assert(
    responseText(completedStreamResponse(responses)),
    "final stream text was empty",
  );
  return `partialResponses=${partials.length}`;
});

await check("tool-call-result-final-answer", async () => {
  const client = bridge({ apiKey });
  const requestedCity = "Mexico City";
  const firstRequest = request(
    `Use get_weather for ${requestedCity}. Pass ${requestedCity} as the city argument. ` +
      "Then state the exact temperature and unit returned by the tool. Do not guess.",
    { config: toolsConfig(FunctionCallingConfigMode.ANY) },
  );
  const first = finalResponse(
    await drain(client.generateContentAsync(firstRequest)),
  );
  const functionCall = first.content?.parts?.find(
    (part) => part.functionCall,
  )?.functionCall;
  assert(functionCall?.name === "get_weather", "get_weather was not called");
  const city = validatedToolCity(functionCall.args, requestedCity);

  const secondRequest = request("weather", {
    config: toolsConfig(FunctionCallingConfigMode.NONE),
  });
  secondRequest.contents = [
    ...(firstRequest.contents ?? []),
    { role: "model", parts: [{ functionCall }] },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: functionCall.id,
            name: functionCall.name,
            response: { temperature: 17.5, unit: "C" },
          },
        },
      ],
    },
  ];
  const final = finalResponse(
    await drain(client.generateContentAsync(secondRequest)),
  );
  const finalText = responseText(final);
  assertUsesWeatherResult(finalText);
  return `tool=${functionCall.name} city=${JSON.stringify(city)} result=17.5 C`;
});

await check(
  "streamed-tool-argument-reconstruction",
  bridgeStreamedToolArguments,
);

if (expectStructuredJson) {
  await check("structured-json", async () => {
    const final = finalResponse(
      await drain(
        bridge({ apiKey }).generateContentAsync(
          request("Return a conformance status object as JSON.", {
            config: {
              responseJsonSchema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["conformant"] },
                  protocol: {
                    type: "string",
                    enum: ["chat-completions"],
                  },
                  issue: { type: "integer", enum: [86] },
                },
                required: ["status", "protocol", "issue"],
                additionalProperties: false,
              },
            },
          }),
        ),
      ),
    );
    const parsed = JSON.parse(responseText(final)) as Record<string, unknown>;
    assert(
      parsed.status === "conformant" &&
        parsed.protocol === "chat-completions" &&
        parsed.issue === 86,
      "structured JSON did not contain the schema-constrained values",
    );
    assert(
      Object.keys(parsed).sort().join(",") === "issue,protocol,status",
      "structured JSON contained unexpected properties",
    );
    return "json_schema exact object honored";
  });
} else {
  skip("structured-json", "disabled by runtime profile");
}

await check("cancellation", async () => {
  const controller = new AbortController();
  const responses = bridge({ apiKey }).generateContentAsync(
    request("Count from one to one thousand, one number per line."),
    true,
    controller.signal,
  );
  const first = await withTimeout(
    responses.next(),
    30_000,
    "stream did not start before cancellation timeout",
  );
  if (first.done !== false) {
    throw new Error("stream ended before emitting a partial response");
  }
  const firstResponse = first.value;
  assert(firstResponse.partial, "stream did not emit a partial response");
  controller.abort();
  const remaining = await withTimeout(
    drain(responses),
    5_000,
    "stream did not stop within 5 seconds of cancellation",
  );
  assert(
    remaining.length === 0,
    "runtime emitted responses after cancellation; AbortSignal may have been ignored",
  );
  return "stream stopped without post-abort responses";
});

await check("optional-missing-api-key", async () => {
  const final = finalResponse(
    await drain(
      bridge().generateContentAsync(request("Reply with the word ready.")),
    ),
  );
  assert(responseText(final), "keyless request returned empty text");
  return "caller API key omitted and request accepted";
});

await check("unsupported-feature-error-reporting", async () => {
  const responses = await drain(
    bridge({
      apiKey,
      providerOptions: {
        response_format: { type: "xml" },
      },
    }).generateContentAsync(request("unsupported response format")),
  );
  const response = responses.at(-1);
  assert(response, "runtime returned no response for unsupported feature");
  assert(
    response.errorCode,
    "runtime silently accepted an unsupported response format",
  );
  assert(
    /^API_ERROR_(?:400|415|422)$/.test(response.errorCode),
    `unsupported response format returned inappropriate error code ${response.errorCode}; expected HTTP 400, 415, or 422`,
  );
  assert(
    response.errorMessage,
    "unsupported-feature error omitted its message",
  );
  assert(
    /\b(?:invalid|unsupported|not supported|unrecognized|unknown|not permitted|expected)\b/i.test(
      response.errorMessage,
    ) &&
      /(?:response[_\s-]*format|format(?:\.type)?|\btype\b|\bxml\b)/i.test(
        response.errorMessage,
      ),
    "unsupported-feature error omitted meaningful response format/type context",
  );
  assert(
    response.turnComplete === true,
    "unsupported-feature error omitted terminal turnComplete",
  );
  return `errorCode=${response.errorCode}`;
});

const report = {
  runtime,
  runtimeVersion,
  model,
  baseURL: reportedBaseURL,
  generatedAt: new Date().toISOString(),
  passed: results.filter(({ status }) => status === "pass").length,
  failed: results.filter(({ status }) => status === "fail").length,
  skipped: results.filter(({ status }) => status === "skip").length,
  results,
};
const reportPath = process.env.CONFORMANCE_REPORT;
if (reportPath)
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (report.failed > 0) process.exitCode = 1;
