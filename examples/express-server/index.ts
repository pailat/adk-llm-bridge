/**
 * HTTP API Server example using adk-llm-bridge with Express
 *
 * Exposes ADK agent as REST API following the official ADK API Server pattern.
 *
 * Endpoints:
 *   GET  /           - Health check
 *   POST /run        - Run agent (returns all events as JSON)
 *   POST /run_sse    - Run agent with Server-Sent Events (streaming)
 *
 * Streaming modes:
 *   - Default: Event-level streaming (each ADK event as SSE message)
 *   - streaming: true → Token-level streaming (real-time token chunks)
 *
 * Run: bun run start
 */
import express from "express";
import {
  LlmAgent,
  Runner,
  InMemorySessionService,
  StreamingMode,
} from "@google/adk";
import { AIGateway } from "adk-llm-bridge";

// --- Agent Setup ---

const agent = new LlmAgent({
  name: "assistant",
  model: AIGateway("anthropic/claude-sonnet-4"),
  instruction: "You are a helpful assistant. Be concise in your responses.",
});

const sessionService = new InMemorySessionService();
const runner = new Runner({
  agent,
  appName: "api-example",
  sessionService,
});

// --- Express Server ---

const app = express();
app.use(express.json());

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "ok", agent: agent.name });
});

// Run agent - returns all events as JSON array
app.post("/run", async (req, res) => {
  try {
    const { userId, sessionId, message } = req.body;

    if (!userId || !message) {
      return res.status(400).json({ error: "userId and message are required" });
    }

    // Create session if not exists
    let session = sessionId
      ? await sessionService
          .getSession({ appName: "api-example", userId, sessionId })
          .catch(() => null)
      : null;

    if (!session) {
      session = await sessionService.createSession({
        appName: "api-example",
        userId,
      });
    }

    const events: unknown[] = [];
    const result = runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: {
        role: "user",
        parts: [{ text: message }],
      },
    });

    for await (const event of result) {
      events.push(event);
    }

    res.json({ sessionId: session.id, events });
  } catch (error) {
    console.error("Error in /run:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Run agent with Server-Sent Events (streaming)
// Use streaming: true in request body for token-level streaming
app.post("/run_sse", async (req, res) => {
  try {
    const { userId, sessionId, message, streaming } = req.body;

    if (!userId || !message) {
      return res.status(400).json({ error: "userId and message are required" });
    }

    // Create session if not exists
    let session = sessionId
      ? await sessionService
          .getSession({ appName: "api-example", userId, sessionId })
          .catch(() => null)
      : null;

    if (!session) {
      session = await sessionService.createSession({
        appName: "api-example",
        userId,
      });
    }

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const result = runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: {
        role: "user",
        parts: [{ text: message }],
      },
      // Enable token-level streaming if requested
      runConfig: streaming
        ? { streamingMode: StreamingMode.SSE }
        : { streamingMode: StreamingMode.NONE },
    });

    for await (const event of result) {
      res.write(`event: message\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    res.write(`event: done\n`);
    res.write(`data: ${JSON.stringify({ sessionId: session.id })}\n\n`);
    res.end();
  } catch (error) {
    console.error("Error in /run_sse:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Start Server ---

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`
ADK Agent API Server
====================
Agent: ${agent.name}
Model: anthropic/claude-sonnet-4

Endpoints:
  GET  /         Health check
  POST /run      Run agent (JSON response)
  POST /run_sse  Run agent (SSE streaming)

Examples:
  # Basic request
  curl -X POST http://localhost:${port}/run \\
    -H "Content-Type: application/json" \\
    -d '{"userId": "user-1", "message": "Hello!"}'

  # SSE streaming (event-level)
  curl -X POST http://localhost:${port}/run_sse \\
    -H "Content-Type: application/json" \\
    -d '{"userId": "user-1", "message": "Hello!"}'

  # SSE streaming (token-level)
  curl -X POST http://localhost:${port}/run_sse \\
    -H "Content-Type: application/json" \\
    -d '{"userId": "user-1", "message": "Hello!", "streaming": true}'

Server running at http://localhost:${port}
`);
});
