import { defineConfig } from "bunup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/agents/index.ts",
    "src/agents/session-store/sqlite/index.ts",
    "src/workflows/index.ts",
    "src/workflows/node/index.ts",
  ],
  format: ["esm"],
  target: "node",
  external: [
    "@google/adk",
    "@google/genai",
    "openai",
    "@anthropic-ai/sdk",
    "@anthropic-ai/claude-agent-sdk",
    "@openai/codex-sdk",
    "@opentelemetry/api",
    "quickjs-emscripten-core",
    "@jitl/quickjs-wasmfile-release-sync",
  ],
  dts: { inferTypes: true, splitting: true },
  // Maps keep `sourcesContent`: `src/` is not published and shared chunks have
  // hashed names, so the embedded sources are what turns a stack trace into a
  // `src/` file and line.
  sourcemap: "linked",
  clean: true,
  // Shared modules go to `dist/shared/` chunks, JavaScript and `.d.ts` alike,
  // so each class and registry exists once across the entry points and its
  // type is the same in every subpath (checked by check-dist-entries.ts).
  splitting: true,
});
