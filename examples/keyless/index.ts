/**
 * Runs an ADK agent through adk-llm-bridge with no API key and no network:
 * a tiny OpenAI-compatible endpoint on 127.0.0.1 answers every request, and a
 * `Custom` model points at it. Swap the base URL for Ollama, vLLM or LM Studio
 * to talk to a real local model the same way.
 */

import { InMemoryRunner, LlmAgent } from "@google/adk";
import { Custom } from "adk-llm-bridge";

// A fake OpenAI-compatible server: one fixed chat completion for any request.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const body = (await request.json()) as { model: string };
    return Response.json({
      id: "chatcmpl-local",
      object: "chat.completion",
      created: 0,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello from a local model." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });
  },
});

try {
  const agent = new LlmAgent({
    name: "assistant",
    model: Custom("local-model", {
      name: "local",
      baseURL: `http://127.0.0.1:${server.port}/v1`,
    }),
    instruction: "Answer briefly.",
  });

  const runner = new InMemoryRunner({ agent, appName: "keyless" });
  const session = await runner.sessionService.createSession({
    appName: "keyless",
    userId: "user",
  });

  for await (const event of runner.runAsync({
    userId: "user",
    sessionId: session.id,
    newMessage: { role: "user", parts: [{ text: "Say hello." }] },
  })) {
    const text = event.content?.parts?.map((part) => part.text ?? "").join("");
    if (text) console.log(`${event.author}: ${text}`);
  }
} finally {
  server.stop(true);
}
