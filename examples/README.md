# Examples

Examples of using `adk-llm-bridge` with Google ADK and Vercel AI Gateway.

## Available Examples

| Example                           | Description                                      |
| --------------------------------- | ------------------------------------------------ |
| [basic-agent](./basic-agent)      | ADK DevTools with FunctionTool and Claude        |
| [programmatic](./programmatic)    | Programmatic usage with AI Gateway               |

## Quick Start

### basic-agent

Uses ADK DevTools web interface with Claude via AI Gateway:

```bash
cd examples/basic-agent
cp .env.example .env
# Edit .env with your AI_GATEWAY_API_KEY
bun install
bun run web
```

### programmatic

Programmatic usage without DevTools:

```bash
cd examples/programmatic
cp .env.example .env
# Edit .env with your AI_GATEWAY_API_KEY
bun run start
```

## Important: Run from example directory

Bun loads `.env` files from the current working directory. Always `cd` into the example folder before running:

```bash
# Correct
cd examples/basic-agent && bun run web

# Wrong - .env won't be loaded
bun run examples/basic-agent/agent.ts
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway API key |
| `OPENAI_API_KEY` | OpenAI API key (alternative) |
