/**
 * Programmatic example using adk-llm-bridge with AI Gateway
 *
 * Run from project root: bun run examples/programmatic/index.ts
 */
import { LlmAgent, Runner, InMemorySessionService } from "@google/adk";
import { AIGatewayLlm } from "adk-llm-bridge";

// Create the LLM instance directly
const llm = new AIGatewayLlm({
  model: "anthropic/claude-sonnet-4",
  // Optional: override the base URL
  // baseURL: "https://your-gateway.com/v1",
});

// Create the agent with the LLM instance
const agent = new LlmAgent({
  name: "assistant",
  model: llm,
  instruction: "You are a helpful assistant. Be concise in your responses.",
});

// Create runner with session service
const sessionService = new InMemorySessionService();
const runner = new Runner({
  agent,
  appName: "programmatic-example",
  sessionService,
});

async function main() {
  console.log("Starting conversation with Claude via AI Gateway...\n");

  // Create a session
  const session = await sessionService.createSession({
    appName: "programmatic-example",
    userId: "user-1",
  });

  const messages = [
    "Hello! What can you help me with?",
    "What is the capital of France?",
    "Thanks!",
  ];

  for (const message of messages) {
    console.log(`User: ${message}`);

    const result = runner.runAsync({
      userId: "user-1",
      sessionId: session.id,
      newMessage: {
        role: "user",
        parts: [{ text: message }],
      },
    });

    process.stdout.write("Assistant: ");
    for await (const event of result) {
      if (event.content?.parts) {
        for (const part of event.content.parts) {
          if ("text" in part && part.text) {
            process.stdout.write(part.text);
          }
        }
      }
    }
    console.log("\n");
  }
}

main().catch(console.error);
