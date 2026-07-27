# Codex-only dynamic workflow

This smoke example runs a first-class `ScriptWorkflowAgent` whose three direct
subagents are all `CodexAgent` instances:

```text
CodexPlanner -> CodexImplementer -> CodexReviewer
```

The QuickJS script controls the sequence. Agent work stays on the host side: the
script yields `ctx.run(...)`, the workflow runtime invokes the corresponding ADK
agent, and the result is passed back into the script before the next step.

The implementer has `workspace-write`; the other two agents are read-only. For
safety, point the example at a disposable Git worktree, never at your primary
checkout.

## Run the smoke

From the repository root:

```bash
git worktree add /tmp/adk-llm-bridge-codex-smoke HEAD
WORKFLOW_TARGET=/tmp/adk-llm-bridge-codex-smoke \
  bun run --cwd examples/codex-workflow smoke
```

Authentication may come from `CODEX_API_KEY`, `OPENAI_API_KEY`, or a readable
`~/.codex/auth.json`. The workflow disables network access for agent tools; this
does not disable the Codex service connection itself.

A successful run prints completion for `plan`, `implement`, and `review`, then
verifies two explicit acknowledgements. Inspect the isolated change with:

```bash
git -C /tmp/adk-llm-bridge-codex-smoke status --short
git -C /tmp/adk-llm-bridge-codex-smoke diff
```
