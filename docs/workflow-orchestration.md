# Multi-agent workflow orchestration

The orchestration core turns a dynamic group of ADK, Codex, Claude Code, or
remote workers into a versioned and fenced workflow. Agents are first-class
tasks, but authority stays in host-owned ports; JSON is data, never a
capability.

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

## Recovery guarantees

- Task claims, operation IDs, plan/grant fences, and terminal writes prevent a
  recovered worker from accepting stale success.
- Publication reservations can be reattached after restart. A completed commit
  fences ownership until integration or explicit abandonment.
- Git mode, content, tree, parent, receipt, target, and expected ref are linked.
  Ambiguous mutations are reconciled through the journal.
- Bundled in-memory stores are bounded single-process references. Production
  recovery requires durable, linearizable adapters and a persistent journal.

The control plane is deny-by-default for task operations. An MCP/RPC transport
authenticates the connection, creates a host-only `WorkflowActorContext`, and
passes it in dispatch options. Never serialize that actor or enable
`trustedHostMode` on an agent-facing endpoint.
