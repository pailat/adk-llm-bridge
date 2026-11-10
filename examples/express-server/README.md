# Express Server

## What it shows

An HTTP API server that exposes an ADK agent through Express with
`adk-llm-bridge` and AI Gateway: session management with persisted state,
in-memory artifact and memory services, `FunctionTool` with context access,
state injection in instructions, and token-level streaming over SSE.

Endpoints:

| Method and path | Description |
|-----------------|-------------|
| `GET /` | Health check |
| `POST /run` | Run the agent (JSON response) |
| `POST /run_sse` | Run the agent with SSE streaming |
| `GET /sessions/:userId` | List the sessions of a user |
| `GET /session/:id` | Get a session with its history |
| `DELETE /session/:id` | Delete a session |

## Requirements

- Bun and Node.js 22 or newer.
- `AI_GATEWAY_API_KEY`

## Run

```bash
cd examples/express-server
cp .env.example .env
# Edit .env and add your key
bun install
bun run start
```

Use `bun run dev` to restart the server on file changes.
