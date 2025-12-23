# Contributing to adk-llm-bridge

Thank you for your interest in contributing! This document provides guidelines for contributing to this project.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0.0
- Node.js >= 18.0.0

### Getting Started

```bash
# Clone the repository
git clone https://github.com/pailat/adk-llm-bridge.git
cd adk-llm-bridge

# Install dependencies
bun install

# Run tests
bun test

# Run full CI pipeline
bun run ci
```

## Development Workflow

### Available Scripts

| Command | Description |
|---------|-------------|
| `bun test` | Run tests |
| `bun run build` | Build the package |
| `bun run typecheck` | Type check source files |
| `bun run typecheck:all` | Type check source and test files |
| `bun run lint` | Run linter |
| `bun run lint:fix` | Auto-fix lint issues |
| `bun run check:fix` | Auto-fix lint and formatting |
| `bun run ci` | Run full CI pipeline (typecheck, lint, test, build) |

### Code Style

- We use [Biome](https://biomejs.dev/) for linting and formatting
- TypeScript strict mode is enabled
- Use kebab-case for file names (e.g., `ai-gateway-llm.ts`)

### Testing

- Write tests for all new features
- Place tests in the `tests/` directory mirroring `src/` structure
- Use `bun:test` for testing
- Run `bun test` before submitting a PR

## Branch Strategy (GitHub Flow)

We use a simplified GitHub Flow with a single main branch:

```
main (production)
  │
  └── feature/*, fix/*, docs/* (short-lived branches)
```

### Branch Types

| Pattern | Purpose | Example |
|---------|---------|---------|
| `main` | Production-ready code, always deployable | - |
| `feature/*` | New features | `feature/add-openrouter-support` |
| `fix/*` | Bug fixes | `fix/streaming-response-error` |
| `docs/*` | Documentation updates | `docs/update-readme` |
| `chore/*` | Maintenance tasks | `chore/update-dependencies` |

### Why GitHub Flow?

- **Simplicity**: One main branch, feature branches, PRs. That's it.
- **Continuous Deployment**: Every merge to `main` is deployable.
- **Fast Iteration**: No waiting for staging/develop syncs.
- **Clear History**: Linear history with squash merges.

### Workflow

```
1. Create branch from main
   └── git checkout main && git pull
   └── git checkout -b feature/my-feature

2. Develop and commit
   └── git add . && git commit -m "feat: description"

3. Push and create PR
   └── git push origin feature/my-feature
   └── gh pr create --base main

4. Review, CI passes, merge
   └── Squash and merge to main

5. Delete feature branch
   └── Automatic after merge
```

## Pull Request Process

### Before Creating a PR

1. **Sync with main**: `git pull origin main --rebase`
2. **Run CI locally**: `bun run ci`
3. **Keep commits focused**: One logical change per commit

### Creating a PR

1. **Create your branch** from `main`:
   ```bash
   git checkout main && git pull
   git checkout -b feature/my-feature
   ```

2. **Make your changes** following the code style guidelines

3. **Add tests** for any new functionality

4. **Run the CI pipeline** and ensure it passes:
   ```bash
   bun run ci
   ```

5. **Push and create PR**:
   ```bash
   git push origin feature/my-feature
   gh pr create --base main
   ```

### PR Requirements

- CI must pass (typecheck, lint, tests, build)
- Clear description of changes
- Tests for new functionality
- Documentation updates if needed

### PR Title Format

Use [Conventional Commits](https://www.conventionalcommits.org/):

| Type | Description | Example |
|------|-------------|---------|
| `feat` | New feature | `feat: add OpenRouter provider` |
| `fix` | Bug fix | `fix: handle empty response in streaming` |
| `docs` | Documentation | `docs: update API examples` |
| `refactor` | Code refactoring | `refactor: simplify request converter` |
| `test` | Add/update tests | `test: add coverage for edge cases` |
| `chore` | Maintenance | `chore: update dependencies` |

### Merge Strategy

We use **Squash and Merge** for all PRs:
- Keeps `main` history clean and linear
- Each PR becomes a single commit
- Easy to revert if needed

## Releases

Releases are created from `main` using semantic versioning:

```bash
# After merging features to main
git checkout main && git pull
npm version patch|minor|major  # Updates package.json
git push origin main --tags
gh release create v0.x.x --generate-notes
```

| Version Bump | When to Use |
|--------------|-------------|
| `patch` (0.0.x) | Bug fixes, documentation |
| `minor` (0.x.0) | New features (backward compatible) |
| `major` (x.0.0) | Breaking changes |

## Reporting Issues

When reporting issues, please include:

- A clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node.js version, Bun version, OS)
- Relevant error messages or logs

## Questions?

Feel free to open an issue for any questions about contributing.
