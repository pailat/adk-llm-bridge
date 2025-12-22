/**
 * HTTP API Server example using adk-llm-bridge with Express
 *
 * Demonstrates ADK best practices:
 * - Session management with state persistence
 * - Artifact storage (in-memory for demo)
 * - Memory service for searchable knowledge
 * - FunctionTool with ToolContext access
 * - State injection in instructions
 * - Token-level streaming
 *
 * Endpoints:
 *   GET  /                  - Health check
 *   POST /run               - Run agent (JSON response)
 *   POST /run_sse           - Run agent with SSE streaming
 *   GET  /sessions/:userId  - List user sessions
 *   GET  /session/:id       - Get session details with history
 *   DELETE /session/:id     - Delete a session
 *
 * Run: bun run start
 */
import express from "express";
import {
  FunctionTool,
  LlmAgent,
  LLMRegistry,
  Runner,
  InMemorySessionService,
  InMemoryArtifactService,
  InMemoryMemoryService,
  StreamingMode,
  ToolContext,
} from "@google/adk";
import { AIGatewayLlm } from "adk-llm-bridge";
import { z } from "zod";

// Register AIGatewayLlm with ADK's LLMRegistry
// This is required because of how module bundling works -
// instanceof BaseLlm fails when passing instances directly
LLMRegistry.register(AIGatewayLlm);

const APP_NAME = "express-api";

// --- Tools with ToolContext ---

/**
 * Tool that demonstrates state access via ToolContext.
 * Stores notes in session state and can retrieve them later.
 */
const notepadTool = new FunctionTool({
  name: "notepad",
  description:
    "Save or retrieve notes. Use action 'save' to store a note, 'get' to retrieve all notes, or 'clear' to delete all notes.",
  parameters: z.object({
    action: z.enum(["save", "get", "clear"]).describe("The action to perform"),
    content: z
      .string()
      .optional()
      .describe("The note content (required for 'save' action)"),
  }),
  execute: async (
    { action, content },
    context?: ToolContext,
  ): Promise<Record<string, unknown>> => {
    if (!context) {
      return { status: "error", message: "ToolContext is required" };
    }

    const notesKey = "user:notes"; // User-scoped state (persists across sessions)

    switch (action) {
      case "save": {
        if (!content) {
          return { status: "error", message: "Content is required for save" };
        }
        const existingNotes =
          (context.state.get<string[]>(notesKey) as string[]) || [];
        const newNotes = [...existingNotes, content];
        context.state.set(notesKey, newNotes);
        return {
          status: "success",
          message: `Note saved. Total notes: ${newNotes.length}`,
        };
      }
      case "get": {
        const notes = (context.state.get<string[]>(notesKey) as string[]) || [];
        return {
          status: "success",
          notes,
          count: notes.length,
        };
      }
      case "clear": {
        context.state.set(notesKey, []);
        return { status: "success", message: "All notes cleared" };
      }
      default:
        return { status: "error", message: "Unknown action" };
    }
  },
});

/**
 * Tool that gets current time - simple example without context.
 */
const getCurrentTime = new FunctionTool({
  name: "get_current_time",
  description: "Returns the current date and time.",
  parameters: z.object({}),
  execute: async () => {
    const now = new Date();
    return {
      status: "success",
      datetime: now.toISOString(),
      formatted: now.toLocaleString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      }),
    };
  },
});

// --- Services Setup ---

const sessionService = new InMemorySessionService();
const artifactService = new InMemoryArtifactService();
const memoryService = new InMemoryMemoryService();

// --- Agent Setup ---

/**
 * Agent with:
 * - State injection in instruction ({user_name} placeholder)
 * - Multiple tools demonstrating different patterns
 * - outputKey to auto-save responses to state
 */
const agent = new LlmAgent({
  name: "assistant",
  model: "anthropic/claude-sonnet-4", // Use string model name (resolved via LLMRegistry)
  description: "A helpful assistant that can take notes and tell the time.",
  instruction: `You are a helpful assistant. Be concise in your responses.

You have access to:
- A notepad tool to save and retrieve notes for the user
- A time tool to get the current date and time

When the user asks to remember something, use the notepad tool to save it.
When they ask what you've saved, use the notepad tool to retrieve notes.`,
  tools: [notepadTool, getCurrentTime],
  // outputKey: "last_response", // Uncomment to auto-save responses to state
});

// --- Runner Setup ---

const runner = new Runner({
  agent,
  appName: APP_NAME,
  sessionService,
  artifactService,
  memoryService,
});

// --- Express Server ---

const app = express();
app.use(express.json());

// Health check
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    agent: agent.name,
    model: "anthropic/claude-sonnet-4",
    features: [
      "session-management",
      "state-persistence",
      "artifacts",
      "memory",
      "tools",
      "streaming",
    ],
  });
});

// List sessions for a user
app.get("/sessions/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const response = await sessionService.listSessions({
      appName: APP_NAME,
      userId,
    });
    res.json({
      userId,
      sessions: response.sessions.map((s) => ({
        id: s.id,
        createdAt: s.events?.[0]?.timestamp,
        eventCount: s.events?.length || 0,
      })),
    });
  } catch (error) {
    console.error("Error listing sessions:", error);
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

// Get session details with conversation history
app.get("/session/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { userId } = req.query;

    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "userId query param is required" });
    }

    const session = await sessionService.getSession({
      appName: APP_NAME,
      userId,
      sessionId,
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Extract conversation from events
    const conversation = session.events
      ?.filter((e) => e.content)
      .map((e) => ({
        role: e.author === "user" ? "user" : "assistant",
        content: e.content?.parts?.map((p) => p.text).join("") || "",
        timestamp: e.timestamp,
      }));

    res.json({
      id: session.id,
      userId: session.userId,
      state: session.state,
      conversation,
      eventCount: session.events?.length || 0,
    });
  } catch (error) {
    console.error("Error getting session:", error);
    res.status(500).json({ error: "Failed to get session" });
  }
});

// Delete a session
app.delete("/session/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { userId } = req.query;

    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ error: "userId query param is required" });
    }

    await sessionService.deleteSession({
      appName: APP_NAME,
      userId,
      sessionId,
    });

    res.json({ status: "deleted", sessionId });
  } catch (error) {
    console.error("Error deleting session:", error);
    res.status(500).json({ error: "Failed to delete session" });
  }
});

// Run agent - returns all events as JSON array
app.post("/run", async (req, res) => {
  try {
    const { userId, sessionId, message } = req.body;

    if (!userId || !message) {
      return res.status(400).json({ error: "userId and message are required" });
    }

    // Get or create session
    let session = sessionId
      ? await sessionService
          .getSession({ appName: APP_NAME, userId, sessionId })
          .catch(() => null)
      : null;

    if (!session) {
      session = await sessionService.createSession({
        appName: APP_NAME,
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

    // Extract final response text
    const finalEvent = events[events.length - 1] as {
      content?: { parts?: { text?: string }[] };
    };
    const responseText =
      finalEvent?.content?.parts?.map((p) => p.text).join("") || "";

    res.json({
      sessionId: session.id,
      response: responseText,
      events,
    });
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

    // Get or create session
    let session = sessionId
      ? await sessionService
          .getSession({ appName: APP_NAME, userId, sessionId })
          .catch(() => null)
      : null;

    if (!session) {
      session = await sessionService.createSession({
        appName: APP_NAME,
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
╔══════════════════════════════════════════════════════════════╗
║                   ADK Agent API Server                       ║
╠══════════════════════════════════════════════════════════════╣
║  Agent: ${agent.name.padEnd(52)}║
║  Model: anthropic/claude-sonnet-4                            ║
║                                                              ║
║  Features:                                                   ║
║    ✓ Session management with state                           ║
║    ✓ Artifact storage (in-memory)                            ║
║    ✓ Memory service                                          ║
║    ✓ Tools with ToolContext                                  ║
║    ✓ Token-level streaming                                   ║
╠══════════════════════════════════════════════════════════════╣
║  Endpoints:                                                  ║
║    GET  /                  Health check                      ║
║    POST /run               Run agent (JSON)                  ║
║    POST /run_sse           Run agent (SSE streaming)         ║
║    GET  /sessions/:userId  List user sessions                ║
║    GET  /session/:id       Get session with history          ║
║    DELETE /session/:id     Delete session                    ║
╚══════════════════════════════════════════════════════════════╝

Examples:

  # Basic chat
  curl -X POST http://localhost:${port}/run \\
    -H "Content-Type: application/json" \\
    -d '{"userId": "user-1", "message": "Hello!"}'

  # Save a note (uses session state)
  curl -X POST http://localhost:${port}/run \\
    -H "Content-Type: application/json" \\
    -d '{"userId": "user-1", "message": "Remember that my favorite color is blue"}'

  # Retrieve notes
  curl -X POST http://localhost:${port}/run \\
    -H "Content-Type: application/json" \\
    -d '{"userId": "user-1", "message": "What have you saved for me?"}'

  # SSE streaming (event-level)
  curl -X POST http://localhost:${port}/run_sse \\
    -H "Content-Type: application/json" \\
    -d '{"userId": "user-1", "message": "Tell me a short joke"}'

  # SSE streaming (token-level)
  curl -X POST http://localhost:${port}/run_sse \\
    -H "Content-Type: application/json" \\
    -d '{"userId": "user-1", "message": "Tell me a story", "streaming": true}'

  # List sessions
  curl http://localhost:${port}/sessions/user-1

  # Get session history
  curl "http://localhost:${port}/session/SESSION_ID?userId=user-1"

Server running at http://localhost:${port}
`);
});
