# Native Features Showcase

## What it shows

A programmatic [Bun](https://bun.sh) + TypeScript CLI that demonstrates **every
native-model capability** [`adk-llm-bridge`](https://www.npmjs.com/package/adk-llm-bridge)
passes through to [Google ADK](https://google.github.io/adk-docs/)
([adk-js](https://github.com/google/adk-js), `@google/adk@^2.5.0`).

Each feature is an isolated "demo" you can run on its own, so you can inspect the
exact events, parts, and usage metadata the chat UI normally hides
(`usageMetadata.thoughtsTokenCount`, `part.thought === true`, partial-vs-final
streaming events, multimodal base64 input, and forced tool calls).

## Requirements

- Bun and Node.js 22 or newer.
- `ANTHROPIC_API_KEY` (default provider), or the key of the provider selected with `PROVIDER`: `OPENAI_API_KEY`, `AI_GATEWAY_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`
- Optional: `MODEL`

## Run

1. Copy the env file and add your key (Anthropic is the default provider):
   ```bash
   cp .env.example .env
   # Edit .env and set ANTHROPIC_API_KEY
   ```
2. Install dependencies:
   ```bash
   bun install
   ```
3. Run a demo (see the table below), all of them, or list them:
   ```bash
   bun run reasoning   # one demo
   bun run all         # all six demos in sequence
   bun run list        # list demos
   ```

> **Run from this directory.** Bun loads `.env` from the current working
> directory, so always `cd examples/native-features` first.

## Demos

| Feature | Demo | Script | What it shows |
|---|---|---|---|
| 1. Sampling | `sampling` | `bun run sampling` | `temperature`, `maxOutputTokens`, `stopSequences` (and `topP` on OpenAI) via `generateContentConfig` |
| 2. Reasoning | `reasoning` | `bun run reasoning` | extended thinking via `thinkingConfig`; reads `part.thought` parts + `usageMetadata.thoughtsTokenCount` |
| 3. Structured output | `structured-output` | `bun run structured` | JSON enforced via `LlmAgent.outputSchema` (zod v4) + `outputKey` |
| 4. Multimodal | `multimodal` | `bun run multimodal` | image input via `Content` part `inlineData { mimeType, data: base64 }` |
| 5. Tool choice | `tool-choice` | `bun run tool-choice` | force a tool via `toolConfig.functionCallingConfig { mode: ANY, allowedFunctionNames }` |
| 6. Streaming + usage | `streaming` | `bun run streaming` | token streaming (`StreamingMode.SSE`) + final `usageMetadata` |

You can override the provider/model per run:

```bash
bun run src/cli.ts sampling --provider openai --model gpt-4.1
```

## Web UI (adk-devtools)

The CLI demos read `part.thought`, `usageMetadata`, streaming partials, etc.
programmatically. For an **interactive** view, `agent.ts` exposes a single
`rootAgent` configured with the native knobs (extended thinking + a tool +
vision) that you can chat with in the adk-devtools web UI:

```bash
bun run web        # then open http://localhost:8000/dev-ui
```

Ask a weather question to see the forced/native tool call, and the model's
**thinking** is rendered as a "Thought" block before the answer. Attach an image
to exercise multimodal input. (Uses the factory form `Anthropic(...)`, so no
`LLMRegistry.register` is needed.)

## Feature details

### 1. Sampling (`sampling`)

Sets sampling controls on the agent:

```ts
new LlmAgent({
  model: makeModel(config),
  generateContentConfig: {
    temperature: 0.2,
    maxOutputTokens: 120,
    stopSequences: ["END"],
    // topP: 0.9,   // OpenAI only — see Provider Constraints
  },
});
```

### 2. Reasoning / extended thinking (`reasoning`)

```ts
generateContentConfig: {
  thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 },
}
```

The harness collects parts where `part.thought === true` and prints the
`usageMetadata.thoughtsTokenCount`. **No** custom `temperature`/`topP` is set —
those would be stripped when thinking is on (see Provider Constraints).

### 3. Structured output (`structured-output`)

Uses `LlmAgent.outputSchema` (a zod v4 object) — **never**
`generateContentConfig.responseSchema`, which ADK 1.2 rejects at construction.
ADK maps `outputSchema` to the provider's native structured-output mode and (via
`outputKey`) auto-parses the JSON into `session.state`. Setting `outputSchema`
also forces `disallowTransferToParent/Peers`, so the agent is standalone.

### 4. Multimodal image input (`multimodal`)

Reads the checked-in `assets/sample-image.png`, base64-encodes it, and sends it
inline:

```ts
buildMessage("What is the dominant color?", [
  { inlineData: { mimeType: "image/png", data: base64 } },
]);
```

A public-URL alternative is documented in the code:
`{ fileData: { fileUri: "https://…", mimeType: "image/png" } }`.

### 5. Tool choice (`tool-choice`)

Defines a real `FunctionTool` and forces it:

```ts
generateContentConfig: {
  toolConfig: {
    functionCallingConfig: {
      mode: FunctionCallingConfigMode.ANY,
      allowedFunctionNames: ["get_weather"],
    },
  },
}
```

> **Loop guard.** `mode: ANY` forces a function call on **every** turn, so once
> the tool returns its result the model is forced to call a tool again — an
> unbounded loop. The harness bounds this run with `RunConfig.maxLlmCalls: 1`,
> so the single forced call fires and ADK then stops the run. This is the
> idiomatic ADK way to demonstrate a one-shot forced tool call.

```ts
// in tool-choice.ts
await harness.run(agent, message, { maxLlmCalls: 1 });
```

### 6. Streaming + token usage (`streaming`)

Runs with `RunConfig.streamingMode = StreamingMode.SSE`. Partial events stream
to the console as they arrive; the final, non-partial event carries
`usageMetadata`, which is printed at the end.

## Provider Constraints

The Anthropic converter enforces the provider's API rules, which is why
**sampling and reasoning are separate demos**:

- **With extended thinking on**, Anthropic forbids `top_p`/`top_k` and any
  `temperature !== 1`. The bridge drops them automatically — so the reasoning
  demo sets only `thinkingConfig`.
- **Outside thinking**, Anthropic rejects sending `temperature` and `top_p`
  together. The bridge keeps `temperature` and drops `top_p` — so `topP` is only
  demonstrated on OpenAI.

These are documented in the bridge's Anthropic request converter and mirrored in
the demo comments.

## Architecture

```
src/
├── cli.ts            # single entry point (parses argv, dispatches)
├── config.ts         # typed env resolution + validation
├── providers.ts      # makeModel(): Anthropic()/OpenAI() factory selection
├── runner.ts         # AgentHarness — the ONLY ADK Runner/Session integration
├── output.ts         # consistent labeled console rendering
├── registry.ts       # Demo registry (Map<name, Demo>)
├── types.ts          # Demo / DemoContext / RunResult contracts
└── demos/
    ├── index.ts          # composition root (registers all demos)
    ├── sampling.ts       # Feature 1
    ├── reasoning.ts      # Feature 2
    ├── structured-output.ts  # Feature 3
    ├── multimodal.ts     # Feature 4
    ├── tool-choice.ts    # Feature 5
    └── streaming.ts      # Feature 6
```

Patterns: **Strategy** (each feature is a `Demo`), **Registry** (name-keyed
lookup), **Facade** (`AgentHarness` hides ADK plumbing and reduces the event
stream into a typed `RunResult`), **Factory** (library `Anthropic()`/`OpenAI()`),
and **Dependency Injection** (a `DemoContext` is passed into every demo).

## Providers & models

Select a provider with `--provider <name>` (or `PROVIDER` env), and optionally a
model with `--model <id>` (or `MODEL`). Each provider reads its own key from
`.env`.

| Provider | Key | Default model | Reasoning model (auto for the `reasoning` demo) |
|---|---|---|---|
| `anthropic` (default) | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` | `claude-sonnet-5-5` |
| `openai` | `OPENAI_API_KEY` | `gpt-4.1` | `gpt-6.1-sol` |
| `ai-gateway` | `AI_GATEWAY_API_KEY` | `anthropic/claude-sonnet-5.5` | `openai/gpt-6.1-sol` |
| `openrouter` | `OPENROUTER_API_KEY` | `openai/gpt-4.1` | `deepseek/deepseek-v4-pro` |
| `xai` | `XAI_API_KEY` | `grok-4.7` | `grok-4.7` |

```bash
bun run all --provider openai            # all demos on gpt-4.1
bun run reasoning --provider openrouter  # auto-uses deepseek/deepseek-v4-pro
bun run sampling --provider xai --model grok-4.7
```

**Reasoning is model-gated.** Because most providers' *default* models don't
reason, the `reasoning` demo automatically swaps to a reasoning-capable model
per provider (the table above; override with `--model`). The bridge only emits
`reasoning_effort` / extended thinking for reasoning models, so other demos on
plain models are unaffected.

### Validated across all five providers

Every feature passes on every provider with an appropriate model. Notes on
model behavior (not bridge limitations):

- OpenAI / AI-Gateway reasoning models report `thoughtsTokenCount` but hide the
  reasoning *text*; Anthropic, Grok and DeepSeek reasoning models surface thought parts.
- **xAI Grok returns an empty response whenever `stop`/`stopSequences` is set**,
  so the `sampling` demo omits `stopSequences` on xAI (the bridge forwards it
  correctly; it works on the other four providers).
- Grok models may not reliably honor JSON-schema structured output.

## Local development (testing against the local build)

This example's `package.json` depends on the **published** range
`"adk-llm-bridge": "^0.7.0"`, which is what end users install. To run it
against the library in this checkout instead, use the packed-build flow from
[`../../DEVELOPMENT.md`](../../DEVELOPMENT.md#running-examples-locally). It
installs `npm pack`'s tarball into a temporary copy of the example, so this
folder and its `package.json` stay as they are:

```bash
# From the repository root
scripts/check-examples.sh native-features   # install, type check and bundle
scripts/test-example.sh native-features     # install, then start `bun run web`
```

To run the demos from such a copy, keep it with `KEEP_EXAMPLES_DIR=1
scripts/check-examples.sh native-features`, then `cd` into the printed
directory and run `bun run all` with your `.env` in place. Your real-key `.env`
is a throwaway: do not commit it (`node_modules/`, `bun.lock`, and `.env` are
gitignored).
