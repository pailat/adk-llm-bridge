import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import type OpenAI from "openai";
import { resetConfig } from "../../src/config.js";
import { OpenAICompatibleLlm } from "../../src/core/openai-compatible-llm.js";
import { AIGatewayLlm } from "../../src/providers/ai-gateway/index.js";
import { createCustomLlm } from "../../src/providers/custom/factory.js";
import { OpenAILlm } from "../../src/providers/openai/index.js";
import { useCleanEnv } from "../helpers/env.js";

// The OpenAI SDK reads these when an option is undefined. Fake values only.
const FAKE = {
  OPENAI_ORG_ID: "org-fake-host",
  OPENAI_PROJECT_ID: "proj-fake-host",
  OPENAI_ADMIN_KEY: "admin-fake-host",
};

let server: ReturnType<typeof Bun.serve>;
let seen: Headers[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen.push(req.headers);
      return Response.json({
        id: "c1",
        object: "chat.completion",
        created: 0,
        model: "m",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

async function send(llm: unknown): Promise<Headers> {
  seen = [];
  const client = (llm as { client: OpenAI }).client;
  await client.chat.completions.create({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  });
  const headers = seen[0];
  if (!headers) throw new Error("no request reached the local server");
  return headers;
}

describe("OpenAI SDK environment defaults", () => {
  useCleanEnv([
    ...Object.keys(FAKE),
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT",
    "AI_GATEWAY_API_KEY",
    "AI_GATEWAY_URL",
    "CUSTOM_LLM_API_KEY",
    "CUSTOM_LLM_BASE_URL",
  ]);
  beforeEach(() => {
    resetConfig();
    Object.assign(process.env, FAKE);
  });

  const url = () => `http://127.0.0.1:${server.port}/v1`;

  it("AI Gateway sends no OpenAI org or project header, and its own key", async () => {
    const headers = await send(
      new AIGatewayLlm({
        model: "openai/gpt-6-luna",
        apiKey: "gateway-key",
        baseURL: url(),
      }),
    );
    expect(headers.get("openai-organization")).toBeNull();
    expect(headers.get("openai-project")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer gateway-key");
  });

  it("a custom provider sends no OpenAI org or project header", async () => {
    const headers = await send(
      createCustomLlm({ model: "llama3", baseURL: url(), apiKey: "local-key" }),
    );
    expect(headers.get("openai-organization")).toBeNull();
    expect(headers.get("openai-project")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer local-key");
  });

  it("the OpenAI provider keeps its own org and project variables", async () => {
    const headers = await send(
      new OpenAILlm({ model: "gpt-4.1", apiKey: "openai-key", baseURL: url() }),
    );
    expect(headers.get("openai-organization")).toBe(FAKE.OPENAI_ORG_ID);
    expect(headers.get("openai-project")).toBe(FAKE.OPENAI_PROJECT_ID);
    expect(headers.get("authorization")).toBe("Bearer openai-key");
  });

  it("a manual client without baseURL throws instead of reading OPENAI_BASE_URL", () => {
    process.env.OPENAI_BASE_URL = url();
    seen = [];
    for (const baseURL of [undefined, "", "  "]) {
      expect(
        () =>
          new OpenAICompatibleLlm({ model: "m" }, {
            apiKey: "own-acme",
            providerId: "acme",
            errorPrefix: "ACME",
            baseURL,
          } as unknown as ConstructorParameters<typeof OpenAICompatibleLlm>[1]),
      ).toThrow("[adk-llm-bridge] baseURL is required");
    }
    expect(seen).toHaveLength(0);
  });

  it("no provider sends the admin key", async () => {
    for (const llm of [
      new AIGatewayLlm({ model: "a/b", apiKey: "k", baseURL: url() }),
      new OpenAILlm({ model: "gpt-4.1", apiKey: "k", baseURL: url() }),
    ]) {
      const headers = await send(llm);
      for (const [, value] of headers) {
        expect(value).not.toContain(FAKE.OPENAI_ADMIN_KEY);
      }
    }
  });
});
