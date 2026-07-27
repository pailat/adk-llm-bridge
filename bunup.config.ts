import { defineConfig } from "bunup";

export default defineConfig({
  entry: ["src/index.ts", "src/agents/index.ts", "src/workflows/index.ts"],
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
  dts: { inferTypes: true },
  sourcemap: "linked",
  clean: true,
  splitting: false,
});
