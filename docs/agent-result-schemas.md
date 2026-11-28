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

// Ask the agent for the shape, for example as a driver's outputSchema.
const outputSchema = agentResultJsonSchemas["implement@1"];

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
| `agentResultJsonSchemas` | JSON Schema (draft 2020-12) per id, deeply frozen; each `title` is its id |
| `agentResultSchemas` | zod parser per id |
| `ImplementResultV1Schema`, `TestsResultV1Schema`, `ReviewResultV1Schema`, `GateResultV1Schema` | The zod parsers by name |
| `parseAgentResult(id, value)` | `{ ok: true, value }` or `{ ok: false, issues }`; throws `TypeError` for an unknown id |
| `checkChangedPaths(result, allowedPaths)` | Refusals for the changed paths no allowed path covers |
| `CHANGED_PATH_REFUSAL_CODES` | `CHANGED_PATH_INVALID`, `CHANGED_PATH_OUTSIDE_ALLOWED_PATHS` |

The JSON Schemas are written out by hand and use only `type`, `enum`,
`properties`, `required`, `additionalProperties` and `items`, the keywords
structured output support commonly accepts. They have no length or number
bounds. The parser accepts the same values, except that it also rejects
integers beyond `Number.MAX_SAFE_INTEGER`.

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
