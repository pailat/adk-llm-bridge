# Agent result schemas

> **Experimental.** `adk-llm-bridge/agents/results` is new in 0.7.1. It needs
> the optional peer `zod` >= 4. Names may change before they are marked
> stable.

The subpath exports standard shapes for what a lane returns, so a host and the
bridge agree on them. Each shape has a versioned id, a frozen JSON Schema and a
zod parser. The schemas are not part of the run spec: `RunSpec` and
`runSpecHash` are unchanged.

## Schemas

| Id | Shape |
|----|-------|
| `implement@1` | `{ status: "done" \| "blocked" \| "failed", summary: string, changedPaths: string[], notes?: string }` |
| `tests@1` | `{ status: "done" \| "blocked" \| "failed", testPaths: string[], failingAsExpected: boolean }` |
| `review@1` | `{ verdict: "approve" \| "request_changes" \| "block", findings: { severity: "high" \| "medium" \| "low", path: string, line?: integer, summary: string }[] }` |
| `gate@1` | `{ passed: boolean, checks: { id: string, exitCode: integer, durationMs: integer }[] }` |

Every object is closed: an unknown key is invalid. A released version never
changes; a new shape gets a new id, such as `implement@2`, next to the old one.

## Use

```ts
import {
  agentResultJsonSchemas,
  checkChangedPaths,
  parseAgentResult,
} from "adk-llm-bridge/agents/results";

// Ask the agent for the shape, for example through Claude Code's --json-schema.
// See "Agent compatibility" below before you pass one to Codex.
const jsonSchema = agentResultJsonSchemas["implement@1"];

// Check what came back.
const parsed = parseAgentResult("implement@1", structuredOutput);
if (!parsed.ok) {
  // parsed.issues: [{ path: ["status"], message: "..." }, ...]
} else {
  const refusals = checkChangedPaths(parsed.value, lane.allowedPaths);
  // [] when every changed path is inside the lane's allowed paths.
}
```

| Export | What it is |
|--------|------------|
| `AGENT_RESULT_SCHEMA_IDS` | The ids, frozen |
| `agentResultJsonSchemas` | JSON Schema per id, with no `$schema`, deeply frozen; each `title` is its id |
| `agentResultSchemas` | zod parser per id |
| `ImplementResultV1Schema`, `TestsResultV1Schema`, `ReviewResultV1Schema`, `GateResultV1Schema` | The zod parsers by name |
| `parseAgentResult(id, value)` | `{ ok: true, value }` or `{ ok: false, issues }`; throws `TypeError` for an unknown id |
| `checkChangedPaths(result, allowedPaths)` | Refusals for the changed paths no allowed path covers |
| `CHANGED_PATH_REFUSAL_CODES` | `CHANGED_PATH_INVALID`, `CHANGED_PATH_OUTSIDE_ALLOWED_PATHS` |

The JSON Schemas are written out by hand and use only `type`, `enum`,
`properties`, `required`, `additionalProperties` and `items`. They have no
length or number bounds. The parser accepts the same values, except that it
also rejects integers beyond `Number.MAX_SAFE_INTEGER`.

### Agent compatibility

- **No `$schema`.** Each document is valid under draft-07 and 2020-12 and
  names neither. Claude Code checks `--json-schema` with a draft-07 validator
  that rejects a 2020-12 `$schema`, so do not add one.
- **Strict structured output.** Codex's `outputSchema` uses OpenAI strict
  mode, which needs every property listed in `required`. `tests@1` and
  `gate@1` meet it. `implement@1` (`notes`) and `review@1` (a finding's
  `line`) have optional properties, so Codex does not accept them as they
  are.

## Changed paths

`checkChangedPaths` reads the `changedPaths` of a result, such as
`implement@1`, and compares each one with the lane's allowed paths:

- An allowed path covers the entry it names and everything below it; `.`
  covers the whole project. `src/billing` covers `src/billing/a.ts` but not
  `src/billing-old/a.ts`.
- A changed path is compared in canonical form, so `./src/a.ts` is `src/a.ts`.
- A changed path that is empty, absolute, uses `\`, contains NUL, has a `..`
  segment or names the root is refused with `CHANGED_PATH_INVALID`.
- A path no allowed path covers is refused with
  `CHANGED_PATH_OUTSIDE_ALLOWED_PATHS`.

Each refusal has the `code`, the `index` in `changedPaths`, the `path` as
written and a `message`. The host decides what a refusal does to the run. An
allowed path that is not canonical throws `TypeError`, because it is the
host's mistake, not the agent's.
