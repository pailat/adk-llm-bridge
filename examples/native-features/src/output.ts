/**
 * Dependency-free, labeled console output.
 *
 * Centralizes rendering so every demo looks consistent and per-demo
 * `console.log` drift is avoided. Uses only small ANSI constants (no chalk).
 */
import type { AppConfig, Demo, Usage } from "./types";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
} as const;

export interface Output {
  /** Banner with demo name, description, and resolved provider+model. */
  header(d: Demo, c: AppConfig): void;
  /** A "key: value" line. */
  label(key: string, value: unknown): void;
  /** A minor section title. */
  section(title: string): void;
  /** Write a streamed chunk with no trailing newline. */
  stream(chunk: string): void;
  /** Render reasoning / thought text distinctly. */
  thought(text: string): void;
  /** Pretty-print usage metadata (incl. thoughtsTokenCount). */
  usage(u?: Usage): void;
  /** Friendly error rendering with hints for common failures. */
  error(e: unknown): void;
}

function fmt(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function createOutput(): Output {
  return {
    header(d, c) {
      const bar = "═".repeat(64);
      console.log(`${ANSI.cyan}${bar}${ANSI.reset}`);
      console.log(`${ANSI.bold}${ANSI.cyan}▶ ${d.name}${ANSI.reset}`);
      console.log(`${ANSI.dim}${d.description}${ANSI.reset}`);
      console.log(
        `${ANSI.dim}provider=${c.provider}  model=${c.model}${ANSI.reset}`,
      );
      console.log(`${ANSI.cyan}${bar}${ANSI.reset}`);
    },
    label(key, value) {
      console.log(`${ANSI.bold}${key}:${ANSI.reset} ${fmt(value)}`);
    },
    section(title) {
      console.log(`\n${ANSI.magenta}── ${title} ──${ANSI.reset}`);
    },
    stream(chunk) {
      process.stdout.write(chunk);
    },
    thought(text) {
      console.log(`${ANSI.yellow}🧠 ${text}${ANSI.reset}`);
    },
    usage(u) {
      if (!u) {
        console.log(`${ANSI.dim}(no usage metadata reported)${ANSI.reset}`);
        return;
      }
      console.log(
        `${ANSI.green}usage${ANSI.reset} ` +
          `prompt=${u.promptTokenCount ?? "-"} ` +
          `candidates=${u.candidatesTokenCount ?? "-"} ` +
          `thoughts=${u.thoughtsTokenCount ?? "-"} ` +
          `total=${u.totalTokenCount ?? "-"}`,
      );
    },
    error(e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`${ANSI.red}✖ ${message}${ANSI.reset}`);
      if (/api[_-]?key|unauthor|401|missing .* key/i.test(message)) {
        console.error(
          `${ANSI.dim}  Hint: copy .env.example to .env and set your API key:` +
            `\n        cp .env.example .env${ANSI.reset}`,
        );
      } else if (/400|temperature|top_p|thinking/i.test(message)) {
        console.error(
          `${ANSI.dim}  Hint: provider sampling/thinking constraints — see README "Provider Constraints".${ANSI.reset}`,
        );
      }
    },
  };
}
