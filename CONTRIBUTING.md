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

## Branch Strategy

We use a multi-branch workflow:

```
feature/* → develop → staging → main
```

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready code |
| `staging` | Pre-production testing |
| `develop` | Integration branch for features |
| `feature/*` | Individual feature development |

## Pull Request Process

1. **Fork the repository** and create your branch from `develop`
2. **Make your changes** following the code style guidelines
3. **Add tests** for any new functionality
4. **Run the CI pipeline** (`bun run ci`) and ensure it passes
5. **Update documentation** if needed
6. **Submit a pull request** to `develop` with a clear description
7. After review and merge to `develop`, changes flow: `develop → staging → main`

### PR Title Format

Use conventional commit format:
- `feat: add new feature`
- `fix: resolve bug`
- `docs: update documentation`
- `refactor: improve code structure`
- `test: add tests`

## Reporting Issues

When reporting issues, please include:
- A clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node.js version, OS, etc.)

## Questions?

Feel free to open an issue for any questions about contributing.
