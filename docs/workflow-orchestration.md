# Multi-agent workflow orchestration

The orchestration core turns a dynamic group of ADK, Codex, Claude Code, or
remote workers into a versioned and fenced workflow. Agents are first-class
tasks, but authority stays in host-owned ports; JSON is data, never a
capability.

To accept a lanes job as data, validate it against host rules and turn it into
a workflow plan, see [Workflow run spec](workflow-run-spec.md) (experimental,
needs zod >= 4).

```text
versioned plan + active revision
              |
      ownership CAS ledger
              |
 authenticated task authority --- durable claims/commands/mailbox
              |                              |
       ADK driver + binder             fair recovery sweep
              |
 worktree -> inspect -> accepted receipt -> exact tree commit -> integration
                         |                       |
                   live reservation       mutation journal
```

## Host assembly

Use `adk-llm-bridge/workflows` for the transport-neutral core and
`adk-llm-bridge/workflows/node` for `NodeGitWorktreeChangeDriver`.

1. Store and activate an immutable `WorkflowPlan` with
   `WorkflowPlanController`. Bootstrap authorization is an explicit trust
   decision; a candidate plan cannot authorize itself.
2. Claim each lane through `WorkflowOwnershipController`. Overlapping paths
   race through one CAS ledger and fencing tokens only move forward.
3. Construct `WorkflowOrchestrationTaskAuthorityPort`, durable task/message/
   command stores, `WorkflowTaskController`, and `WorkflowTaskDispatcher`.
   Root and child bindings are derived from the active plan.
4. Connect real ADK agents with `AgentInvocationGateway` and
   `AdkWorkflowTaskDriver`. A binder exposes bounded spawn, mailbox, join, and
   cancel tools. It can be an MCP adapter for Codex or Claude Code. Workflow
   tasks receive isolated state and history, not parent secrets.
5. Inspect a worktree, validate it with
   `WorkflowOwnershipChangeSetValidator`, persist the receipt, then publish
   only through `WorkflowValidatedCommitter`,
   `WorkflowLiveChangeReceiptAuthority`, and `WorkflowValidatedIntegrator`.

The control plane is deny-by-default. An MCP/RPC transport authenticates the
connection, creates a host-only `WorkflowActorContext`, and passes it in
dispatch options. Never serialize that actor or enable `trustedHostMode` on an
agent-facing endpoint. See the
[control-plane guide](./workflow-control-plane.md#authorization).

## Dynamic agents and plan revisions

An agent may create children only for lanes declared by the active plan, with
an allowed role, declared delegation edge, live ownership, and remaining
`maxChildren` lifetime capacity. The operation is idempotent and claim-fenced.
To introduce an unknown lane, a manager first publishes and activates an
authorized plan revision, then grants ownership. Agents cannot invent
authority by sending new JSON.

`waves` and `dependsOn` version topology and delegation. They are not by
themselves a general DAG scheduler. The host decides when to dispatch root
lanes; dynamic child execution follows its declared delegation edge. A host
that requires strict "dependency must be terminal" semantics must add that
policy to its dispatcher.

## Models of external agents

`ExternalAgentWorkflowFactory` accepts `config.model` and forwards it to the
provider's driver as the `model` option. The descriptor records it as `model`.
The revision leaves out the top-level `config.model` (a `model` key nested
elsewhere in the config is still part of it), so changing the model does not
change the revision: it is reported by the replay model check, see
[Model and input changes on replayed steps](workflow-durability.md#model-and-input-changes-on-replayed-steps).
The
factory checks that the driver keeps exactly that id and registers nothing
otherwise (`WORKFLOW_AGENT_MODEL_NOT_APPLIED`); a custom definition that turns
an alias into a full id must be given the id the driver keeps.

With `config.model`, the definition's `createDriver` receives `{ model }` (and
`requireExplicitModel` when the factory has it), where it received no options
before. A custom definition must **merge** these into its own defaults, not use
them instead: `createDriver: (o) => new MyDriver({ ...hardening, ...o })`, not
`new MyDriver(o ?? hardening)`. The second form silently drops `hardening` as
soon as a request sets a model, and the factory cannot detect that, because the
model is kept. The built-in definitions pass the options straight to the
driver and are not affected.

With `requireExplicitModel: true` on the factory, a request without
`config.model` fails with `WORKFLOW_AGENT_MODEL_REQUIRED` before the driver is
created. For the built-in ids `claude` and `gemini-cli` the factory also
refuses router and default aliases itself (`default`, `best`, `opusplan`;
`auto`, `auto-*`), whatever the definition forwards. For a custom provider id
it cannot know the aliases: it relies on the driver refusing them and on the
driver reporting a `model`. Pair it with full model ids and with the run spec's
`allowedModels` and `allowedModelsByRole`.

### Which models a step ran

`step_started.requestedModel` names the model the step's agent was configured
with, read before it runs: an external agent's driver `model`, an `LlmAgent`'s
string or model instance, or the id an `LlmAgent` inherits from an ancestor
`LlmAgent`. It is absent when the agent names none or its model cannot be read.

`step_completed` carries `result.models` for every step whose agent names or
reports a model:

- `requested`: the ids the agents in the step were configured with;
- `resolved`: the ids a trusted runtime reported (an external agent's
  `externalAgentModel.resolved`, and the `modelVersion` of LLM responses);
- `unknown`: `true` when some run in the step was not fully explicit and
  reported: an external run with no requested model, with a status other than
  `reported`, or with no model information; or an `LlmAgent` whose model is
  inherited or cannot be read. A Codex or Gemini step is always `unknown`.

Each id appears once, in the order first seen, nested workflow agents
included. Agents nested inside the step's own agent (the children of an ADK
`SequentialAgent` or `ParallelAgent`, an `LlmAgent`'s sub-agents) are read from
the authors of the step's events: their requested ids are listed, an inherited
model makes the step `unknown`, and so does an external child with no model
info or an author the step's agent tree does not contain. An agent that runs but
yields no event at all stays invisible. A replayed step returns the stored value. `models` is a record of
what the runtimes said, not a guarantee: an alias remap or a mid-run fallback
can still change what ran (see the external-agent isolation guide).

### When a replayed step's model changed

A step records the model its agent requested when its latest attempt started
(`model.requested` in the checkpoint). When a later turn replays that step,
replays its recorded failure or resumes it, and the agent now requests another
model, the runtime emits `step_model_changed` before the step's
`step_replayed` (or its replayed `step_failed`) and logs
`WORKFLOW_STEP_MODEL_CHANGED`:

| Field | Meaning |
| --- | --- |
| `stepId` | The step. |
| `savedRequestedModel` | Model the agent requested when the step ran; absent when it named none. |
| `savedRecorded` | `true`: a step without a model record is not compared and has no event. |
| `savedResolvedModels` | `result.models.resolved` of the saved result, when stored. |
| `requestedModel` | Model the agent requests now; absent when it names none or it cannot be read. |
| `action` | `replayed`, `replayed-failure` or `resumed`. |

The saved result is still used: the model is not part of a step's identity.
A step that runs again (a retried failure) uses the current model and emits
nothing. The same moment adds a `step_model_changed` event to the active
telemetry span, with the step id, the action and the two model ids and no
content.

## Parallel steps and agent instances

`ctx.parallel(...)` runs steps concurrently up to `maxConcurrency`, but one
agent instance runs one step at a time: the runtime holds a per-agent lock
(`AsyncSemaphore(1)`) because ADK agents are not re-entrant. Parallel steps
whose `agentName` resolves to the same sub-agent therefore run one after the
other. Such a `ctx.parallel(...)` call logs a warning through ADK's logger,
once per run and shared sub-agent:
`[adk-llm-bridge] [WORKFLOW_PARALLEL_STEPS_SHARE_AGENT] ...` names the
workflow, the sub-agent and up to five step ids. A call with `concurrency: 1`
does not warn. For fan-out, declare one sub-agent per concurrent branch, each
with its own name:

```typescript
import { LlmAgent } from "@google/adk";
import { AIGateway } from "adk-llm-bridge";
import { WorkflowAgent, defineWorkflow } from "adk-llm-bridge/workflows";

const model = AIGateway("anthropic/claude-sonnet-5.5");
const instruction = "Review the change and report problems in your area.";

const reviewers = ["api", "ui", "db"].map(
  (area) => new LlmAgent({ name: `Reviewer-${area}`, model, instruction }),
);

const workflow = new WorkflowAgent({
  name: "review",
  subAgents: reviewers,
  definition: defineWorkflow({
    id: "review",
    version: "1",
    handler: async (ctx) => {
      const outcomes = await ctx.parallel(
        reviewers.map((agent) => ({
          id: `review-${agent.name}`,
          agentName: agent.name,
          input: ctx.input,
        })),
      );
      return outcomes
        .map((outcome) => (outcome.status === "completed" ? outcome.output : ""))
        .join("\n");
    },
  }),
});
```

## Recovery guarantees

- Task claims, operation IDs, plan/grant fences, and terminal writes prevent a
  recovered worker from accepting stale success.
- Publication reservations can be reattached after restart. A completed commit
  fences ownership until integration or explicit abandonment.
- Git mode, content, tree, parent, receipt, target, and expected ref are linked.
  Ambiguous mutations are reconciled through the journal.
- Bundled in-memory stores are bounded single-process references. Production
  recovery requires durable, linearizable adapters and a persistent journal.

### Git worktree driver environment

`NodeGitWorktreeChangeDriver` runs `git` with a cleaned environment, so a
host that runs it from a Git hook, a CI wrapper or a shell with Git variables
set still operates on its own repository:

- Removed from the inherited environment: `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_COMMON_DIR`, `GIT_PREFIX`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`,
  `GIT_CEILING_DIRECTORIES`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`,
  `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`, `GIT_GLOB_PATHSPECS`,
  `GIT_NOGLOB_PATHSPECS`, `GIT_ICASE_PATHSPECS`, `GIT_QUARANTINE_PATH`,
  `GIT_REPLACE_REF_BASE`, `GIT_NO_REPLACE_OBJECTS`, `GIT_GRAFT_FILE` and
  `GIT_SHALLOW_FILE`.
- Always set: `GIT_LITERAL_PATHSPECS=1` (paths are never pathspec magic or
  globs), `GIT_NO_REPLACE_OBJECTS=1` (replace refs never change trees or
  parents), `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`.

Other variables (for example `HOME` and `GIT_CONFIG_GLOBAL`) pass through, so
repository and user configuration apply to inspection and commit alike. With
`core.fileMode` set to `false`, the execute bit in the worktree is ignored as
Git ignores it: a changed file keeps its base mode, and a new file is
`100644`.

### Repository lock directories

Commits and integrations of one repository are serialized by a lock under
`<git common dir>/adk-workflow-locks` (for example `.git/adk-workflow-locks`).
Each release, and each recovery of a dead owner's lock, leaves one small
`.repository-<hash>.lock.retired.<hash>` directory there, so the directory
grows by one entry per commit or integration. The driver never deletes them,
because a late recovery must not remove a newer holder's lock. Delete them only
while no process uses the driver on that repository.

A lock is taken over only when its owner file is readable and names a dead
process. A lock whose owner cannot be read is never taken over: waiters time
out with `GIT_MUTATION_AMBIGUOUS`.

## Script sandbox stack

A script workflow runs in QuickJS inside a WebAssembly module, on the host's
own stack. `stackBytes` (in `WorkflowExecutionLimits`) bounds the guest's
stack. Its default and its maximum, `QUICKJS_MAX_STACK_BYTES`, are both 32 KiB
(32768), about 190 nested calls. A larger value throws
`WORKFLOW_DEFINITION_INVALID` when the `ScriptWorkflowAgent` is built (and again
at a run whose per-run limits exceed it).

### What the limit covers

The limit counts guest frames. It makes ordinary deep recursion end in
QuickJS's own error, `WORKFLOW_LIMIT_EXCEEDED`. It does not count the native
recursion inside QuickJS, such as its parser, so a deeply nested source given to
`eval` or `new Function` can exhaust the host stack first. No static value is
safe on every host: a thread with a small stack overflows at a smaller size.

Each measurement is one run in a fresh process, with 37 deep-recursion patterns
(the 22 ordinary ones: plain, generator, getter, Proxy, `JSON`, `sort`
comparator, `toString` chains and others; and 15 parser and compiler ones):

| Host | Ordinary patterns | Parser patterns |
|---|---|---|
| Node 22 | clean up to 64 KiB | first overflow at 32 KiB |
| Node 24 | clean up to 64 KiB | first overflow at 32 KiB |
| Node 26 | clean up to 64 KiB | first overflow at 32 KiB |
| Bun 1.4 | clean up to 64 KiB | first overflow at 24 KiB |
| Node 26 worker, 1 MB stack | clean up to 48 KiB | first overflow at 32 KiB |

### When the host stack is exhausted anyway

Any host stack overflow or WebAssembly abort, in a turn, in the parser at
set-up, while reading an error or while freeing the runtime, is contained:

- That run ends with `WORKFLOW_LIMIT_EXCEEDED`; the message says the host stack
  was exhausted and the sandbox was reset.
- The module is marked poisoned. The overflow unwinds the module without
  freeing the guest's objects and can stop inside its allocator, so its heap is
  not trusted. Every other session on it fails its next turn with
  `WORKFLOW_EXECUTION_ERROR`; start those runs again. This favors integrity: one
  hostile script fails the other live script sessions of the process.
- A new session never starts on a poisoned module. The default loader builds a
  new one. A custom `loader` that returns the poisoned module again is refused
  with `WORKFLOW_SANDBOX_UNAVAILABLE`; give it a `discardModule` that drops its
  cache.

Run a deep script on your own host (Windows, a small thread stack) to see which
case it takes.

## Identifiers and paths

Every store, controller and driver checks identifiers against the same named
grammars. Each starts with an ASCII letter or digit, so no identifier is blank,
starts with a separator or contains whitespace.

| Grammar | Characters | Length | Used for |
| --- | --- | --- | --- |
| Record id | `A-Z a-z 0-9 . _ : -` | 1-256 | Execution, task, plan lane, agent, grant, proposal, reservation, message, lease and worker ids, including the execution and task ids of Git and in-memory workspaces. An agent id is a record id because it is stored on plans, task records and change sets. |
| Principal id | record id characters plus `@` and `/` | 1-256 | The `actorId` of a `WorkflowActorContext`, such as `team/reviewer` or `user@example.com`. `+` is not accepted, so map an address such as `user+tag@example.com` to another principal id. |
| Opaque id | `A-Z a-z 0-9 . _ : + / -` | 1-256 | Receipt, host operation, artifact, workspace and other resource ids, Git target refs, and workflow definition ids and versions. |
| Revision | opaque id characters | 1-512 | Base revisions (including `plan.baseRevision`), workspace revisions and commit ids. |

Workspace adapters (`InMemoryWorkspaceAdapter` and `FileSystemWorkspaceAdapter`)
do not apply these grammars to workspace, lease and owner ids: they only trim
them and reject blank ones.

Paths in workspace leases, change sets and ownership claims follow one portable
path grammar: `/`-separated segments relative to the workspace root, at most
4096 characters. A blank path, a NUL character, a backslash (`\` is a name
character on POSIX, so it is never read as a separator), a leading `/`, a drive
prefix and any `..` segment are always rejected. Any first segment of one
ASCII letter followed by a colon is a drive prefix, so `x:y` and `a:b.txt` are
rejected too. The canonical
form has no empty or `.` segments and no trailing slash. Lease paths and change
set paths are normalized to the canonical form (a lease may name the root as
`.`); ownership claims and paths reported by Git must already be canonical.

`defineWorkflow` and `defineScriptWorkflow` reject an id or version outside the
opaque id grammar with `WORKFLOW_DEFINITION_INVALID`: ids such as
`Code Review`, `pkg@1.2.3`, `café`, `_a`, `.a` or `-a`, or longer than 256
characters, no longer load. `WorkflowDefinitionRegistry`
keys definitions by id and version, so several versions of one workflow can be
registered side by side: `get`, `has`, `require` and `delete` take both, and
`versions(id)` lists the registered versions. `require` throws
`WORKFLOW_DEFINITION_NOT_FOUND` for an unknown pair; registering the same id
and version twice throws `WORKFLOW_DEFINITION_INVALID`.

## Error codes

Every error below carries a stable `code`; branch on it, not on the message.
The code unions are exported as types, so a `switch` over `error.code` is
checked for exhaustiveness.

### `WorkflowOrchestrationControlError` (`WorkflowOrchestrationControlErrorCode`)

Thrown by plan and ownership controllers, authorization helpers and the
orchestration stores. `details` is a frozen JSON object.

| Code | Meaning |
| --- | --- |
| `WORKFLOW_ORCHESTRATION_INVALID_REQUEST` | A plan, message, state or argument is malformed, including an identifier or path outside the [grammars](#identifiers-and-paths). |
| `WORKFLOW_ORCHESTRATION_UNAUTHORIZED` | The actor is missing, forged, bound to another execution or task, not bound to a plan revision, bound to a plan revision outside the request (one that is not active yet, or an older one it asks to read), lacks the permission, or is denied by the authorizer. `details.reason` is `"unauthorized"`, as it was when this failure used `WORKFLOW_ORCHESTRATION_INVALID_REQUEST`. |
| `WORKFLOW_PLAN_NOT_FOUND` | The plan revision does not exist. |
| `WORKFLOW_PLAN_DUPLICATE` | A plan revision with the same key is already stored. |
| `WORKFLOW_PLAN_REVISION_CONFLICT` | A revision is not contiguous (the first must be 1; activation advances exactly one), the base revision changed, or a state compare-and-set saw another revision. |
| `WORKFLOW_PLAN_STALE` | A plan revision was superseded: a plan or activation older than the latest, a request for a revision that is not the active one, an actor or task bound to a revision older than the active plan (`details.actorPlanRevision` and `details.activePlanRevision`), or an execution with no active plan. A change set that declares another revision fails with `WORKFLOW_CHANGE_PLAN_REVISION_MISMATCH`, and a receipt whose lease names another revision with `WORKFLOW_CHANGE_AUTHORITY_INVALID`. |
| `WORKFLOW_ORCHESTRATION_STATE_NOT_FOUND` | No orchestration state exists for the execution. |
| `WORKFLOW_ORCHESTRATION_STATE_DUPLICATE` | Orchestration state for the execution already exists. |
| `WORKFLOW_OWNERSHIP_CONFLICT` | A claim overlaps paths that another grant owns, or a proposal was already decided the other way. |
| `WORKFLOW_OWNERSHIP_NOT_FOUND` | The grant or proposal id is unknown. |
| `WORKFLOW_OWNERSHIP_STALE` | The fencing token, grant or task claim no longer matches the current ownership on the active plan revision. |
| `WORKFLOW_MUTATION_RESERVATION_ACTIVE` | An active host mutation reservation blocks plan activation or the grant change. |
| `WORKFLOW_PATH_NOT_OWNED` | A path is outside the lane's ownership or not covered by current grants. |
| `WORKFLOW_RESERVED_PATH` | A non-integration lane touches a path reserved for integration. |

### `WorkflowChangeValidationError` (`WorkflowChangeValidationErrorCode`)

Thrown by `WorkflowOwnershipChangeSetValidator` before it issues a receipt.

| Code | Meaning |
| --- | --- |
| `WORKFLOW_CHANGE_BASE_REVISION_MISMATCH` | The change set or the plan does not use the expected base revision. |
| `WORKFLOW_CHANGE_PLAN_REVISION_MISMATCH` | The change set declares a different plan revision than expected. |
| `WORKFLOW_CHANGE_TASK_IDENTITY_MISMATCH` | The change set's task and agent are not a lane of the plan. |
| `WORKFLOW_CHANGE_ENTRY_KIND_DENIED` | An entry kind (for example a symlink or submodule) is not allowed by host policy. |

### Change evidence (`WorkflowChangeMismatchErrorCode`, `WorkflowChangeAuthorityErrorCode`)

`WorkflowChangeMismatchError` reports evidence that does not line up:

| Code | Meaning |
| --- | --- |
| `CHANGE_SET_DIGEST_MISMATCH` | A change set's declared digest does not match its entries. |
| `CHANGE_RECEIPT_MISMATCH` | The inspected or prepared change set differs from the accepted receipt. |
| `COMMIT_RESULT_MISMATCH` | A commit result is not linked to its receipt or preparation. |
| `INTEGRATION_REQUEST_MISMATCH` | An integration request disagrees with its receipt and commit evidence. |
| `INTEGRATION_RESULT_MISMATCH` | An integration result is not linked to its request. |

`WorkflowChangeAuthorityError` reports the receipt authority:

| Code | Meaning |
| --- | --- |
| `WORKFLOW_CHANGE_AUTHORITY_REQUIRED` | Authority evidence is absent. |
| `WORKFLOW_CHANGE_AUTHORITY_INVALID` | The authority returned a malformed or foreign lease. |

`WorkflowHostMutationConflictError` has the single code
`WORKFLOW_HOST_MUTATION_CONFLICT`: a mutation journal saw an operation id
reused with another digest, or an invalid state change.

### `NodeGitWorktreeError` (`NodeGitWorktreeErrorCode`)

Thrown by the Node Git worktree driver (`adk-llm-bridge/workflows/node`).

| Code | Meaning |
| --- | --- |
| `GIT_CONFIGURATION_INVALID` | Caller input only: invalid driver options (roots, a `repoRoot` that is not a Git top level, a `baseRevision` that is not a safe revision or does not resolve to a commit, a `commandTimeoutMs` that is not a positive safe integer), a handle or descriptor this driver did not issue, a generated workspace id that is already active, or an invalid target ref. |
| `GIT_COMMAND_FAILED` | A `git` process failed (nonzero exit, timeout, missing binary) or returned output the driver cannot read: an object id in the wrong form (from `commit-tree`, `write-tree` or `rev-parse`), a Git common directory that does not exist, a tree entry missing from the base, or malformed `git diff` output. A timeout reads `timed out after N ms`. The message names the subcommand and Git's last stderr line; `cause` holds the process error. An aborted call rejects with the caller's abort reason instead. |
| `GIT_ENTRY_UNSUPPORTED` | A base tree entry has an unsupported mode, a changed filesystem entry is not a file, directory, symlink or submodule, or the worktree holds an untracked nested Git repository (remove it or add it as a submodule). |
| `GIT_WORKTREE_PATH_ESCAPE` | A worktree or changed path escapes the worktree root, was removed or replaced, or is not a canonical [portable path](#identifiers-and-paths) (for example it contains `\` or starts with a drive prefix). |
| `GIT_WORKTREE_STALE` | The worktree was already released, is missing, no longer matches its descriptor, or its HEAD moved off the immutable base revision. |
| `GIT_SYMLINK_ESCAPE` | A changed symlink points outside the worktree. |
| `GIT_CHANGE_SET_MISMATCH` | An inspection request or change set does not identify this worktree, a preparation is absent, stale or foreign, the commit does not contain the prepared tree, the integration commit tree is not linked to the receipt, or a durable commit or integration result is not linked to this publication. |
| `GIT_TARGET_STALE` | The integration target moved from the expected revision. |
| `GIT_COMMIT_NOT_FAST_FORWARD` | The commit's first parent is not the expected revision (the base revision for a commit, the expected target for an integration). |
| `GIT_TARGET_CHECKED_OUT` | The integration target is checked out in a worktree. |
| `GIT_MUTATION_AMBIGUOUS` | A mutation's outcome cannot be proven (for example the repository lock timed out); reconcile through the journal. |
