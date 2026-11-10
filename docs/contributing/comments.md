# Code comment standard

This repository uses [TSDoc](https://tsdoc.org) for documentation comments
and short `//` comments for the reasons behind the code. `bun run ci` runs
`scripts/check-comments.ts`, which enforces the rules marked **(checked)**.

## 1. TSDoc on exported symbols

Every symbol exported from a public entry point (`adk-llm-bridge`,
`adk-llm-bridge/agents`, `adk-llm-bridge/workflows`, and any other `exports`
entry in `package.json`) has a `/** ... */` comment:

- A one-line summary sentence first.
- `@remarks` for details that do not fit the summary.
- `@param name - description` for each parameter, and `@returns` for the
  result.
- `@throws` with the error type and the error code, for example
  ``@throws {@link ProviderLlmError} with code `API_ERROR_429` `` (codes look
  like `API_ERROR_<status>` or `OPENAI_ERROR`).
- `@defaultValue` on options that have a default.
- `@example` where the usage is not obvious.
- `@see` for related symbols or public links, and `@deprecated`,
  `@experimental` where they apply.
- `@internal` on symbols that are exported for other modules of this package
  but are not public API.
- Use `{@link Symbol}` to refer to other symbols.

The TSDoc syntax of every `/** */` block in `src/` must parse without errors
**(checked)**.

```ts
/**
 * Creates an ADK model for a Vercel AI Gateway model id.
 *
 * @remarks
 * The API key is resolved from the instance config, then the global config,
 * then `AI_GATEWAY_API_KEY`.
 *
 * @param model - Gateway model id, for example `anthropic/claude-sonnet-4.6`.
 * @param options - Per-instance options.
 * @returns An ADK `BaseLlm` instance.
 * @throws {@link InputValidationError} when `model` is empty.
 */
export function AIGateway(model: string, options?: AIGatewayProviderConfig): BaseLlm;
```

### Common TSDoc fixes

- Tags TSDoc does not define: replace `@module` with `@packageDocumentation`
  (or remove it), `@default` with `@defaultValue`; remove `@private`,
  `@protected`, `@static`, `@abstract` and `@constant`, because the TypeScript
  modifiers already say it. Use `@internal` for "not public".
- Put `>`, `{`, `}` and `@` that appear in prose inside backticks (for example
  `` `a -> b` ``, `` `Record<string, T>` ``, `` `{ ok: true }` ``,
  `` `@google/adk` ``), or escape them with a backslash, not both: inside
  backticks a backslash is shown literally.
- `{@link ...}` must name a symbol or a URL.
- `@param name - text`: the name only, with no type and no braces, and no
  dotted names such as `options.x` (describe the fields in the text).
- Put HTML-like placeholders such as `<name>` in backticks.

## 2. No internal tracking ids **(checked)**

Comments, test names and file names do not contain internal tracking labels: review or
finding ids (`F2`, `N1`, `E3`, `B1`, `m2`), stream or lane ids
(`STREAM-1`, `AGENTS-6`, `RT-8`, `WF-4b`, `LLM-3b`, `OBS-9`, `PERM-1`), wave names
(`Wave 4`), or request numbers (`REQUESTS #7`). A reader of the published code
cannot look them up. That history belongs in commit messages, pull requests
and the CHANGELOG.

Do not refer to an issue or pull request by number alone (`issue #89`,
`PR #90`): write the link instead. Public links are welcome when they help:

```ts
/** @see https://github.com/pailat/adk-llm-bridge/issues/89 */
// Works around https://github.com/google/adk-js/issues/123
```

## 3. Inline comments explain why

A `//` comment states the constraint, the invariant, or the upstream behavior
that the code works around. It does not repeat what the code does, and it does
not narrate changes ("now", "was", "fixed", "previously", "no longer"). No
commented-out code. A `TODO` needs a public issue link.

```ts
// Before: STREAM-1: flipped off until the driver handles stream_event.
// After:
// The SDK driver emits whole assistant messages, not token deltas
// (`includePartialMessages` is off), so streaming is not advertised.
// Enable it only together with `stream_event` delta handling in the driver.
streaming: false,
```

## 4. Security rules and invariants stay explicit

Fail-closed rules, permission inheritance, redaction and other security
invariants are always stated next to the code that implements them. When you
clean up a comment, rewrite these clearly; never delete them.

## 5. No license headers **(checked)**

Source files carry no `@license`, `Copyright` or `SPDX-License-Identifier`
comment. The `LICENSE` file at the repository root is the single source of the
license and copyright notice. The check flags any comment under `src/` and
`tests/` that contains one of those words, not only a leading header. A comment
that legitimately quotes a third-party notice can carry
`check-comments-allow: <reason>`.

## 6. Tests

The `describe` and `test` names carry the meaning of a test, including the
names in `describe.each` and `test.each` calls. Test comments follow rules 2 and
3.

## 7. Language

Comments, docs and test names are in English.

## The check

`bun run check:comments` (`bun scripts/check-comments.ts`) enforces these rules:

| Rule | Scope |
|------|-------|
| Internal tracking ids in comments, in test names (including `.each` forms) and in file names such as `thing-wave4d.test.ts` (rule 2) | `src/` and `tests/` |
| Bare issue or pull request numbers (`issue #89`) in comments and test names (rule 2) | `src/` and `tests/` |
| TSDoc syntax of every `/** */` block, parsed with `@microsoft/tsdoc` (rule 1) | `src/` |
| Per-file license or copyright comments (rule 5) | `src/` and `tests/` |

`bun run check:export-docs` (`bun scripts/check-export-docs.ts`) runs after
`bun run build`. It reads the built declarations of every public entry point
(`dist/**/index.d.ts`) and fails when an exported symbol has no TSDoc summary
(rule 1). A symbol marked `@internal` is skipped. TypeScript 7 has no
JavaScript compiler API, so the script reads the bundled declaration files
directly.

To allow one line that is not a tracking id or a license notice (for example a
quoted upstream error message), add `check-comments-allow:` followed by the
reason on the same line. The marker without a reason is itself a finding:

```ts
// The CLI prints "F2: unknown flag" here. check-comments-allow: upstream text
```

Both scripts exit 1 on any finding; `--report` prints the findings and exits 0.
`bun run ci` and `prepublishOnly` run them without `--report`.
