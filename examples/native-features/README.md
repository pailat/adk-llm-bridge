# Native Features Showcase

A programmatic [Bun](https://bun.sh) + TypeScript CLI that demonstrates **every
native-model capability** [`adk-llm-bridge`](https://www.npmjs.com/package/adk-llm-bridge)
passes through to [Google ADK](https://google.github.io/adk-docs/)
([adk-js](https://github.com/google/adk-js), `@google/adk@^1.2.0`).

Each feature is an isolated "demo" you can run on its own, so you can inspect the
exact events, parts, and usage metadata the chat UI normally hides
(`usageMetadata.thoughtsTokenCount`, `part.thought === true`, partial-vs-final
streaming events, multimodal base64 input, and forced tool calls).

## Setup

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
bun run src/cli.ts sampling --provider openai --model gpt-4o
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

## Supported Models

Default: `claude-sonnet-4-6` (supports thinking, vision, and structured output).
Swap with `--model <id>` or the `MODEL` env var. For OpenAI, pass
`--provider openai` (default model `gpt-4o`) and set `OPENAI_API_KEY`.

## Local development (testing against the local build)

This example's `package.json` pins the **published** range
`"adk-llm-bridge": "^0.5.3"` — that's what end users install. When you are
working on the library itself and want to validate this example against your
**local, unpublished** source, use the `npm pack` flow from
[`../../DEVELOPMENT.md`](../../DEVELOPMENT.md) ("Manual Testing").

Do **not** use `file:../..`: it creates two copies of `@google/adk`, which
breaks type-checking via ADK's private `BASE_MODEL_SYMBOL` (see
[DEVELOPMENT.md → "The Problem with `file:../..`"](../../DEVELOPMENT.md)). A
packed tarball installs through `peerDependencies` and **deduplicates**
`@google/adk`, exactly like a real npm install.

```bash
# 1. Build + pack the library (run from the repo root)
cd ../..                       # repo root: adk-llm-bridge/
bun run build
rm -f adk-llm-bridge-*.tgz
npm pack                       # -> adk-llm-bridge-0.5.3.tgz

# 2. Install that tarball in THIS example
cd examples/native-features
rm -rf node_modules bun.lock package-lock.json
npm install ../../adk-llm-bridge-*.tgz

# 3. Prove there is a SINGLE, deduped @google/adk
npm ls @google/adk
#   native-features-example@
#   ├── @google/adk@1.2.0
#   └─┬ adk-llm-bridge@0.5.3
#     └── @google/adk@1.2.0 deduped     <-- one copy, deduped

# 4. Run the demos against the local build
cp .env.example .env           # add your ANTHROPIC_API_KEY
bun run all
```

The tarball install is **only** for local validation — the committed
`package.json` keeps the published `^0.5.3` range. The dev tarball
(`adk-llm-bridge-*.tgz`) and your real-key `.env` are throwaway artifacts: do
not commit them (`node_modules/`, `bun.lock`, and `.env` are gitignored).
