# External-Agent SDK Integration — Remediation Plan (Codex + Claude)

_Date: 2026-06-20. Scope: `/home/alex/Projects/ADK/adk-llm-bridge-onmain`. Plan only — no source edits._

## 1. Executive summary

The Codex (`@openai/codex-sdk`) and Claude (`@anthropic-ai/claude-agent-sdk`) external-agent drivers are functionally working but carry several confirmed correctness and policy-fidelity defects, and both dependency pins are stale (Codex 0.130.0 vs 0.141.0; Claude 0.2.141 vs 0.3.183 — the caret pins can never reach the current line). The headline fixes: **Claude** maps a read-only policy to `permissionMode: "plan"` (interactive planning mode that refuses tool execution) and silently inherits host `~/.claude`/project settings because `settingSources` is never set — both undermine deterministic policy-driven execution; it also never wires an `abortController`, orphaning the spawned CLI on early break/error. **Codex** uses the wrong availability signal (the SDK ships its own bundled binary, so "codex on PATH" is meaningless), never persists the thread id from the `thread.started` event (losing resumability on mid-turn failure), and drops ambient proxy/`CODEX_ACCESS_TOKEN` vars from the replacement env. Both drivers blanket-label every error `recoverable: true`, so upstream retry loops spin on unfixable auth/billing failures. This plan bumps both SDKs to current, corrects auth/availability and permission-mode mapping per current docs, fixes lifecycle/error surfacing, and adds the tests/smoke checks to prove each fix.

**Dropped / reclassified from the source audits** (do NOT action as written):
- **ERR-1 (Claude permission-denied message)** — REFUTED (`isReal=false`). `SDKPermissionDeniedMessage.message` exists and `claude-agent-sdk.ts:349` already reads it via `stringValue(record.message)`. Only a minor enhancement remains (append `tool_name`/`decision_reason`); folded into ERR-2 as low.
- **CODEX-2 "fall back to `OPENAI_API_KEY`"** — the premise that `OPENAI_API_KEY` is Codex's recommended programmatic auth is **NOT grounded**. Codex CLI auth precedence is `CODEX_API_KEY` > ephemeral store > `CODEX_ACCESS_TOKEN` > `auth.json`; `OPENAI_API_KEY` is not a Codex CLI credential variable. The driver's use of `CODEX_API_KEY` is correct. The only real defect is the example guard's `OPENAI_API_KEY` check (UX inconsistency, low).
- **LIFECYCLE-1 "Codex abort"** — partially stale: the **Codex** driver already passes `signal: request.context?.abortSignal` (`codex-sdk.ts:203`). LIFECYCLE-1 applies to the **Claude** driver only.

---

## 2. Codex (`@openai/codex-sdk`)

### Version & bump

| | Current | Latest | Action |
|---|---|---|---|
| installed | `0.130.0` (pins `@openai/codex` 0.130.0) | `0.141.0` (npm, 2026-06-20) | bump |

- **Root `package.json:63`** peer `">=0.130.0"` → keep `>=0.130.0` lower bound but widen to current line, e.g. `">=0.130.0 <0.142"` (optional peer; do not force a hard floor on consumers).
- **Root `package.json:84`** dev `"^0.130.0"` → `"^0.141.0"`.
- **`examples/basic-agent-codex/package.json:15`** dep `"^0.130.0"` → `"^0.141.0"`.
- Re-run `bun install` and the suite against 0.141.0. TS API surface (`Codex`/`Thread`/`CodexOptions`/`ThreadOptions`/`ThreadEvent`, `ThreadStartedEvent`) is unchanged 0.130→current (verified against installed `node_modules/@openai/codex-sdk/dist/index.d.ts:106-164,218,229`), so this is a within-0.x minor bump with no expected API break. **Note** the upstream main-branch SDK README now describes env as merged "on top of" `process.env` rather than full replacement — re-verify env semantics after the bump (see CODEX-3).

### Confirmed issues (severity-ordered)

| id | sev | location | summary |
|---|---|---|---|
| CODEX-1 | medium | `examples/basic-agent-codex/agent.ts:79-87`; driver `codex-sdk.ts:289-297,742-777` | Availability detection keys on `codex` on PATH and never checks `~/.codex/auth.json`; the SDK ships a **bundled** binary (`node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex` present), so PATH is the wrong signal. Worst case: a run starts with no usable credential and 401s. |
| CODEX-3 | medium | driver `codex-sdk.ts:302-320`; allowlist `provider/codex.ts:9-16` | `buildEnv` builds a **replacement** env (SDK does not inherit `process.env` when `env` is supplied — `dist/index.d.ts:229`). Ambient proxy vars (`https_proxy`/`HTTPS_PROXY`/`NO_PROXY`) are not allowlisted at all, and `CODEX_ACCESS_TOKEN` is missing from `CODEX_ENV_ALLOWLIST`, so they are dropped. A custom shell `CODEX_HOME` is lost unless delivered via structured credential (it IS allowlisted; the gap is ambient delivery). |
| CODEX-4 | medium | driver `codex-sdk.ts:216,322-365` | Thread id is read as `thread.id` only **after** the stream loop; `normalizeEvent` has no `thread.started` branch. `thread.id` is null until the first turn starts; if the stream throws mid-turn, the id is never captured and resumability is lost. (`ThreadStartedEvent {type:"thread.started", thread_id}` exists — `dist/index.d.ts:106-109,164`.) |
| CODEX-5 | medium | driver `codex-sdk.ts:231-239,330-353,387-404` | All catch/stream errors yield `recoverable:true`; `describeError` only special-cases the literal "Unable to locate Codex CLI binaries". A 401/auth or missing-credential error passes through as recoverable, so retry loops spin. |
| CODEX-2 | low | driver `codex-sdk.ts:257`; example `agent.ts:81` | Driver resolves `apiKey` from config then `CODEX_API_KEY` (correct). The example guard checks `OPENAI_API_KEY`, so a run can proceed and then 401 — internal inconsistency only. |
| CODEX-6 | low | driver `codex-sdk.ts:742-816` | Manual bundled-binary candidate table duplicates SDK-internal resolution (hardcoded vendor triples, 8 ancestor dirs); brittle to future vendor-layout changes and can pick a binary from an unrelated parent workspace. Not broken today; only populates the optional `codexPathOverride`. |
| CODEX-7 | low | driver `codex-sdk.ts:263-273,407-442` | `webSearchMode`/`webSearchEnabled` are forwarded independently of `networkAccessEnabled` (`policy.allowNetwork`); a driver with web search enabled under `allowNetwork:false` (example sets `allowNetwork:false`) requests web search in a no-network sandbox. |

### Remediation steps

1. **Correct auth + availability detection (CODEX-1, CODEX-2).**
   - In `examples/basic-agent-codex/agent.ts:79-87` `codexCredentialsAvailable()`: stop treating "codex on PATH" as the availability signal (the SDK bundles its own binary). Replace the signal with: config/`CODEX_API_KEY` present **OR** a readable `auth.json` at `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) **OR** an explicit `CODEX_EXECUTABLE`/`CODEX_CLI_PATH`. Keep `OPENAI_API_KEY` only as an optional convenience signal (and, if kept, document that it is mapped onto `CODEX_API_KEY`, not used directly by the CLI). Update the printed hint accordingly. The guard must still skip cleanly (exit 0) when nothing is present.
   - Optional, low-risk: have the example/driver, when `OPENAI_API_KEY` is set but `CODEX_API_KEY` is not, map it onto `CODEX_API_KEY` so the guard and the driver agree — or simply align the guard to check `CODEX_API_KEY`. Do not add an `OPENAI_API_KEY` fallback inside the driver's credential resolution.
   - **Citation:** `developers.openai.com/codex/auth` (fetched 2026-06-20) — "We recommend API key authentication for programmatic Codex CLI workflows"; `developers.openai.com/codex/noninteractive` — `CODEX_API_KEY=<api-key> codex exec`. Auth precedence (`CODEX_API_KEY` > ephemeral > `CODEX_ACCESS_TOKEN` > `auth.json`, `$CODEX_HOME` default `~/.codex`) from `codex-rs/login/src/auth/manager.rs` via Context7 `/openai/codex` (2026-06-20). Bundled binary confirmed empirically (`node_modules/@openai/codex-linux-x64/vendor/.../codex` present; `@openai/codex-sdk` pins `@openai/codex` exactly). **Grounded.**

2. **Deterministic no-credential behavior (CODEX-1, CODEX-5).**
   - Ensure that when no credential is resolvable the run fails fast and **non-recoverable** rather than starting a turn that 401s with `recoverable:true`. In `codex-sdk.ts` `describeError`/`normalizeEvent`/catch (lines 231-239, 330-353, 387-404): classify errors — surface auth (401)/missing-credential and missing-binary as **non-recoverable** with a distinct code (e.g. `CODEX_AUTH_ERROR`); only mark transient transport errors `recoverable`. Inspect `ThreadErrorEvent {message}` and `TurnFailedEvent {error:{message}}` (the SDK exposes only a message string, so classification is heuristic on the message text + a 401/auth substring check).
   - **Citation:** `ThreadErrorEvent`/`TurnFailedEvent` in installed `dist/index.d.ts`; `developers.openai.com/codex/auth` confirms 401 arises when valid credentials are unavailable (non-retryable). **Grounded.**

3. **Forward proxy/cert/token vars through the replacement env (CODEX-3).**
   - In `src/agents/provider/codex.ts:9-16` add `CODEX_ACCESS_TOKEN` to `CODEX_ENV_ALLOWLIST` (documented auth var).
   - In `codex-sdk.ts:302-320` `buildEnv`, additionally copy ambient proxy/cert vars from `this.#env` when present: `HTTPS_PROXY`/`https_proxy`, `HTTP_PROXY`/`http_proxy`, `NO_PROXY`/`no_proxy`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CODEX_HOME` (so a custom shell `CODEX_HOME` is not lost even when not delivered via credential). Do this via the same `copyIfPresent` mechanism used for `PATH`/`HOME`.
   - After the version bump, re-verify whether 0.141.0 still fully replaces `process.env` (current main README suggests it may now merge on top); if it merges, the proxy-var copy becomes belt-and-suspenders rather than required.
   - **Citation:** Installed `dist/index.d.ts:229` "will not inherit variables from `process.env`"; `CODEX_ACCESS_TOKEN` is a documented auth.json-precedence var (Context7 `/openai/codex`, 2026-06-20). **Grounded for 0.130.0; re-verify after bump.**

4. **Capture thread id from `thread.started` (CODEX-4).**
   - In `codex-sdk.ts` `normalizeEvent` (322-365) add a branch for `type === "thread.started"` that records `event.thread_id` immediately, and in `run()` emit the `state_delta` as soon as the id is known (do not wait for the post-loop `thread.id` read at line 216). This persists resumability even if the stream throws mid-turn.
   - **Citation:** `ThreadStartedEvent {type:"thread.started", thread_id}` `dist/index.d.ts:106-109,164`; `get id()` "Populated after the first turn starts"; `resumeThread` persists to `~/.codex/sessions`. **Grounded.**

5. **Reconcile web search with sandbox network (CODEX-7).**
   - In `buildThreadOptions` (263-273): only forward `webSearchMode`/`webSearchEnabled` when the resolved `networkAccessEnabled` (from `policy.allowNetwork`) is true; otherwise omit/disable them.
   - **Citation:** `ThreadOptions` exposes `networkAccessEnabled`/`webSearchMode`/`webSearchEnabled`/`sandboxMode` (`dist/index.d.ts:238-249`). Semantic (web search needs network egress) is logically sound; exact conflict behavior is not explicitly documented — safe, low-risk improvement. **Grounded on type surface; semantics inferred.**

6. **Prefer SDK binary resolution (CODEX-6) — optional cleanup.**
   - Leave `codexPathOverride` unset unless the user supplies `CODEX_EXECUTABLE`/`CODEX_CLI_PATH`; lean on the SDK's own bundled-binary resolution rather than the hardcoded candidate table (`742-816`). Keep the SDK and its pinned `@openai/codex` CLI on the same version (the SDK pins it exactly). The manual table can remain as a best-effort last resort but should not be the primary path.
   - **Citation:** `@openai/codex-sdk` package.json pins `@openai/codex` exactly; SDK spawns the bundled CLI. **Grounded.**

---

## 3. Claude (`@anthropic-ai/claude-agent-sdk`)

### Version & bump

| | Current | Latest | Action |
|---|---|---|---|
| installed | `0.2.141` | `0.3.183` (npm, 2026-06-20) | bump |

- **Root `package.json:61`** peer `">=0.2.138"` → widen to span the current line, e.g. `">=0.2.138 <0.4"` (optional peer).
- **Root `package.json:79`** dev `"^0.2.138"` → `"^0.3.183"`.
- **`examples/basic-agent-claude/package.json:14`** dep `"^0.2.138"` → `"^0.3.183"`.
- Caret on `0.2.138` can never resolve `0.3.x` (npm 0.x caret semantics lock the minor), so the current line is unreachable today. No confirmed hard API break was found (`query` signature, `settingSources`, `permissionMode`, `systemPrompt` preset/append, `includePartialMessages`, `abortController`, `SDKAssistantMessageError`/`SDKResultError` all present in current docs + installed types), so this is stale-pin/untested-drift, not a known incompatibility. Re-run the suite against 0.3.183.

### Confirmed issues (severity-ordered)

| id | sev | location | summary |
|---|---|---|---|
| AUTH-1 | high | driver `claude-agent-sdk.ts:184,127`; example `basic-agent-claude/agent.ts` (never sets it) | `settingSources` defaults `undefined` and `removeUndefined` strips the key, so it is omitted — which loads **all** host sources (user `~/.claude` + project `.claude` + local): permission rules, MCP servers, hooks, CLAUDE.md. This can override the intended read-only policy. |
| PERM-1 | high | driver `claude-agent-sdk.ts:470-471` | A read-only policy maps to `permissionMode: "plan"` — interactive planning mode that refuses tool execution and drives an `ExitPlanMode` workflow. A read-only Q&A run can stall or return a plan artifact instead of an answer. |
| LIFECYCLE-1 | high | driver `claude-agent-sdk.ts:148-172,174-196`; `external-agent-driver.ts:15-28` | The `for await` over `sdk.query` sets no `abortController`, has no `try/finally`, and never calls `Query.interrupt()`/`return()`. On early consumer break/upstream error the SDK-owned `claude` subprocess is orphaned. No abort signal is threaded through `ExternalAgentRunRequest`. (Contrast: the Codex driver already passes `signal` at `codex-sdk.ts:203`.) |
| VER-1 | medium | `package.json:61,79`; both example manifests | Caret pin can never reach 0.3.x; latest 0.3.183. Drift risk (covered by the bump above). |
| ERR-2 | medium | driver `claude-agent-sdk.ts:158-167,300-311,318-336` | Catch and assistant/result error paths emit `recoverable:true` unconditionally, collapsing the typed `SDKAssistantMessageError` enum (`authentication_failed`/`oauth_org_not_allowed`/`billing_error`/`rate_limit`/`invalid_request`/`server_error`/`max_output_tokens`) and `SDKResultError` subtypes (`error_max_turns`/`error_max_budget_usd`/…). Non-recoverable conditions are mislabeled recoverable. |
| STREAM-1 | low | driver `claude-agent-sdk.ts:174-196,296-362`; `claude-agent.ts:20` | `includePartialMessages` is never set and there is no `stream_event` branch, yet `capabilities.streaming:true` is advertised. Output is emitted at full-assistant-message granularity, not token deltas. |
| ERR-3 | low | driver `claude-agent-sdk.ts:318-321` | `result` subtype `success` ignores `record.result` (the final aggregated answer). Normally redundant (assistant text already arrived); edge case where the answer is delivered only on the result message yields silent-empty output. |
| AUTH-2 | low | driver `claude-agent-sdk.ts:187-189,43` | `systemPrompt` is unconditionally the `claude_code` preset; the type allows a plain string but `buildOptions` never uses it. The SDK no longer defaults to the `claude_code` preset (minimal default since v0.1.0), so forcing the full coding-agent prompt changes persona/token cost for plain Q&A with no opt-out. |
| ERR-1 | DROP | `claude-agent-sdk.ts:349`; `sdk.d.ts:3202-3225` | **Refuted** — message field exists and is already surfaced. Only a minor enrichment remains (append `tool_name`/`decision_reason`), folded into ERR-2. |

### Remediation steps

1. **Isolate from host settings (AUTH-1).**
   - In `ClaudeAgentSdkDriver` default `settingSources` to `[]` (SDK isolation mode) instead of leaving it `undefined`, OR have the example pass an intentional allowlist. Because the constructor (`:127`) leaves it `undefined` and `removeUndefined` (`:195,670-674`) strips it, the fix is to provide an explicit default (`[]`) so the key is sent. Allow consumers to opt into specific sources via `ClaudeAgentSdkDriverConfig.settingSources`.
   - **Citation:** `code.claude.com/docs/en/agent-sdk/typescript` ("Programmatic Configuration for SDK-Only Applications": pass `[]` to opt out) and `.../claude-code-features` ("Omitting `settingSources` defaults to loading all three: user, project, and local"); installed `sdk.d.ts:1659-1669`. Context7, 2026-06-20. **Grounded.**

2. **Correct read-only permission-mode mapping (PERM-1).**
   - In `mapPolicyToClaudeSdkPermission` (`:461-480`): map a read-only policy to `permissionMode: "default"` (with read-only/no-edit rules) or `"dontAsk"` — NOT `"plan"`. `"plan"` is interactive planning mode that explores without executing and uses `ExitPlanMode`; it is wrong for plain Q&A. Reserve `"acceptEdits"`/`"bypassPermissions"` for write/full-access as today.
   - **Citation:** `code.claude.com/docs/en/agent-sdk` PermissionMode literal — `"plan"` = "Planning mode - explore without editing", `"dontAsk"` = "Deny anything not pre-approved"; `ExitPlanMode` tool docs; installed `sdk.d.ts:1834`. Context7, 2026-06-20. **Grounded.**

3. **Lifecycle / cancellation (LIFECYCLE-1).**
   - Thread an abort signal through `ExternalAgentRunRequest` (`external-agent-driver.ts:15-28`) — mirror how Codex reads `request.context?.abortSignal`.
   - In `buildOptions` (`:174-196`) set `abortController` from that signal, and/or capture the `Query` object from `sdk.query(...)` and call `interrupt()`/`return()` inside a `try/finally` around the `for await` loop (`:148-172`) so the spawned `claude` subprocess is cleaned up on early break or error.
   - **Citation:** installed `sdk.d.ts:1160` `Options.abortController` ("When aborted, the query will stop and clean up resources") and `:2023-2033` `Query.interrupt()`; query control/abort at `code.claude.com/docs/en/agent-sdk/typescript`. Context7, 2026-06-20. **Grounded.**

4. **Auth precedence — verify, do not rewrite (AUTH-2 context / best practice).**
   - The driver's `buildEnv` (`:273-294`) replacement-env + `envAllowlist` approach is **correct** and already includes API key, OAuth token, Bedrock/Vertex/Foundry switches (`provider/schema.ts:30-41`). Credentials resolve **inside** the spawned CLI: `ANTHROPIC_API_KEY` (API key) → existing Claude Code OAuth/subscription (`CLAUDE_CODE_OAUTH_TOKEN`) → native CLI auth. Because env **replaces** `process.env`, keep copying `PATH`/`HOME`/`CLAUDE_CONFIG_DIR`/`XDG_CONFIG_HOME` (already done).
   - Enhancement (not currently implemented): read the init `SDKSystemMessage.apiKeySource` to fail fast / report which auth path is in use. Do not change the precedence — only add observability.
   - Keep the example guard (`basic-agent-claude/agent.ts:71-79`) as is (it already checks `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN`/executable) — it is consistent with the driver, unlike the Codex guard.
   - **Citation:** `buildEnv` env semantics + `apiKeySource` on `SDKSystemMessage` (installed `sdk.d.ts`); auth/env guidance at `code.claude.com/docs/en/agent-sdk/typescript`. Context7, 2026-06-20. **Grounded.**

5. **Error classification (ERR-2, + ERR-1 enrichment).**
   - In `normalizeMessage` (`:296-362`) and the `run` catch (`:158-167`): set `recoverable` from the typed enums instead of blanket `true`. Treat `authentication_failed`/`oauth_org_not_allowed`/`billing_error`/`invalid_request` and result subtypes `error_max_turns`/`error_max_budget_usd`/`error_max_structured_output_retries` as **non-recoverable**; `rate_limit`/`server_error`/transient transport as recoverable. Use a meaningful `code` from the subtype.
   - For permission-denied (`:345-355`), additionally append `record.tool_name` and `record.decision_reason`/`decision_reason_type` to the surfaced message (the rejection text itself is already surfaced — ERR-1 refuted).
   - **Citation:** installed `sdk.d.ts:2465-2470` `SDKAssistantMessageError` enum, `:3292-3322` `SDKResultError` subtypes/`errors[]`, `:3202-3225` `SDKPermissionDeniedMessage` (`tool_name`/`decision_reason`/`message`); result/message types at `code.claude.com/docs/en/agent-sdk/typescript`. Context7, 2026-06-20. **Grounded.**

6. **Streaming fidelity (STREAM-1) — choose one.**
   - Either set `includePartialMessages: true` in `buildOptions` and add a `stream_event` branch in `normalizeMessage` that handles `content_block_delta`/`text_delta` to emit incremental output; **or** drop the `streaming:true` claim from `claude-agent.ts:20` capabilities to match actual behavior.
   - **Citation:** `code.claude.com/docs/en/agent-sdk/streaming-output` (TS example sets `includePartialMessages:true` and reads `message.type==='stream_event'` → `content_block_delta` → `text_delta`); installed `sdk.d.ts:1392`. Context7, 2026-06-20. **Grounded.**

7. **Result fallback (ERR-3) — optional.**
   - In the `result` `success` branch (`:318-321`), if no assistant text was emitted during the turn, fall back to `record.result` (the final aggregated answer) before emitting `completed`, to avoid silent-empty output on that edge.
   - **Citation:** `SDKResultSuccess.result:string` installed `sdk.d.ts:3314-3322`. **Grounded.**

8. **Plain-string system prompt (AUTH-2) — optional.**
   - In `buildOptions` (`:187-189`) honor a configured plain-string `systemPrompt` (the type at `:43` already allows it) so non-coding agents are not forced into the `claude_code` preset; keep preset+append as the opt-in default.
   - **Citation:** `code.claude.com/docs/en/agent-sdk/modifying-system-prompts` (plain-string `systemPrompt`) + migration-guide (minimal default since v0.1.0). Context7, 2026-06-20. **Grounded.**

---

## 4. Cross-cutting items

- **Shared abort plumbing.** Add an abort/cancellation signal to `ExternalAgentRunRequest` (`src/agents/external-agent-driver.ts:15-28`) as a first-class field. Codex already consumes `request.context?.abortSignal` (`codex-sdk.ts:203`); make Claude consume the same so both drivers share one cancellation contract (supports LIFECYCLE-1).
- **Shared error-classification helper.** Both drivers blanket-set `recoverable:true` (CODEX-5, ERR-2). Factor a small `classifyRecoverable(message|subtype)` helper (in `src/agents/runtime/` or `events.ts`) that maps auth/billing/missing-binary/quota-exhausted → non-recoverable and transport/rate-limit → recoverable, and use it in both `normalizeEvent`/`normalizeMessage` and the catch blocks. Add distinct codes (`CODEX_AUTH_ERROR`, reuse `CLAUDE_AUTH_STATUS`/subtype codes).
- **Example guard consistency.** Codex example guard (`basic-agent-codex/agent.ts:79-87`) must align with the driver's `CODEX_API_KEY` + `auth.json` reality (CODEX-1/2). Claude example guard is already consistent; leave it. Both must continue to exit 0 with a clear hint when no credential is present.
- **Env-passthrough audit.** Reconcile `CODEX_ENV_ALLOWLIST` (`provider/codex.ts`) and the Claude allowlist (`provider/schema.ts:30-41`) with the ambient vars each `buildEnv` copies, since both drivers use replacement-env semantics; add proxy/cert vars (CODEX-3) and `CODEX_ACCESS_TOKEN`.

### Tests to add (Bun, under `tests/agents/`)

- **Codex auth/availability:** unit test that `codexCredentialsAvailable()` returns true for `auth.json` present + no PATH binary, and false for none; that the driver does not add an `OPENAI_API_KEY` fallback to credential resolution.
- **Codex `thread.started`:** feed a fake event stream emitting `thread.started` then a mid-turn throw; assert the `state_delta` carrying the thread id is emitted (resumability preserved) even on failure (`codex-sdk.test.ts`).
- **Codex env:** assert `buildEnv` forwards `CODEX_HOME`/proxy/cert/`CODEX_ACCESS_TOKEN` when present in `this.#env`/credential, and that the allowlist includes `CODEX_ACCESS_TOKEN`.
- **Codex web-search reconciliation:** assert `webSearchEnabled` is dropped when `allowNetwork:false`.
- **Codex/Claude error classification:** table-driven test mapping auth/billing/rate-limit/transport → expected `recoverable` and `code` for both drivers.
- **Claude `settingSources`:** assert the driver sends `settingSources: []` by default (not omitted) (`claude-agent-sdk.test.ts`).
- **Claude permission mode:** assert read-only policy → `permissionMode` `"default"`/`"dontAsk"` (NOT `"plan"`); keep existing write/full-access assertions.
- **Claude lifecycle:** assert an `abortController` is set on options and that `interrupt()`/`return()` is invoked on early break (spy on a fake `Query`).
- **Claude permission-denied enrichment:** assert `tool_name`/`decision_reason` are appended (guard against the ERR-1 over-correction — the base message must still be surfaced).

---

## 5. Ordered execution checklist

1. **Bumps first (low risk, unblocks testing against current APIs).** Update both SDK pins in root `package.json` (peer + dev) and both example manifests; `bun install`; run `bun run typecheck:all` and `bun test` to establish a green baseline on 0.141.0 / 0.3.183.
2. **Claude PERM-1** (read-only → `"default"`/`"dontAsk"`) — highest behavioral impact, smallest change.
3. **Claude AUTH-1** (`settingSources: []` default).
4. **Claude LIFECYCLE-1 + shared abort plumbing** (add abort field to `ExternalAgentRunRequest`; wire `abortController`/`interrupt` in Claude; confirm Codex already consumes it).
5. **Shared error-classification helper → apply to Claude ERR-2 and Codex CODEX-5** (incl. Codex deterministic no-credential non-recoverable failure).
6. **Codex CODEX-4** (`thread.started` capture).
7. **Codex CODEX-1/CODEX-2** (auth/availability detection in example guard; align `CODEX_API_KEY`).
8. **Codex CODEX-3** (allowlist `CODEX_ACCESS_TOKEN`; forward proxy/cert/`CODEX_HOME`) — re-verify env replacement semantics on 0.141.0.
9. **Codex CODEX-7** (web-search ↔ network reconciliation).
10. **Low-priority polish:** Claude STREAM-1 (enable partials or drop the claim), ERR-3 (result fallback), AUTH-2 (plain-string prompt), permission-denied enrichment; Codex CODEX-6 (prefer SDK binary resolution).
11. Add tests alongside each fix (section 4).

### Risks / verification

- **API drift from the bumps (VER-1 / Codex minor).** Mitigate: bump first (step 1) and rely on `bun run typecheck:all` to catch any 0.3.x / 0.141.0 type breaks before behavioral changes. No hard break is expected (surfaces verified in installed `.d.ts` and current docs), but the Claude minor jump (0.2→0.3) and the Codex env-merge README change warrant a fresh typecheck + full test run.
- **Prove permission/setting fixes (PERM-1, AUTH-1).** Unit tests on `mapPolicyToClaudeSdkPermission` and `buildOptions` output (`settingSources`, `permissionMode`); plus a no-cred smoke (`SMOKE_PROMPT` with no `ANTHROPIC_API_KEY`) must still exit 0, and a credentialed read-only smoke must return a direct answer (not a plan artifact / not stalling on `ExitPlanMode`).
- **Prove lifecycle (LIFECYCLE-1).** Test with a fake `Query` that records `interrupt()`/`return()` calls; assert they fire on early `break` and on thrown error; assert `abortController` present in options.
- **Prove Codex resumability (CODEX-4).** Fake event stream emitting `thread.started` then throwing; assert `state_delta` with the thread id is yielded.
- **Prove error classification (CODEX-5, ERR-2).** Table-driven tests; assert non-recoverable for auth/billing/missing-binary, recoverable for transport/rate-limit.
- **Prove env passthrough (CODEX-3).** Unit-assert forwarded keys; for runtime, a behind-proxy smoke (set `HTTPS_PROXY`) reaching the model proves egress survives the replacement env.
- **No-credential smoke (both providers).** `bun run` each example with all credential env vars unset → must print the hint and exit 0; with `CODEX_API_KEY`/`ANTHROPIC_API_KEY` set → must produce a response. Re-run the Codex smoke with only `auth.json` present (no PATH binary) to prove the corrected availability detection.
- **Gate:** `bun run ci` (typecheck:all + lint + test + build + lint:publish) must pass before and after the change set.
