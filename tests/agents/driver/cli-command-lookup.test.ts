/**
 * With the built-in spawn, the CLI drivers never start a bare `command` from a
 * `PATH` entry inside the run's working directory or `allowedPaths`: under
 * `npm run` / `bun run` `PATH` starts with `<cwd>/node_modules/.bin`, which
 * the agent can write. When nothing usable is left the run ends with
 * `MISSING_BINARY`. Fake binaries only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { CodexCliDriver } from "../../../src/agents/driver/codex-cli.js";
import { resolveCliCommand } from "../../../src/agents/driver/subprocess-jsonl.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import { CLAUDE_PROVIDER, CODEX_PROVIDER } from "../../../src/agents/index.js";
import { noHostMcpServers } from "../helpers.js";

type Tree = {
  root: string;
  workspace: string;
  planted: string;
  safe: string;
  markers: string;
};

let tree: Tree;
const originalCwd = process.cwd();

/** A fake CLI that records that it ran, then drains stdin and exits 0. */
function fakeCli(dir: string, name: string, marker: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\ncat >/dev/null\nexit 0\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cli-lookup-")));
  const workspace = join(root, "workspace");
  tree = {
    root,
    workspace,
    planted: join(workspace, "node_modules", ".bin"),
    safe: join(root, "host-bin"),
    markers: join(root, "markers"),
  };
  mkdirSync(tree.markers, { recursive: true });
  for (const name of ["claude", "codex"]) {
    fakeCli(tree.planted, name, join(tree.markers, `planted-${name}`));
  }
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tree.root, { recursive: true, force: true });
});

function addSafe(name: string): string {
  return fakeCli(tree.safe, name, join(tree.markers, `safe-${name}`));
}

const ran = (marker: string) => existsSync(join(tree.markers, marker));

async function collect(
  iterable: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

type Runtime = "claude" | "codex";

function runDriver(
  runtime: Runtime,
  PATH: string,
  request: Partial<ExternalAgentRunRequest>,
): Promise<ExternalAgentEvent[]> {
  const env = { PATH };
  if (runtime === "claude") {
    return collect(
      new ClaudeCliDriver({ env }).run({
        provider: CLAUDE_PROVIDER,
        context: { input: "hi" } as never,
        ...request,
      }),
    );
  }
  return collect(
    new CodexCliDriver({ env, listMcpServers: noHostMcpServers }).run({
      provider: CODEX_PROVIDER,
      context: { input: "hi" } as never,
      ...request,
    }),
  );
}

const codeOf = (events: ExternalAgentEvent[]) =>
  events.find((event) => event.type === "error")?.code;

describe.each(["claude", "codex"] as const)("%s CLI lookup", (runtime) => {
  test("default workingDirectory: the planted binary does not run", async () => {
    process.chdir(tree.workspace);
    const events = await runDriver(
      runtime,
      [tree.planted, "/usr/bin", "/bin"].join(delimiter),
      {},
    );
    expect(ran(`planted-${runtime}`)).toBe(false);
    expect(codeOf(events)).toBe("MISSING_BINARY");
  });

  test("workingDirectory === process.cwd(): the planted binary does not run", async () => {
    process.chdir(tree.workspace);
    const events = await runDriver(
      runtime,
      [tree.planted, "/usr/bin", "/bin"].join(delimiter),
      { workingDirectory: process.cwd() },
    );
    expect(ran(`planted-${runtime}`)).toBe(false);
    expect(codeOf(events)).toBe("MISSING_BINARY");
  });

  test("a later PATH entry outside the workspace is used", async () => {
    addSafe(runtime);
    const events = await runDriver(
      runtime,
      [tree.planted, tree.safe].join(delimiter),
      { workingDirectory: tree.workspace },
    );
    expect(ran(`planted-${runtime}`)).toBe(false);
    expect(ran(`safe-${runtime}`)).toBe(true);
    expect(codeOf(events)).toBeUndefined();
  });
});

describe("resolveCliCommand", () => {
  const request = () => ({ workingDirectory: tree.workspace });

  test("returns the first PATH candidate outside the writable roots", () => {
    const safe = addSafe("claude");
    expect(
      resolveCliCommand(
        "claude",
        { PATH: [tree.planted, tree.safe].join(delimiter) },
        request(),
      ),
    ).toBe(safe);
  });

  test("never searches a relative or an empty PATH entry", () => {
    fakeCli(tree.workspace, "claude", join(tree.markers, "x"));
    addSafe("claude");
    // "../host-bin" from the workspace is the safe directory: still skipped.
    expect(
      resolveCliCommand(
        "claude",
        { PATH: ["node_modules/.bin", "", ".", "../host-bin"].join(delimiter) },
        request(),
      ),
    ).toBeUndefined();
    process.chdir(tree.workspace);
    expect(
      resolveCliCommand("claude", { PATH: "../host-bin" }, request()),
    ).toBeUndefined();
  });

  test("skips a symlink outside the workspace that points into it", () => {
    mkdirSync(tree.safe, { recursive: true });
    symlinkSync(join(tree.planted, "claude"), join(tree.safe, "claude"));
    expect(
      resolveCliCommand("claude", { PATH: tree.safe }, request()),
    ).toBeUndefined();
  });

  test("skips an allowedPaths root", () => {
    const extra = join(tree.root, "extra");
    fakeCli(extra, "claude", join(tree.markers, "x"));
    expect(
      resolveCliCommand(
        "claude",
        { PATH: extra },
        { ...request(), permissions: { mode: "ask", allowedPaths: [extra] } },
      ),
    ).toBeUndefined();
  });

  test("skips a directory and a file that is not executable", () => {
    mkdirSync(join(tree.safe, "claude"), { recursive: true });
    const other = join(tree.root, "other");
    mkdirSync(other);
    writeFileSync(join(other, "claude"), "#!/bin/sh\n");
    expect(
      resolveCliCommand(
        "claude",
        { PATH: [tree.safe, other].join(delimiter) },
        request(),
      ),
    ).toBeUndefined();
  });

  test("returns a command with a path separator unchanged", () => {
    const explicit = join(tree.planted, "claude");
    expect(resolveCliCommand(explicit, { PATH: "" }, request())).toBe(explicit);
    expect(resolveCliCommand("./claude", { PATH: "" }, request())).toBe(
      "./claude",
    );
  });

  test("gives undefined without PATH", () => {
    expect(resolveCliCommand("claude", {}, request())).toBeUndefined();
  });
});

describe("explicit command and custom spawn", () => {
  test("an absolute command inside the workspace runs as given", async () => {
    const events = await collect(
      new ClaudeCliDriver({
        command: join(tree.planted, "claude"),
        env: { PATH: "/usr/bin:/bin" },
      }).run({
        provider: CLAUDE_PROVIDER,
        context: { input: "hi" } as never,
        workingDirectory: tree.workspace,
      }),
    );
    expect(ran("planted-claude")).toBe(true);
    expect(codeOf(events)).toBeUndefined();
  });

  test("a custom spawn receives the command as given", async () => {
    const commands: string[] = [];
    await collect(
      new ClaudeCliDriver({
        env: { PATH: tree.planted },
        spawn: (command) => {
          commands.push(command);
          return { stdout: [], stderr: [], exited: Promise.resolve(0) };
        },
      }).run({
        provider: CLAUDE_PROVIDER,
        context: { input: "hi" } as never,
        workingDirectory: tree.workspace,
      }),
    );
    expect(commands).toEqual(["claude"]);
  });
});
