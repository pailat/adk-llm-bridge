/**
 * CLI entry point for the native-features showcase.
 *
 * Run from THIS directory (Bun auto-loads .env from cwd):
 *
 *   bun run start                 # banner + usage + demo list
 *   bun run list                  # list demos
 *   bun run <demo>                # run one demo (e.g. bun run reasoning)
 *   bun run all                   # run all six demos sequentially
 *   bun run src/cli.ts <name> [--provider anthropic|openai] [--model <id>]
 */
import { loadConfig } from "./config";
import { createOutput } from "./output";
import { AgentHarness } from "./runner";
import type { DemoContext } from "./types";
// Side-effect import: registers every demo into the registry.
import { registry } from "./demos";

interface ParsedArgs {
  command?: string;
  provider?: string;
  model?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--provider") parsed.provider = argv[++i];
    else if (arg === "--model") parsed.model = argv[++i];
    else if (!arg.startsWith("--") && parsed.command === undefined)
      parsed.command = arg;
  }
  return parsed;
}

function printList(): void {
  console.log("Available demos:\n");
  for (const demo of registry.list()) {
    console.log(`  ${demo.name.padEnd(18)} ${demo.description}`);
  }
}

function printUsage(): void {
  console.log(
    "native-features — showcase of native-model capabilities adk-llm-bridge passes through\n",
  );
  console.log("Usage:");
  console.log("  bun run <demo>           run one demo");
  console.log("  bun run all              run all demos");
  console.log("  bun run list             list demos");
  console.log(
    "  bun run src/cli.ts <name> [--provider anthropic|openai] [--model <id>]\n",
  );
  printList();
}

async function main(): Promise<void> {
  const { command, provider, model } = parseArgs(process.argv.slice(2));
  const out = createOutput();

  // No command (or `start`): show usage + list and exit cleanly.
  if (!command || command === "start") {
    printUsage();
    return;
  }

  if (command === "list") {
    printList();
    return;
  }

  let config;
  try {
    config = loadConfig({ provider, model });
  } catch (error) {
    out.error(error);
    process.exit(1);
  }

  const harness = new AgentHarness(out);
  const ctx: DemoContext = { harness, out, config };

  const toRun =
    command === "all"
      ? registry.list()
      : (() => {
          const demo = registry.get(command);
          if (!demo) {
            console.error(`Unknown demo: "${command}"\n`);
            printList();
            process.exit(1);
          }
          return [demo];
        })();

  for (const demo of toRun) {
    try {
      await demo.run(ctx);
      console.log("");
    } catch (error) {
      out.error(error);
      // Continue to the next demo when running `all`; fail for a single demo.
      if (command !== "all") process.exit(1);
    }
  }
}

await main();
