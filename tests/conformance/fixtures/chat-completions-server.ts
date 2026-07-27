export type RuntimeId = "ollama" | "vllm" | "lm-studio";

export interface RuntimeFixtureProfile {
  readonly id: RuntimeId;
  readonly model: string;
  readonly structuredOutput: "json_schema" | "json_object";
}

export const RUNTIME_FIXTURES: readonly RuntimeFixtureProfile[] = [
  {
    id: "ollama",
    model: "qwen2.5:1.5b",
    structuredOutput: "json_schema",
  },
  {
    id: "vllm",
    model: "Qwen/Qwen2.5-1.5B-Instruct",
    structuredOutput: "json_schema",
  },
  {
    id: "lm-studio",
    model: "qwen2.5-1.5b-instruct",
    structuredOutput: "json_object",
  },
] as const;

export interface CapturedRequest {
  readonly runtime: RuntimeId;
  readonly authorization: string | null;
  readonly body: ChatCompletionRequest;
}

interface ChatCompletionRequest {
  readonly model?: string;
  readonly messages?: Array<{
    readonly role?: string;
    readonly content?: unknown;
    readonly tool_call_id?: string;
  }>;
  readonly response_format?: {
    readonly type?: string;
    readonly json_schema?: {
      readonly name?: string;
      readonly strict?: boolean;
      readonly schema?: unknown;
    };
  };
  readonly stream?: boolean;
  readonly stream_options?: { readonly include_usage?: boolean };
  readonly tools?: unknown[];
}

export interface FixtureServer {
  readonly requests: CapturedRequest[];
  baseURL(runtime: RuntimeId): string;
  stop(): void;
}

const encoder = new TextEncoder();

function completion(model: string, content: string): Response {
  return Response.json({
    id: "chatcmpl-conformance",
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  });
}

function toolResultCompletion(
  model: string,
  body: ChatCompletionRequest,
): Response {
  const content = body.messages?.findLast(
    ({ role }) => role === "tool",
  )?.content;
  if (typeof content !== "string") {
    return completion(model, "The tool result was not usable.");
  }
  try {
    const result = JSON.parse(content) as {
      readonly temperature?: unknown;
      readonly unit?: unknown;
    };
    if (
      typeof result.temperature !== "number" ||
      typeof result.unit !== "string"
    ) {
      return completion(model, "The tool result was not usable.");
    }
    return completion(
      model,
      `The temperature is ${result.temperature} ${result.unit}.`,
    );
  } catch {
    return completion(model, "The tool result was not usable.");
  }
}

function requestedCity(body: ChatCompletionRequest): string {
  const prompt = body.messages?.findLast(
    ({ role, content }) => role === "user" && typeof content === "string",
  )?.content;
  if (typeof prompt !== "string") return "Unspecified city";

  const match = prompt.match(
    /\bpass\s+["']?(.+?)["']?\s+as the city argument\b/i,
  );
  return match?.[1]?.trim() || "Unspecified city";
}

function toolCompletion(model: string, city: string): Response {
  return Response.json({
    id: "chatcmpl-conformance-tool",
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_weather_1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: JSON.stringify({ city }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
        logprobs: null,
      },
    ],
  });
}

function sse(chunks: readonly unknown[], includeDone = true): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
  if (includeDone) body.push("data: [DONE]\n\n");
  return new Response(body.join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function textStream(model: string): Response {
  const base = {
    id: "chatcmpl-conformance-stream",
    object: "chat.completion.chunk",
    created: 0,
    model,
  };
  return sse([
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "Hello" },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [
        { index: 0, delta: { content: " from fixtures" }, finish_reason: null },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    {
      ...base,
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    },
  ]);
}

function partialEofStream(model: string): Response {
  return sse(
    [
      {
        id: "chatcmpl-conformance-partial-eof",
        object: "chat.completion.chunk",
        created: 0,
        model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "incomplete" },
            finish_reason: null,
          },
        ],
      },
    ],
    false,
  );
}

function cancellationIgnoringAbortStream(model: string): Response {
  const base = {
    id: "chatcmpl-conformance-cancel-ignored",
    object: "chat.completion.chunk",
    created: 0,
    model,
  };
  return sse([
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "started" },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { content: " and completed normally" },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ]);
}

function fragmentedToolStream(model: string, city: string): Response {
  const base = {
    id: "chatcmpl-conformance-tool-stream",
    object: "chat.completion.chunk",
    created: 0,
    model,
  };
  const argumentsJson = JSON.stringify({ city });
  const splitAt = Math.max(1, Math.floor(argumentsJson.length / 2));
  return sse([
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_weather_stream",
                type: "function",
                function: {
                  name: "get_",
                  arguments: argumentsJson.slice(0, splitAt),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  name: "weather",
                  arguments: argumentsJson.slice(splitAt),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ]);
}

function cancellationStream(model: string, signal: AbortSignal): Response {
  let abort: (() => void) | undefined;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: "chatcmpl-conformance-cancel",
              object: "chat.completion.chunk",
              created: 0,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: "started" },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          ),
        );
        abort = () => controller.error(signal.reason ?? new Error("aborted"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      },
      cancel() {
        if (abort) signal.removeEventListener("abort", abort);
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function lastText(body: ChatCompletionRequest): string {
  const content = body.messages?.at(-1)?.content;
  return typeof content === "string" ? content : "";
}

function runtimeFromPath(pathname: string): RuntimeId | undefined {
  return RUNTIME_FIXTURES.find(({ id }) =>
    pathname.startsWith(`/${id}/v1/chat/completions`),
  )?.id;
}

export function startFixtureServer(): FixtureServer {
  const requests: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  const handleFixtureRequest = async (request: Request): Promise<Response> => {
    const runtime = runtimeFromPath(new URL(request.url).pathname);
    if (!runtime || request.method !== "POST") {
      return Response.json(
        { error: { message: "Not found" } },
        { status: 404 },
      );
    }

    const body = (await request.json()) as ChatCompletionRequest;
    requests.push({
      runtime,
      authorization: request.headers.get("authorization"),
      body,
    });

    const context = `runtime=${runtime} model=${body.model ?? "unknown"}`;
    const prompt = lastText(body);
    if (prompt.includes("[conformance:unsupported-connection]")) {
      throw new TypeError(`${context} fixture connection failed`);
    }
    if (prompt.includes("[conformance:unsupported-5xx]")) {
      return Response.json(
        {
          error: {
            message: `${context} fixture upstream service unavailable`,
            type: "server_error",
          },
        },
        { status: 503 },
      );
    }

    const responseFormat = body.response_format;
    if (
      responseFormat?.type &&
      !["text", "json_object", "json_schema"].includes(responseFormat.type)
    ) {
      return Response.json(
        {
          error: {
            message: `${context} response_format.type=${responseFormat.type} is not supported`,
            type: "invalid_request_error",
            code: "unsupported_response_format",
          },
        },
        { status: 400 },
      );
    }

    if (responseFormat?.type === "json_schema") {
      const { json_schema: jsonSchema } = responseFormat;
      if (
        !jsonSchema ||
        typeof jsonSchema.name !== "string" ||
        jsonSchema.name.length === 0 ||
        typeof jsonSchema.strict !== "boolean" ||
        typeof jsonSchema.schema !== "object" ||
        jsonSchema.schema === null ||
        Array.isArray(jsonSchema.schema)
      ) {
        return Response.json(
          {
            error: {
              message: `${context} response_format.json_schema envelope is incomplete`,
              type: "invalid_request_error",
              code: "invalid_json_schema",
            },
          },
          { status: 400 },
        );
      }
    }

    if (prompt.includes("[conformance:stream-partial-eof]")) {
      return partialEofStream(body.model ?? "unknown");
    }
    if (prompt.includes("[conformance:cancellation-ignore-abort]")) {
      return cancellationIgnoringAbortStream(body.model ?? "unknown");
    }
    if (prompt.includes("[conformance:cancellation]")) {
      return cancellationStream(body.model ?? "unknown", request.signal);
    }
    if (body.response_format) {
      return completion(
        body.model ?? "unknown",
        JSON.stringify({ runtime, conformant: true }),
      );
    }
    if (body.messages?.some(({ role }) => role === "tool")) {
      return toolResultCompletion(body.model ?? "unknown", body);
    }
    if (body.tools?.length) {
      const city = requestedCity(body);
      return body.stream
        ? fragmentedToolStream(body.model ?? "unknown", city)
        : toolCompletion(body.model ?? "unknown", city);
    }
    if (body.stream) return textStream(body.model ?? "unknown");
    return completion(body.model ?? "unknown", "fixture text response");
  };
  const fixtureFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (runtimeFromPath(new URL(request.url).pathname)) {
      return handleFixtureRequest(request);
    }
    return originalFetch(input, init);
  };
  globalThis.fetch = fixtureFetch;

  return {
    requests,
    baseURL(runtime) {
      return `http://conformance.invalid/${runtime}/v1`;
    },
    stop() {
      if (globalThis.fetch === fixtureFetch) globalThis.fetch = originalFetch;
    },
  };
}
