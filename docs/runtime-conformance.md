# Runtime conformance

This project checks the OpenAI Chat Completions boundary used by `CustomLlm`
in two tiers. The tiers intentionally make different claims:

1. **Deterministic protocol fixtures** run on every pull request, on pushes to
   `main`, and under the default `bun test` discovery. They prove bridge
   request/response behavior without downloading a model or starting a real
   runtime.
2. **Real-runtime conformance** runs on the weekly schedule and by manual
   workflow dispatch. It starts Ollama and the official vLLM CPU server, runs
   the same capability contract against named models, and uploads one JSON
   report per runtime. LM Studio uses the same runner manually because its
   normal distribution is a desktop application.

Fixture success does not claim that every model served by a runtime supports a
feature. Real-runtime results are scoped to the exact runtime version and model
printed in the report.

## Capability matrix

`Fixture` means a deterministic Chat Completions wire fixture is enforced in
normal CI. `Scheduled` means the real runtime is automatically started and the
capability is a required pass. `Manual` means the capability is checked by the
same real-runtime runner against a user-started endpoint.

| Capability | Ollama fixture | vLLM fixture | LM Studio fixture | Ollama real | vLLM real | LM Studio real |
| --- | --- | --- | --- | --- | --- | --- |
| Non-streaming text | Fixture | Fixture | Fixture | Scheduled | Scheduled | Manual |
| Streaming partial text | Fixture | Fixture | Fixture | Scheduled | Scheduled | Manual |
| Tool call → result → final answer | Fixture | Fixture | Fixture | Scheduled | Scheduled | Manual |
| Streamed tool-call argument reconstruction | Fragmented fixture | Fragmented fixture | Fragmented fixture | Scheduled bridge | Scheduled bridge | Manual bridge |
| Structured JSON when supported | `json_schema` | `json_schema` | `json_object` | Scheduled `json_schema` | Scheduled `json_schema` | Manual/profiled |
| Cancellation through `AbortSignal` | Fixture | Fixture | Fixture | Scheduled | Scheduled | Manual |
| Optional/missing caller API key | Fixture | Fixture | Fixture | Scheduled | Scheduled | Manual |
| Unsupported-feature error reporting | Fixture HTTP 400 | Fixture HTTP 400 | Fixture HTTP 400 | Scheduled | Scheduled | Manual |

The deterministic profiles live in
`tests/conformance/fixtures/chat-completions-server.ts`. The fixture sends tool
arguments in multiple SSE deltas and verifies that the bridge emits one parsed
function call. The real-runtime runner sends its streamed tool request through
`CustomLlm` and verifies the reconstructed function name and arguments; it does
not require a runtime to split valid arguments across multiple wire chunks. The
fixture also returns an error containing `runtime`, `model`, and the rejected
`response_format.type`; the bridge must retain that context.

Tool checks validate that the `city` argument matches the requested location.
The deterministic fixture derives its final sentence from the serialized tool
payload, while the real-runtime runner requires the final answer to contain the
supplied temperature and Celsius unit. An arbitrary non-empty answer does not
pass.

The missing-key case deliberately omits the caller's API key. The OpenAI SDK
requires a non-empty constructor credential, so `CustomLlm` supplies its
documented harmless placeholder authorization value. The conformance claim is
that an endpoint with optional authentication remains usable, not that the HTTP
`Authorization` header is absent.

## Running deterministic fixtures

```sh
bun run typecheck:conformance
bun run check:conformance
bun test tests/conformance
```

No real endpoint, model download, API key, or GPU is required. Failures include
the identifying tuple in the test name:

```text
runtime=<runtime> model=<model> feature=<feature>
```

## Running a real endpoint

Start an OpenAI-compatible server, then set the endpoint through `/v1` and its
exact served model ID:

```sh
CONFORMANCE_RUNTIME=vllm \
CONFORMANCE_RUNTIME_VERSION=0.25.1 \
CONFORMANCE_BASE_URL=http://127.0.0.1:8000/v1 \
CONFORMANCE_MODEL=Qwen/Qwen2.5-1.5B-Instruct \
bun run scripts/conformance/run-runtime.ts
```

Set `CONFORMANCE_API_KEY` only when the endpoint requires it. Set
`CONFORMANCE_REPORT` to write the complete JSON report to a file. A capability
failure is printed as:

```text
[FAIL] runtime=<runtime> runtimeVersion=<version> model=<model> feature=<feature> detail=<reason>
```

The runner continues after a failure so one execution reports the complete
matrix, then exits non-zero if any required capability failed. Its streaming
checks pass through `CustomLlm` and require a terminal response with
`turnComplete: true`; partial data followed by EOF does not pass. Its tool check
also requires valid reconstructed arguments. Deterministic fixtures separately
prove reconstruction from multiple argument deltas. Reports count `pass`,
`fail`, and `skip` separately. A capability disabled by the runtime profile is
recorded and printed as `[SKIP]`; it never increments the passed count.

The cancellation check aborts after the first partial response and requires the
bridge iterator to end without yielding any post-abort response. A server that
ignores `AbortSignal` and completes normally therefore fails instead of being
mistaken for successful cancellation.

The structured-output check uses a closed object schema with three required,
enum-constrained values and rejects missing, changed, or additional properties.
The deterministic fixture also verifies the complete `json_schema` wire
envelope, including its name, strictness setting, and nested schema.

`CONFORMANCE_RUNTIME_VERSION` is required and is copied into the report and
each capability result. `CONFORMANCE_API_KEY` is used only for request
authentication and is never included in report metadata. As a defensive
measure, the runner redacts the key if a provider repeats it in an error. It
also strips user information, query parameters, and fragments from the
`baseURL` written to reports; do not place credentials in URL paths.

### Automated runtimes

The workflow pins Ollama `0.32.0` via its versioned Linux amd64 release asset
and vLLM `0.25.1` via
`vllm/vllm-openai-cpu:v0.25.1-x86_64`. It uses `qwen2.5:1.5b` with Ollama and
`Qwen/Qwen2.5-1.5B-Instruct` with vLLM. The vLLM server enables automatic tool
choice and its Hermes parser, the documented parser for Qwen2.5 models. The CPU
image avoids making the scheduled check dependent on a self-hosted GPU runner.
Change a runtime reference and its `runtime_version` matrix value together so
reports retain the exact tested version.

The workflow polls Ollama's local readiness endpoint before pulling the pinned
model, then polls each runtime's Chat Completions model endpoint before running
the capability checks.

- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [vLLM CPU image](https://docs.vllm.ai/en/v0.25.1/getting_started/installation/cpu/)
- [vLLM tool calling](https://docs.vllm.ai/en/v0.25.1/features/tool_calling/)

### LM Studio manual profile

Load a tool-capable instruct model in LM Studio, start its local OpenAI-compatible
server, and run:

```sh
CONFORMANCE_RUNTIME=lm-studio \
CONFORMANCE_RUNTIME_VERSION=<exact-lm-studio-version> \
CONFORMANCE_BASE_URL=http://127.0.0.1:1234/v1 \
CONFORMANCE_MODEL=<exact-loaded-model-id> \
bun run scripts/conformance/run-runtime.ts
```

If that model/runtime combination does not implement JSON Schema, set
`CONFORMANCE_EXPECT_STRUCTURED_JSON=false`. The report then records structured
JSON with explicit `status: "skip"` and includes it in the `skipped` count; it
does not claim support or include that capability in `passed`.

## Unsupported features and interpretation

The unsupported-feature scenario sends the real, intentionally invalid
Chat Completions protocol shape `response_format: { "type": "xml" }`.
Deterministic fixtures and real-runtime checks use that same request. A
conforming runtime must reject it with HTTP 400, 415, or 422, and the bridge
must surface that 4xx status plus a meaningful message identifying the invalid
or unsupported response format/type. Connection failures, generic provider
errors, authentication/rate-limit errors, and 5xx responses do not prove
unsupported-feature handling and therefore fail this scenario. Accepting and
ignoring the invalid feature also fails conformance because callers otherwise
cannot distinguish support from silent degradation.

Results apply to Chat Completions only. They do not cover embeddings, the
Responses API, multimodal input, bidirectional live connections, or every model
available through a runtime.

## Issue #84 ADK registry compatibility boundary

The integrated registry tests exercise `LLMRegistry.resolve` and
`LLMRegistry.newLlm` with the repository's installed `@google/adk` development
version. This conformance infrastructure cannot prove that `resolve` has the
same public behavior across the entire declared peer range
`@google/adk >=0.6.1 <2`: the deterministic protocol fixtures do not install
alternate peer versions, and doing so here would require dependency/lockfile
changes outside issue #86 ownership.

Accordingly, the cross-version `LLMRegistry.resolve` assumption remains an
explicit deferred risk from issue #84. Coverage must not be described as a
peer-range guarantee until a separate dependency-version matrix verifies the
minimum supported ADK release and representative later releases, or the
registry implementation isolates itself from `resolve` behavior.
