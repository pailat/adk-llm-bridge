# Contributing to adk-llm-bridge

Thank you for your interest in contributing! This document explains how to
contribute: the workflow, the pull request process, commit conventions and the
project policies. For setup, commands and architecture, see
[DEVELOPMENT.md](DEVELOPMENT.md).

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
To report a security problem, follow [SECURITY.md](SECURITY.md) instead of
opening a public issue.

## Getting started

1. Fork the repository and clone it.
2. Follow the setup in [DEVELOPMENT.md](DEVELOPMENT.md#development-setup).
3. Create a branch from `main` and make your change.
4. Run `bun run ci` before you open a pull request.

## Branch strategy (GitHub Flow)

We use a single `main` branch and short-lived topic branches:

| Pattern | Purpose | Example |
|---------|---------|---------|
| `feature/*` | New features | `feature/add-openrouter-support` |
| `fix/*` | Bug fixes | `fix/streaming-response-error` |
| `docs/*` | Documentation updates | `docs/update-readme` |
| `chore/*` | Maintenance tasks | `chore/update-dependencies` |

```bash
git checkout main && git pull
git checkout -b feature/my-feature
# develop and commit
git push origin feature/my-feature
gh pr create --base main
```

## Code style and standards

- [Biome](https://biomejs.dev/) lints and formats the code (`bun run check`).
- TypeScript strict mode is enabled.
- File names use kebab-case, for example `ai-gateway-llm.ts`.
- Comments follow the [code comment standard](docs/contributing/comments.md):
  TSDoc on exported symbols, `//` comments that explain why, no internal
  tracking ids, and no license headers. `bun run check:comments` enforces it.

## Tests

- Write tests for new features and bug fixes.
- Place tests in `tests/`, mirroring the structure of `src/`.
- Use `bun:test`.

## Pull request process

### Before you open a pull request

1. Sync with main: `git pull origin main --rebase`.
2. Run `bun run ci` and make sure it passes.
3. Keep commits focused: one logical change per commit.

### Requirements

- CI passes (typecheck, lint, comment check, tests, build).
- A clear description of the change.
- Tests for new functionality.
- A `CHANGELOG.md` entry in the upcoming version section for user-visible changes.
- Documentation updates if needed.

### Title format

Use [Conventional Commits](https://www.conventionalcommits.org/):

| Type | Description | Example |
|------|-------------|---------|
| `feat` | New feature | `feat: add OpenRouter provider` |
| `fix` | Bug fix | `fix: handle empty response in streaming` |
| `docs` | Documentation | `docs: update API examples` |
| `refactor` | Code refactoring | `refactor: simplify request converter` |
| `test` | Add or update tests | `test: add coverage for edge cases` |
| `chore` | Maintenance | `chore: update dependencies` |

Mark breaking changes with `!` (`feat(agents)!: ...`) and explain them in the
`CHANGELOG.md` entry.

### Merge strategy

We use **Squash and Merge** for all pull requests. Each pull request becomes a
single commit on `main`, which keeps the history linear and easy to revert.

## Releases

Maintainers create releases from `main`; see the
[release checklist](DEVELOPMENT.md#release-checklist). We use semantic
versioning:

| Version bump | When to use |
|--------------|-------------|
| `patch` (0.0.x) | Bug fixes, documentation |
| `minor` (0.x.0) | New features (backward compatible) |
| `major` (x.0.0) | Breaking changes |

While the version is `0.x`, breaking changes ship in a minor release.

## Reporting issues

Use the [issue forms](https://github.com/pailat/adk-llm-bridge/issues/new/choose)
and include:

- A clear description of the problem and the steps to reproduce it.
- Expected and actual behavior.
- Versions: `adk-llm-bridge`, `@google/adk`, Node.js or Bun, and your OS.
- Relevant error messages or logs, with API keys removed.

## License

By contributing, you agree that your contributions are licensed under the MIT License of this project (see LICENSE). Contributors keep the copyright of their contributions. Do not add per-file license or copyright headers. Code adapted from another project keeps its own license: see [third-party code](docs/contributing/comments.md#5-no-license-headers-checked) and `THIRD-PARTY-NOTICES`.

## Questions?

Open an issue for any question about contributing.
