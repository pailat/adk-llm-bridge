# Workflow run spec (experimental)

> **Experimental.** `adk-llm-bridge/workflows/spec` is new in 0.7.0. Names and
> shapes can change before the subpath is stable.
>
> **Requires zod >= 4** (`zod@^4`). This subpath is the only one that needs
> it for the run spec; the other subpaths are unchanged.

A run spec is a JSON document that describes one run of a lanes workflow: the
workflow that executes it, the project root, a budget, the lanes with their
agents and allowed paths, and the gates before anything is published. The
subpath validates a spec against the host's rule set, plans it without running
anything, and exports the JSON Schema of its shape.

The module does no I/O, reads no environment variable and has no side effects
at import: the ids and descriptions of its zod schemas live in a registry of
the module, not in zod's global registry. It starts no agent, touches no file
and calls no provider. Those belong to the host, see
[What the host must do at run time](#what-the-host-must-do-at-run-time).

## Status and requirements

- Every public symbol is `@experimental`.
- Needs zod >= 4, an optional peer. zod is the single source of truth: each
  type is `z.infer` of a schema, and each schema is strict.
- Validation and planning are deterministic. They read no clock and no random
  source.
- Only `specVersion: 1` exists. There is no upgrade function: a later
  version will ship one together with its schema.
- **Stability policy.** While the subpath is experimental, a minor release can
  add, rename or remove an issue code, a rule key or a limit, and every such
  change is listed in the CHANGELOG. Within one release, the codes in
  `RUN_SPEC_ISSUE_CODES` are a closed set and each keeps one meaning, so a
  host can branch on them. This is the only place the policy is stated.

## Comparison with the existing plan and control-plane concepts

The spec reuses the workflow plan and control-plane types wherever a concept
already exists. It adds only what a plan does not describe.

| Concept | Existing | Run spec |
| --- | --- | --- |
| Lane id, role, dependencies | `WorkflowPlanLane.taskId`, `role`, `dependsOn` | Same names, types and id grammar. A lane's `taskId` is copied unchanged into the plan lane |
| Waves | `WorkflowPlanWave` | Derived by `layerRunSpecLanes`. A spec has no `waves` field, so there is one source for `dependsOn` |
| Owned paths | `WorkflowPathClaim` with scope `subtree`, `portablePathProblem`, `validateWorkflowPath`, `workflowPathClaimsOverlap` | `allowedPaths` as canonical relative paths, joined to `projectRoot` and mapped to `subtree` claims |
| Agent policy | `WorkflowPlanAgent` (role and policy, no provider) | Not duplicated. The plan gets one agent per role with no permissions. Provider, model, mode and tools stay in the spec |
| Provider, permission mode, network | `providerId`, `ExternalAgentPermissionMode`, `allowNetwork` | Same names and values. `full-access` is not allowed by any rule set |
| Workflow identity | `WorkflowExecutionRequest.workflowId`, `workflowVersion` | Same names and id grammar |
| Concurrency | `WorkflowExecutionLimits.maxConcurrency` | `maxConcurrency`, with the same meaning |
| Merge | `WorkflowMutationReservationPhase`, phase `integration` | `gates.publish.kind` is `integration` |
| Plan validation | `validateWorkflowPlan` | Called by `validateRunSpec` on the full plan of every spec the rule families accept, on the plan without paths once the graph rules pass, and by `resolveRunPlan`. Its failure is reported as `RUN_SPEC_PLAN_REJECTED` |
| Hash and JSON bounds | `canonicalDigest`, `freezeJson`, `immutableJson` | Called, not copied |
| Added by the spec | none | Budget, model, tool, MCP provider and environment allowlists, denied path patterns, step policy, QA and publish gates, human approval, `extensions` |

Differences from a plan and a start request, on purpose:

- The spec has no `waves` field. Waves are derived.
- The library has no default rule set. Allowlists merge by intersection, so a
  default would be either empty or permissive. Hosts write their own
  `RunRules`.
- A lane cannot name the project root as an allowed path, because the existing
  claim grammar rejects the root. A lane lists the directories it needs.
- Human approval is not a rule. A spec that commits or merges must set
  `gates.publish.hitl` to `true`, and the validator reports it otherwise.

## Example spec

This is a two-lane lanes job. Lane `api` adds an endpoint and writes tests
first. Lane `docs` waits for `api` and documents it. The spec validates under
the rule set the test suite uses for these examples (`testRules()` in
`tests/workflows/spec/helpers.ts`).

```json
{
  "specVersion": 1,
  "workflowId": "lanes",
  "workflowVersion": "1",
  "projectRoot": ".",
  "budget": {
    "maxUsd": 5
  },
  "maxConcurrency": 2,
  "lanes": [
    {
      "taskId": "api",
      "title": "Add the health endpoint",
      "role": "worker",
      "dependsOn": [],
      "allowedPaths": [
        "src/api",
        "tests/api"
      ],
      "agent": {
        "providerId": "claude-code",
        "model": "claude-sonnet-5",
        "mode": "workspace-write",
        "tools": [
          "Read",
          "Edit"
        ]
      },
      "steps": {
        "testsFirst": true,
        "review": {
          "kind": "agent",
          "providerId": "codex",
          "model": "gpt-5.5",
          "maxChangeRounds": 2
        }
      }
    },
    {
      "taskId": "docs",
      "title": "Document the health endpoint",
      "role": "worker",
      "dependsOn": [
        "api"
      ],
      "allowedPaths": [
        "docs/api.md"
      ],
      "agent": {
        "providerId": "codex",
        "model": "gpt-5.5",
        "mode": "workspace-write",
        "allowNetwork": false,
        "tools": []
      },
      "steps": {
        "testsFirst": false,
        "review": {
          "kind": "none"
        }
      }
    }
  ],
  "gates": {
    "qa": [
      {
        "id": "test",
        "command": [
          "bun",
          "run",
          "test"
        ]
      }
    ],
    "publish": {
      "kind": "commit",
      "hitl": true
    }
  },
  "env": [
    "CI"
  ]
}
```

Reading the example:

- `projectRoot` `.` is the workspace root the host binds. Lane paths are
  relative to it.
- `api` may write under `src/api` and `tests/api`. `docs` may write only
  `docs/api.md`. The two lanes do not overlap, so they may run in parallel
  once `api` is done.
- The review of `api` is a second agent. It runs read-only, without network
  and without tools, and may change the work at most twice.
- `env` names one variable the agents may read. The spec carries no value.
- `commit` needs `hitl: true`, and the QA command must be in the rule set's
  allowlist.

## Rule set

The host passes a complete `RunRules` to every call. A rule set states every
limit and allowlist, so a missing rule never means "allowed". The rule set's
`id` names it in the origins of a merged result.

| Rule | Meaning |
| --- | --- |
| `maxBudgetUsd` | Largest `budget.maxUsd` a spec may declare |
| `maxConcurrency` | Largest `maxConcurrency` a spec may declare |
| `maxLanes` | Most lanes a spec may have |
| `maxStringLength` | Longest string outside `extensions`, in UTF-16 code units |
| `maxArrayLength` | Longest array outside `lanes` |
| `maxChangeRounds` | Most change rounds a lane's review may declare |
| `maxAgentRuns` | Most agent runs the whole spec may need in the worst case |
| `allowedProviderIds` | Provider ids an agent or a reviewer may name, compared exactly |
| `allowedModels` | Model ids an agent or a reviewer may name, compared exactly, case included |
| `allowedModelsByRole` | Optional. Narrows `allowedModels` per role (`architect`, `worker`, `integration`, `critic`, `reviewer`): a lane agent may use only the models in both lists, an agent reviewer those of `reviewer`. A role without a list uses `allowedModels`. Any other key is `RUN_SPEC_RULES_INVALID`. A merge narrows each key and never adds a model |
| `allowedPermissionModes` | Permission modes an agent may ask for. Never `full-access` |
| `allowNetwork` | Whether an agent may ask for network access |
| `allowedTools` | Tool names an agent may list, compared exactly |
| `allowedEnvNames` | Environment variable names a spec may list, compared exactly |
| `allowedMcpProviders` | MCP provider ids a lane's agent may list in `agent.mcp`, compared exactly. An empty list allows none |
| `deniedPathPatterns` | File name patterns no path may contain |
| `allowedQaCommands` | QA commands a spec may declare, each as the full argument list |
| `requireQa` | Whether a spec that publishes must declare a QA command |
| `allowedPublishKinds` | Publication kinds a spec may ask for: `none`, `commit`, `integration` |
| `allowedWorkflows` | Workflows a spec may run, each as `{ workflowId, workflowVersion }`, compared exactly. An empty list allows none |
| `allowedTargetRefs` | Git refs an integration may merge into, compared exactly. An empty list allows no integration |

`RunRulesOverride` is a partial rule set. `mergeRunRules(base, ...overrides)`
layers overrides over a base, and each one can only make the result more
restrictive:

- Caps take the smaller value.
- Allowlists keep the entries present in both lists, in the base order.
  `allowedWorkflows` entries are equal when both the id and the version are.
- `deniedPathPatterns` takes the entries of both lists, base first.
- `allowNetwork` is true only when both are true.
- `requireQa` is true when either is true.

The merged rule set has `origins`: for each rule, the ids of the rule sets that
decided its value. The inputs are not modified. `mergeRunRules` throws a
`TypeError` when the base does not match `RunRulesSchema`, an override does not
match `RunRulesOverrideSchema`, or a rule would record more than
`RUN_SPEC_LIMITS.maxRuleOrigins` origins, so it never returns a rule set that
`validateRunSpec` would reject.

`DEFAULT_DENIED_PATH_PATTERNS` lists file name patterns that usually hold
secrets, such as `.env`, `*.pem` and `.git`. It is a starting list for a host's
rule set, and the library does not apply it on its own.

### Model ids and roles

A model id is 1 to 256 characters in all: it starts with a letter or digit and
continues with letters, digits and `.`, `_`, `:`, `+`, `/`, `@`, `-`. It may
end in **one** bracket suffix of letters and digits, such as `opus[1m]` or
`claude-opus-5-5[1m]`; brackets anywhere else, an empty suffix (`opus[]`) and
a second suffix are `RUN_SPEC_INVALID_FORMAT`. The same grammar applies to the
`allowedModels` and `allowedModelsByRole` entries. A missing, empty or blank
`model` of an agent or an agent reviewer is `RUN_SPEC_MODEL_REQUIRED`.

`allowedModelsByRole` is optional. A lane agent may use only the models that
are in `allowedModels` **and** in the list of the lane's role, and an agent
reviewer only those in the `reviewer` list. A role without a list uses
`allowedModels`. In a merge each key narrows, and a role the base lacks takes
the override's list limited to the models still allowed overall.

The checks protect hosts that validate a spec before they build agents.
Nothing in the bridge executes a `RunPlan`; at run time, set
`requireExplicitModel` on the `ExternalAgentWorkflowFactory` and on the
drivers, and give each agent `config.model`.

## Rule table

`validateRunSpec(spec, rules)` checks in this order. Each family is a module of
`src/workflows/spec`.

| Family | Module | Checks |
| --- | --- | --- |
| rule set | `validate.ts` | `rules` is read once into a plain JSON copy (own keys only, each getter called once) and the copy matches `RunRulesSchema`. Otherwise the call returns `RUN_SPEC_RULES_INVALID` and nothing else. The families read the copy, never the host's object |
| shape | `shape.ts` | The input is plain JSON within the input bounds, then the zod schema. Runs right after the rule set check and alone: a spec with a shape issue reaches no family |
| paths | `rules/paths.ts` | Path grammar, root, denied patterns, duplicate and overlapping paths |
| budget | `rules/budget.ts` | Budget, concurrency, lane count, agent runs, change rounds, string and array caps, `extensions`, plan size |
| models | `rules/models.ts` | Workflow, providers, models, permission modes, network, tools, MCP providers and environment names |
| graph | `rules/graph.ts` | Lane ids, dependencies, cycles, then the existing plan validator |
| gates | `rules/gates.ts` | QA ids and commands, QA requirement, publish kind, merge target and human approval |
| full plan | `rules/graph.ts` | Only when every family above accepts the spec: the existing plan validator on the full plan, owned paths included |

The families after shape run only on a spec with a valid shape, and all of
them run, so one call reports each broken rule. A family that throws becomes
`RUN_SPEC_INTERNAL_ERROR`, a defect of the library, and stops the families
after it; `RUN_SPEC_RULES_INVALID` only ever means the host's rule set is
wrong. The list of issues is
cut at 256 entries, and the last entry is `RUN_SPEC_ISSUES_TRUNCATED`.

Validation never repairs a spec. On success the result holds a deep-frozen copy
of the input.

The spec and the rule set are each read once, within the input bounds, and
array lengths are checked before any item is read. Listing the keys of an
object or array still calls a proxy's `ownKeys` trap, and a getter runs
whatever code it holds, so their cost is theirs: a host must not pass proxies
or getters it does not control. Parsed JSON has neither.

`resolveRunPlan` takes the ceilings, the rule set ids and the concurrency of
its cost bound from the same checked copy of the rule set. A getter that would
answer differently, or throw, on a second read is never read a second time:
the spec is checked, and the plan built, from its first answer. Such a rule
set gives neither `RUN_SPEC_RULES_INVALID` nor `RUN_SPEC_INTERNAL_ERROR`; only
a getter that throws on its first (and only) read is `RUN_SPEC_RULES_INVALID`.

## Error codes

Branch on the `code` of each issue, never on its message. Each issue has a
`path` from the root, as object keys and array indexes. Codes are listed in
family order.

### shape

| Code | Reported when |
| --- | --- |
| `RUN_SPEC_RULES_INVALID` | The rule set is not plain JSON (a class instance, a cycle, a key inherited from a prototype instead of an own key, a getter that throws) or does not match `RunRulesSchema`: a host error |
| `RUN_SPEC_INTERNAL_ERROR` | A rule family failed unexpectedly: a library defect. The families after it did not run, and the spec is not accepted |
| `RUN_SPEC_INPUT_NOT_JSON` | The input has a cycle, a class instance, a sparse array, an array whose `length` is not a safe integer or is shorter than its items, a non-finite number, a function, a symbol key or an unreadable property |
| `RUN_SPEC_INPUT_TOO_LARGE` | The input has more values than `RUN_SPEC_INPUT_LIMITS` allows, or a string or key longer than its limit |
| `RUN_SPEC_INPUT_TOO_DEEP` | The input is nested deeper than `RUN_SPEC_INPUT_LIMITS.maxDepth` |
| `RUN_SPEC_VERSION_UNSUPPORTED` | `specVersion` is missing or names a version this library does not support |
| `RUN_SPEC_MISSING_KEY` | A required key is absent |
| `RUN_SPEC_UNKNOWN_KEY` | An object has a key the schema does not define |
| `RUN_SPEC_INVALID_TYPE` | A value has the wrong JSON type, including a number that must be an integer |
| `RUN_SPEC_INVALID_VALUE` | A value is not one of the allowed constants, including a variant's `kind` |
| `RUN_SPEC_INVALID_FORMAT` | A string does not match the pattern of its field, such as an id, a model id, a tool name, an environment variable name, or a merge `targetRef` that is not a valid git ref name |
| `RUN_SPEC_STRING_TOO_SHORT` | A string is empty or shorter than its field allows |
| `RUN_SPEC_STRING_TOO_LONG` | A string is longer than the hard limit of its field |
| `RUN_SPEC_ARRAY_TOO_SHORT` | An array has fewer items than its field requires, such as an empty `lanes` or an empty QA `command` |
| `RUN_SPEC_ARRAY_TOO_LONG` | An array other than `lanes` and `dependsOn` is longer than its hard limit |
| `RUN_SPEC_TOO_MANY_LANES` | `lanes` has more items than `RUN_SPEC_LIMITS.maxLanes` |
| `RUN_SPEC_TOO_MANY_DEPENDENCIES` | A lane's `dependsOn` has more items than `RUN_SPEC_LIMITS.maxDependsOn` |
| `RUN_SPEC_NUMBER_OUT_OF_RANGE` | A number is outside the range of its field, such as a budget of zero |
| `RUN_SPEC_EXTENSION_KEY_INVALID` | A key of `extensions` is not of the form `x-<vendor>` |
| `RUN_SPEC_ISSUES_TRUNCATED` | More issues were found than `RUN_SPEC_MAX_ISSUES`; this is the last entry |

### paths

| Code | Reported when |
| --- | --- |
| `RUN_SPEC_PATH_ABSOLUTE` | A path starts with `/` or with a drive prefix such as `C:` |
| `RUN_SPEC_PATH_TRAVERSAL` | A path has a `..` segment, or a segment a host could read as `..` (see the path rules) |
| `RUN_SPEC_PATH_BACKSLASH` | A path contains a backslash |
| `RUN_SPEC_PATH_NOT_CANONICAL` | A path has an empty segment, a `.` segment or a trailing slash |
| `RUN_SPEC_PATH_ROOT_NOT_ALLOWED` | A lane's allowed path names the project root itself |
| `RUN_SPEC_PATH_INVALID` | A path is blank, contains a NUL character, a control, format or other invisible character (such as a newline, a bidi override, a zero-width mark or a byte order mark) or a lone surrogate, has more than `RUN_SPEC_LIMITS.maxPathSegments` (64) segments, is too long once joined to `projectRoot`, or fails the portable path grammar for another reason |
| `RUN_SPEC_PATH_DENIED` | A segment of a path, or of `projectRoot`, matches a denied pattern, after invisible characters, an alternate data stream suffix and trailing dots and spaces are dropped; a segment is shaped like a Windows 8.3 short name such as `GIT~1`; or the path could not be matched within the glob matching budget |
| `RUN_SPEC_PATH_DUPLICATE` | Two allowed paths of one lane are equal, or one contains the other |
| `RUN_SPEC_PATH_OVERLAP` | Allowed paths of two lanes are equal, or one contains the other |

### budget

| Code | Reported when |
| --- | --- |
| `RUN_SPEC_BUDGET_EXCEEDED` | `budget.maxUsd` is above the rule set's `maxBudgetUsd` |
| `RUN_SPEC_CONCURRENCY_EXCEEDED` | `maxConcurrency` is above the rule set's `maxConcurrency` |
| `RUN_SPEC_LANE_LIMIT_EXCEEDED` | The spec has more lanes than the rule set's `maxLanes` |
| `RUN_SPEC_STRING_LIMIT_EXCEEDED` | A string outside `extensions` is longer than the rule set's `maxStringLength` |
| `RUN_SPEC_ARRAY_LIMIT_EXCEEDED` | An array other than `lanes` is longer than the rule set's `maxArrayLength` |
| `RUN_SPEC_CHANGE_ROUNDS_EXCEEDED` | A lane's review declares more change rounds than the rule set's `maxChangeRounds` |
| `RUN_SPEC_AGENT_RUN_LIMIT_EXCEEDED` | The worst-case agent runs, summed over the lanes, are above the rule set's `maxAgentRuns` |
| `RUN_SPEC_EXTENSION_TOO_LARGE` | `extensions` has too many keys, or a value is not plain JSON or is beyond `RUN_SPEC_EXTENSION_LIMITS` |
| `RUN_SPEC_PLAN_TOO_LARGE` | The workflow plan the spec maps to is beyond the size limits of the plan store, or the lanes own more than `RUN_SPEC_LIMITS.maxTotalAllowedPaths` (1,024) paths in total, which bounds the plan validator's pairwise ownership check |

### models

| Code | Reported when |
| --- | --- |
| `RUN_SPEC_WORKFLOW_NOT_ALLOWED` | `workflowId` and `workflowVersion` are not an entry of `allowedWorkflows`; reported at `workflowVersion` when the id is listed in another version |
| `RUN_SPEC_PROVIDER_NOT_ALLOWED` | An agent or a reviewer names a provider outside `allowedProviderIds` |
| `RUN_SPEC_MODEL_NOT_ALLOWED` | An agent or a reviewer names a model outside `allowedModels`, or outside the `allowedModelsByRole` list of its role |
| `RUN_SPEC_MODEL_REQUIRED` | An agent's or an agent reviewer's `model` is missing, empty or only whitespace (the generic shape codes do not apply to these two paths) |
| `RUN_SPEC_PERMISSION_MODE_NOT_ALLOWED` | An agent asks for a mode outside `allowedPermissionModes`. `full-access` is always outside |
| `RUN_SPEC_NETWORK_NOT_ALLOWED` | An agent sets `allowNetwork` to true and the rule set's `allowNetwork` is false |
| `RUN_SPEC_TOOL_NOT_ALLOWED` | An agent lists a tool outside `allowedTools` |
| `RUN_SPEC_TOOL_DUPLICATE` | An agent lists the same tool twice |
| `RUN_SPEC_MCP_PROVIDER_NOT_ALLOWED` | An agent lists an MCP provider id outside `allowedMcpProviders` |
| `RUN_SPEC_MCP_PROVIDER_DUPLICATE` | An agent lists the same MCP provider id twice, or two ids that differ only in case |
| `RUN_SPEC_MCP_TOOL_NOT_GRANTED` | An agent lists a tool that reaches an MCP server for a provider outside its own `mcp`: a name with the prefix `mcp__` in any case other than `mcp__<id>` or `mcp__<id>__<tool>` with `<id>` in its `mcp` exactly, or `ListMcpResourcesTool` / `ReadMcpResourceTool` (any case) with an empty `mcp` |
| `RUN_SPEC_ENV_NAME_NOT_ALLOWED` | `env` lists a name outside `allowedEnvNames` |
| `RUN_SPEC_ENV_NAME_DUPLICATE` | `env` lists the same name twice |

### graph

| Code | Reported when |
| --- | --- |
| `RUN_SPEC_LANE_ID_DUPLICATE` | Two lanes have the same `taskId`, or ids that differ only in case (`api` and `API`) |
| `RUN_SPEC_DEPENDENCY_UNKNOWN` | A lane's `dependsOn` names a task id that no lane has |
| `RUN_SPEC_DEPENDENCY_SELF` | A lane's `dependsOn` names the lane itself |
| `RUN_SPEC_DEPENDENCY_DUPLICATE` | A lane's `dependsOn` names the same lane twice |
| `RUN_SPEC_DEPENDENCY_CYCLE` | A lane is on a dependency cycle or waits for one |
| `RUN_SPEC_PLAN_REJECTED` | The existing workflow plan validator rejects the plan for a reason no other code names: the plan without paths after the graph rules, or the full plan after every family |

### gates

| Code | Reported when |
| --- | --- |
| `RUN_SPEC_QA_ID_DUPLICATE` | Two QA commands have the same `id` |
| `RUN_SPEC_QA_COMMAND_NOT_ALLOWED` | A QA command is not an entry of `allowedQaCommands` |
| `RUN_SPEC_QA_REQUIRED` | The spec publishes, `requireQa` is true and `gates.qa` is empty |
| `RUN_SPEC_PUBLISH_KIND_NOT_ALLOWED` | `gates.publish.kind` is outside `allowedPublishKinds` |
| `RUN_SPEC_TARGET_REF_NOT_ALLOWED` | An integration's `targetRef` is not in `allowedTargetRefs` |
| `RUN_SPEC_HITL_REQUIRED` | The spec commits or merges and `gates.publish.hitl` is not true |

The codes are exported as `RUN_SPEC_ISSUE_CODES`, with their families in
`RUN_SPEC_ISSUE_FAMILIES`. `RUN_SPEC_SCHEMA_ISSUE_CODES` lists the shape codes
that the JSON Schema agrees with.

## Path semantics

- Paths are strings with forward slashes, relative to a base. `projectRoot` is
  relative to the workspace root the host binds. A lane path is relative to
  `projectRoot`.
- Canonical form is required. A path with an empty segment, a `.` segment or a
  trailing slash is reported, not rewritten. Absolute paths, drive prefixes,
  `..` segments and backslashes are reported.
- A segment that a host could read as `..` is a traversal too: `..` followed
  by dots or spaces (Windows strips them, so `.. ` opens `..`), and `..`
  spelled with percent escapes (`%2e%2e`), compatibility characters such as
  fullwidth full stops (NFKC), ideographic full stops, or slash look-alikes
  such as the fullwidth or division slash as the separator. The path is not
  rewritten; it is only checked in those readings.
- `projectRoot` may be `.`. An allowed path may not be the root itself. Each
  allowed path covers its entry and everything below it.
- The joined path is `projectRoot/path`, or the path alone when `projectRoot`
  is `.`. `runSpecWorkspacePath` builds it, and the plan maps it to a
  `subtree` claim.
- A path is at most `RUN_SPEC_LIMITS.maxPathLength` Unicode code points in the
  shape check, the unit JSON Schema `maxLength` counts, and at most the same
  number of UTF-16 code units in the paths rules, the portable path limit.
  Lane titles and QA arguments are counted in code points too.
- A path has at most `RUN_SPEC_LIMITS.maxPathSegments` (64) segments; a deeper
  path is `RUN_SPEC_PATH_INVALID`.
- Matching against glob patterns (those with `*`) is bounded per call. Each
  name tried against a glob pattern costs one unit; a segment with trailing
  dots or spaces is tried twice, as written and without them. When the
  pattern's longest literal part is in the name, the full match costs one
  more unit per pattern part. A segment name already matched is not tried
  again while the memo (4,096 names) has room. The budget is 1,024 paths x 64
  segments x 1,024 patterns units: enough for one try of every segment of a
  spec at the plan limits against every pattern. Trailing dots or spaces and
  full matches spend more, so a spec at the limits whose segments contain the
  patterns' literals can run out. A path reached after the budget is spent is
  `RUN_SPEC_PATH_DENIED`, reported once; it is never accepted unchecked.
  Exact patterns are a set lookup.
- A segment shaped like a Windows 8.3 short name, such as `GIT~1`, `PROGRA~2`
  or `ENV~1.TXT` (one to six characters, `~`, digits, an optional extension of
  up to three characters, eight characters before the extension at most), is
  `RUN_SPEC_PATH_DENIED` whatever the denied patterns are. NTFS can open it as
  an alias of a longer name, such as `.git`, and which one depends on the
  volume, so the validator cannot tell what it names.
- Denied patterns match segment by segment. Comparison folds case and Unicode
  composition. `*` stands for any run of characters inside one segment. The
  text after the first `:` is dropped, and trailing dots and spaces are
  ignored, so an alternate data stream or `.env.` does not evade `.env`. Each
  path is also matched in the widened reading of the traversal check (NFKC,
  ideographic full stops, percent-encoded dots and separators), so
  `src/．git`, `src/。env` and `src/%2eenv` are denied like `src/.git` and
  `src/.env`.
- Denied patterns are checked against the paths a spec names, not against the
  files below them. An allowed path `packages` passes even though
  `packages/app/.env` matches `.env`. The plan carries the effective patterns
  in `deniedPathPatterns`, and the host enforces them on every write (see
  [What the host must do at run time](#what-the-host-must-do-at-run-time)).
- Overlap is checked among all allowed paths of all lanes, ignoring case and
  Unicode composition. Each segment is also compared as Windows opens it:
  the text from the first `:` and trailing dots and spaces are ignored, so
  `src/api.` and `src/api::$DATA` overlap `src/api`. A segment that would
  become empty is compared as written. Equal or nested paths overlap. Within one lane the code is
  `RUN_SPEC_PATH_DUPLICATE`; across lanes it is `RUN_SPEC_PATH_OVERLAP`.
- The library never resolves a path against the file system. A symbolic link
  inside an allowed path can point outside it, so the host must resolve links
  before it enforces the path.

## Plan

`resolveRunPlan(spec, rules)` validates the spec with `validateRunSpec`. When
the spec is invalid it returns the same issues. Otherwise it returns a `RunPlan`
without running anything:

- `lanes`: in dependency order, by wave and then spec order. Each lane has its
  `waveId`, `waveIndex`, its agents and its `maxAgentRuns`.
- `waves`: the waves from `layerRunSpecLanes`, named `wave-1`, `wave-2` and so
  on.
- Agents of a lane, in order of first run: `tests` when `testsFirst` is set,
  then `implement`, then `review` when the lane is reviewed. `implement` and
  `review` each allow `1 + maxChangeRounds` runs. A reviewer always runs
  `read-only`, without network, without tools and without MCP providers.
- Each agent's `mcp` is the lane's MCP grant: the provider ids of
  `agent.mcp`, or an empty list. It is the only place the plan names MCP;
  see [MCP providers](#mcp-providers).
- `limits`: each effective limit with its `value`, its `ceiling`, the rule that
  sets it and the rule sets behind it. A spec above a ceiling is rejected, not
  reduced.
- `costBound`: `maxUsd` is the budget of the spec. `maxAgentRuns` is the sum of
  the lanes' worst cases. `peakConcurrency` is the smallest of the spec's
  `maxConcurrency`, the rule set's `maxConcurrency` and the widest wave.
- `startInput`: `inline` when the spec fits the size limits of an execution
  input, otherwise `reference`. See [Mapping](#mapping).
- `deniedPathPatterns`: the effective denied path patterns, from the rule set
  copy that was validated. The host enforces them on writes
  (`run-spec.denied-paths`).
- `topology`: the plan fields the spec determines.

`layerRunSpecLanes(lanes)` groups lanes into waves with Kahn's algorithm. A
lane sits one wave after the latest of its dependencies. It never throws: lanes
it cannot place (cycles, unknown dependencies, repeated ids) are listed in
`unresolved`.

`runSpecHash(spec)` returns the `sha256:` digest of the canonical JSON of a
validated spec. Key order does not change it. It is asynchronous, so the plan
does not carry it; call it on the validated spec. Writing an explicit
`allowNetwork: false` and leaving it out give the same hash.

## Mapping

### To a control-plane start request

The start request is the existing `execution.start` operation. Its payload is a
`WorkflowExecutionRequest`:

| Field | Value |
| --- | --- |
| `executionId` | Chosen by the host. The spec has no execution id |
| `workflowId` | `spec.workflowId` |
| `workflowVersion` | `spec.workflowVersion` |
| `input` | The validated spec, when `startInput` is `inline` |
| `metadata` | Host metadata. The spec carries none |

When `startInput` is `reference`, the spec is too large for an execution input.
The execution store accepts at most 10,000 JSON values per input, and
`immutableJson` rejects the spec. The host then stores the spec under its
`runSpecHash` and sends the hash instead of the spec. This library does not
define the layout of that reference.

### To a workflow plan

The plan is written with the existing `plan.put` operation, whose payload is a
`WorkflowPlan`. Build it from the plan topology:

1. Call `runSpecWorkflowPlan(plan.topology, binding)`. The binding holds the
   host's `executionId`, `baseRevision`, `objective` and `createdAt`, and
   optionally `planRevision` (default 1) and `status` (default `ready`).
2. Check the result with `validateWorkflowPlan`, the existing validator, before
   it is written.

`RUN_SPEC_DRY_RUN_BINDING` supplies placeholder values for a dry run. The
plan the host writes uses the host's values.

The topology maps each part of the spec as follows:

- `agents`: one plan agent per role the lanes use, with the role as `agentId`,
  no permission and no delegation.
- `lanes`: one plan lane per spec lane, with the same `taskId`, `role` and
  `dependsOn`. `agentId` is the role. Each allowed path, joined to
  `projectRoot`, is an owned path with scope `subtree`. `mayCreateUnder` and
  `acceptance` are empty.
- `waves`: from `layerRunSpecLanes`.
- `invariants`: `run-spec.budget`, `run-spec.denied-paths` and
  `run-spec.mcp-providers` always, and `run-spec.human-approval` when the spec
  publishes. All are enforced by the host.
- `reservedPaths`: empty.

Provider, model, permission mode, tools, MCP providers, steps, gates and
budget have no place in a plan. They reach the workflow through the start request.

## MCP providers

A lane's agent may list MCP providers by id in `agent.mcp`. An id is a name
the host has configured, never a location or a secret:

- The grammar is ASCII letters and digits in runs joined by one `-` or `_`,
  at most 64 characters (`github`, `docs-search`, `reui`). A URL, a host and
  port, a path, an `@`, a `%` escape, whitespace, a control or invisible
  character, a non-ASCII look-alike and `__` are all
  `RUN_SPEC_INVALID_FORMAT`. `__` is refused because Claude Code names an MCP
  tool `mcp__<server>__<tool>`, so an id with `__` could name another
  provider's tools.
- At most `RUN_SPEC_LIMITS.maxMcpProviders` (16) ids per agent, unique
  ignoring case (`RUN_SPEC_MCP_PROVIDER_DUPLICATE`), like lane ids.
- Deny by default: each id must be in the rule set's `allowedMcpProviders`,
  compared exactly. A rule set that lists none allows none, and
  `mergeRunRules` keeps only the ids every rule set allows.
- The agent object is closed: a spec cannot carry a server URL, a command, a
  header or a token anywhere (`RUN_SPEC_UNKNOWN_KEY`, or a format code).
- MCP access is granted only through `mcp`. A tool name in `tools` that
  reaches an MCP server is valid only for a provider in the same agent's
  `mcp`: `mcp__<id>` (every tool of the provider) or `mcp__<id>__<tool>`,
  with `<id>` compared exactly. Any other name whose prefix is `mcp__` in any
  case (`MCP__x__t`, `mcp__x__`, `mcp____t`, another provider) is
  `RUN_SPEC_MCP_TOOL_NOT_GRANTED`, and so are the Claude Code resource tools
  `ListMcpResourcesTool` and `ReadMcpResourceTool` when `mcp` is empty. The
  tool must still be in `allowedTools`, so a host can narrow a granted
  provider to some of its tools.
- A reviewer never gets an MCP provider.
- `agent.mcp: []` and no `agent.mcp` mean the same thing and hash the same.

The plan lists the grant on each agent (`RunPlanAgent.mcp`). The host turns it
into servers (see [host duty 14](#what-the-host-must-do-at-run-time)) with
`selectMcpServers(planAgent.mcp, registry)`, which returns exactly the
granted entries of the host's registry and throws
`EXTERNAL_AGENT_MCP_PROVIDER_UNKNOWN` for an id with no entry. Pass the
result as the Claude Agent SDK driver's `mcpServers`:

```ts
driver: { mcpServers: selectMcpServers(planAgent.mcp, hostMcpServers) }
```

An isolated `ClaudeAgent` loads no MCP server but the bridge's own and the
declared ones; the confirmation guard denies every other MCP tool without
`allowNetwork: true`. The driver checks each declared server and keeps its
secrets out of the agent; see
[Host MCP servers and secrets](external-agent-isolation.md#host-mcp-servers-and-secrets).
Other drivers have no `mcpServers` in this release: a host should refuse a
lane on them whose `mcp` is not empty.

## JSON Schema

`runSpecJsonSchema` is the JSON Schema (draft 2020-12) of the input side of
`RunSpecSchema`. zod generates it, so the schema and the validator cannot drift
apart on shape.

The schema carries the shape rules only: types, required keys, closed objects,
grammars and bounds. Rules that compare fields with each other or with the
host's rules are not in it, and `validateRunSpec` checks them. For any JSON
document that does not trip the input guard, the schema rejects the document
exactly when the validator reports a code in `RUN_SPEC_SCHEMA_ISSUE_CODES`.
String lengths count Unicode code points on both sides, so an emoji is one
character for the schema and for the validator, whatever zod 4 release is
installed.

The parity is tested: the repository has no JSON Schema validator dependency,
so the tests evaluate the generated schema with a small evaluator of the
keywords it uses, on every corpus case and several hundred generated
documents, and compare the result with the shape parser. A host that
validates with JSON Schema must still run `validateRunSpec` for the rules.

## What the host must do at run time

The library is pure. It decides what a spec may ask for. The host enforces it.

1. **Bind the workspace.** Resolve `projectRoot` inside the workspace, resolve
   symbolic links, and reject any write outside the lane's `subtree` claims.
2. **Enforce the budget.** Stop starting agent runs when the metered cost
   reaches `budget.maxUsd`. The library does not price models, so the bound
   holds only as far as the host meters cost. Runs already started when the
   budget is reached can overshoot it.
3. **Enforce concurrency.** Run at most `maxConcurrency` lanes at once.
4. **Apply each agent's settings.** Use exactly the provider, model, permission
   mode, network access and tools of the spec, and no others. A reviewer runs
   read-only, without network and without tools. `full-access` is never
   granted.
5. **Supply environment values.** `env` names variables. The host passes the
   values of the listed names from its own configuration. The spec holds no
   value, and the library reads no environment.
6. **Run the QA commands.** Run each command as an argument list, in the
   project root, without a shell. Publication waits until every command
   succeeds.
7. **Ask a person.** Before each commit, and before each merge into
   `targetRef`, a person approves (`run-spec.human-approval`).
   `allowedTargetRefs` limits where a merge may go; the person still decides
   whether it happens. Run exactly the workflow and version the spec names,
   which `allowedWorkflows` has allowed, and never resolve a name to another
   version.
8. **Complete the plan.** Supply the execution id, base revision, objective
   and creation time. Write the plan only after `validateWorkflowPlan` accepts
   it.
9. **Store large specs.** When `startInput` is `reference`, store the spec under
   its `runSpecHash` and resolve the hash at start.
10. **Resolve names on the real file system.** The validator rejects 8.3 short
    names and case-only differences it can see, but only the host's file
    system knows what a name opens. Disable 8.3 name creation on Windows
    volumes that hold workspaces, or resolve every path to its long, real form
    before it enforces a claim.
11. **Treat lane ids as case-insensitive names.** A lane id becomes branch,
    worktree or file names. The validator rejects ids that differ only in
    case, so a host may fold case when it derives names; it must not derive a
    name that two different ids can map to in another way.
12. **Keep QA ids apart without folding case.** QA ids are compared exactly:
    `Test` and `test` are two commands (`RUN_SPEC_QA_ID_DUPLICATE` covers
    equal ids only). A host that derives log or file names from QA ids must
    not fold case, or must add something that keeps two such ids apart, such
    as the command's index.
13. **Enforce the denied paths on writes.** A `subtree` claim covers every
    file below an allowed path, and the validator checks only the paths the
    spec names. Reject every write, and every read you gate, whose path has a
    segment that matches one of the plan's `deniedPathPatterns` or is shaped
    like a Windows short name (`run-spec.denied-paths`). Use the same fold as
    the validator: control, format and invisible characters dropped (HFS+
    ignores them, so `.g\u200cit` opens `.git`), case, NFC, the text from the
    first `:` dropped, trailing dots and spaces ignored, and the widened
    reading of [Path semantics](#path-semantics).
14. **Resolve MCP provider ids in the host.** For each agent of the plan,
    attach exactly the MCP servers its `mcp` list names, resolved from the
    host's own configuration, and no other; an empty list means no MCP server
    (`run-spec.mcp-providers`). The host owns the server address and every
    credential: never accept a URL, header, command or token from a spec,
    and never pass a credential to the agent, its environment, its arguments
    or its prompt. Keep the credential in a process the agent cannot read,
    such as a proxy on a loopback address that adds the header itself.
    Expose to an agent only the tools of its granted providers, whatever
    other MCP servers the host runs.

## Exports

Everything `adk-llm-bridge/workflows/spec` exports. Each export has TSDoc and
is `@experimental`.

- Functions: `validateRunSpec`, `resolveRunPlan`, `mergeRunRules`,
  `layerRunSpecLanes`, `runSpecHash`, `runSpecJsonSchema`,
  `runSpecWorkflowPlan`, `runSpecWorkspacePath`, `runSpecIssueFamily`.
- Constants: `DEFAULT_DENIED_PATH_PATTERNS`, `RUN_RULE_KEYS`,
  `RUN_SPEC_DRY_RUN_BINDING`, `RUN_SPEC_EXTENSION_LIMITS`,
  `RUN_SPEC_INPUT_LIMITS`, `RUN_SPEC_LIMITS`, `RUN_SPEC_ISSUE_CODES`,
  `RUN_SPEC_ISSUE_FAMILIES`, `RUN_SPEC_ISSUE_FAMILY_NAMES`,
  `RUN_SPEC_MAX_ISSUES`, `RUN_SPEC_MAX_ISSUE_MESSAGE_LENGTH`,
  `RUN_SPEC_SCHEMA_ISSUE_CODES`.
- Schemas (zod): `RunSpecSchema`, `RunSpecV1Schema`, `RunRulesSchema`,
  `RunRulesOverrideSchema`, `RunSpecIssueSchema`, and the component schemas
  `RunSpecAgentSchema`, `RunSpecBudgetSchema`, `RunSpecExtensionsSchema`,
  `RunSpecGatesSchema`, `RunSpecLaneSchema`, `RunSpecPermissionModeSchema`,
  `RunSpecPublishSchema`, `RunSpecQaCommandSchema`, `RunSpecReviewSchema`,
  `RunSpecRoleSchema`, `RunSpecStepsPolicySchema`.
- Types: `RunSpec`, `RunSpecV1`, `RunSpecInput`, `RunSpecAgent`,
  `RunSpecBudget`, `RunSpecExtensions`, `RunSpecGates`, `RunSpecLane`,
  `RunSpecPermissionMode`, `RunSpecPublish`, `RunSpecQaCommand`,
  `RunSpecReview`, `RunSpecRole`, `RunSpecStepsPolicy`, `RunRules`,
  `RunRulesOverride`, `RunRuleKey`, `RunSpecLayering`, `RunSpecTopology`,
  `RunSpecPlanBinding`, `RunSpecIssue`, `RunSpecIssueCode`,
  `RunSpecIssueFamily`, `RunSpecIssuePath`, `RunSpecValidationResult`,
  `RunPlan`, `RunPlanAgent`, `RunPlanAgentPurpose`, `RunPlanCostBound`,
  `RunPlanLane`, `RunPlanLimit`, `RunPlanLimits`, `RunPlanResult`,
  `RunPlanStartInput`, `RunPlanWave`.

## Next

These are planned work. None of them exists in this release.

### Generic lanes workflow factory

A factory that takes a validated spec and returns a registered workflow version
which runs the spec's lanes, their agents, the gates and the publication. It
would consume `validateRunSpec` and `resolveRunPlan`.

### Server routes

A server exposes HTTP routes that accept a run spec, validate it with the
host's rule set, and start the execution through `execution.start`.

### Worker

A worker that runs the lanes of a started execution, applies the host
obligations above, and records each agent run.

### CLI

A command that validates a spec file against a rule set file, prints the
issues or the plan, and prints the JSON Schema.

### MCP

An MCP tool that validates and plans a spec, for agents that author specs.
