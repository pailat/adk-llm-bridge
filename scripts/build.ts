/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Build script for adk-llm-bridge using Bun.build() API.
 *
 * Best practices from https://bun.sh/docs/bundler
 *
 * @module scripts/build
 */

const result = await Bun.build({
  // Entry point
  entrypoints: ["./src/index.ts"],

  // Output directory
  outdir: "./dist",

  // Target Node.js runtime (also works with Bun)
  target: "node",

  // ES modules format
  format: "esm",

  // Minification for smaller bundle
  minify: {
    whitespace: true,
    syntax: true,
    identifiers: false, // Keep readable for debugging
  },

  // Sourcemaps for debugging
  sourcemap: "linked",

  // Single file output (no code splitting for libraries)
  splitting: false,

  // External dependencies (not bundled)
  external: ["@google/adk", "@google/genai", "openai"],

  // Naming convention
  naming: "[name].js",
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`✓ Built ${result.outputs.length} file(s)`);
for (const output of result.outputs) {
  console.log(`  ${output.path} (${(output.size / 1024).toFixed(2)} KB)`);
}
