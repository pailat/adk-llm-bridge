import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Content } from "@google/genai";
import { userContentToCodexInput } from "../../../src/agents/driver/codex-input-mapper.js";
import { CodexSdkDriver } from "../../../src/agents/driver/codex-sdk.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { CODEX_PROVIDER } from "../../../src/agents/provider/schema.js";

const PNG_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const PNG_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);
const POSIX = process.platform !== "win32";

const dirs: string[] = [];

function freshTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-input-tmp-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function imageTurn(bytes: Buffer, text = "describe"): Content {
  return {
    role: "user",
    parts: [
      { inlineData: { mimeType: "image/png", data: bytes.toString("base64") } },
      { text },
    ],
  };
}

function imagePaths(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((part) => part?.type === "local_image")
    .map((part) => part.path as string);
}

describe("userContentToCodexInput temporary files", () => {
  test("two mappings with the same directory and prefix do not collide", async () => {
    const tmpDir = freshTmpDir();
    const first = userContentToCodexInput(imageTurn(PNG_A), {
      tmpDir,
      idPrefix: "turn",
    });
    const second = userContentToCodexInput(imageTurn(PNG_B), {
      tmpDir,
      idPrefix: "turn",
    });
    const [firstPath] = imagePaths(first.input);
    const [secondPath] = imagePaths(second.input);

    expect(firstPath).toBeDefined();
    expect(secondPath).toBeDefined();
    expect(firstPath).not.toBe(secondPath);
    expect(dirname(firstPath as string)).not.toBe(
      dirname(secondPath as string),
    );
    expect(readFileSync(firstPath as string)).toEqual(PNG_A);
    expect(readFileSync(secondPath as string)).toEqual(PNG_B);

    await first.cleanup();
    expect(existsSync(dirname(firstPath as string))).toBe(false);
    // The other mapping's files survive the first cleanup.
    expect(readFileSync(secondPath as string)).toEqual(PNG_B);
    await second.cleanup();
    expect(existsSync(dirname(secondPath as string))).toBe(false);
  });

  test("writes into a private directory under tmpDir, not at the predictable path", async () => {
    const tmpDir = freshTmpDir();
    const mapping = userContentToCodexInput(imageTurn(PNG_A), { tmpDir });
    const [path] = imagePaths(mapping.input);

    expect(path).toBeDefined();
    expect(path).not.toBe(join(tmpDir, "codex-turn-0.png"));
    const runDir = dirname(path as string);
    expect(dirname(runDir)).toBe(tmpDir);
    if (POSIX) {
      expect(statSync(runDir).mode & 0o777).toBe(0o700);
      expect(statSync(path as string).mode & 0o777).toBe(0o600);
    }
    await mapping.cleanup();
    expect(existsSync(runDir)).toBe(false);
  });

  test("a pre-created file at the old predictable path is left untouched", async () => {
    const tmpDir = freshTmpDir();
    const planted = join(tmpDir, "codex-turn-0.png");
    writeFileSync(planted, "planted");

    const mapping = userContentToCodexInput(imageTurn(PNG_A), { tmpDir });
    const [path] = imagePaths(mapping.input);

    expect(path).not.toBe(planted);
    expect(readFileSync(path as string)).toEqual(PNG_A);
    expect(readFileSync(planted, "utf8")).toBe("planted");
    await mapping.cleanup();
    expect(readFileSync(planted, "utf8")).toBe("planted");
  });

  test.skipIf(!POSIX)(
    "a symbolic link at the old predictable path is not followed",
    async () => {
      const tmpDir = freshTmpDir();
      const victim = join(freshTmpDir(), "victim.txt");
      writeFileSync(victim, "keep me");
      const link = join(tmpDir, "codex-turn-0.png");
      symlinkSync(victim, link);

      const mapping = userContentToCodexInput(imageTurn(PNG_A), { tmpDir });
      const [path] = imagePaths(mapping.input);

      expect(path).not.toBe(link);
      expect(readFileSync(victim, "utf8")).toBe("keep me");
      await mapping.cleanup();
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(victim, "utf8")).toBe("keep me");
    },
  );

  test("a prefix with path separators stays inside the private directory", async () => {
    const tmpDir = freshTmpDir();
    const mapping = userContentToCodexInput(imageTurn(PNG_A), {
      tmpDir,
      idPrefix: "../../escape",
    });
    const [path] = imagePaths(mapping.input);

    expect(path).toBeDefined();
    const rel = relative(tmpDir, path as string);
    expect(rel.startsWith("..")).toBe(false);
    expect(dirname(dirname(path as string))).toBe(tmpDir);
    await mapping.cleanup();
  });

  test("a failed write degrades to a marker and leaves no directory behind", async () => {
    const missing = join(freshTmpDir(), "does-not-exist");
    const mapping = userContentToCodexInput(imageTurn(PNG_A), {
      tmpDir: missing,
    });

    expect(mapping.input).toEqual([
      { type: "text", text: "[image: image/png (write failed)]" },
      { type: "text", text: "describe" },
    ]);
    await mapping.cleanup();
    expect(existsSync(missing)).toBe(false);
  });

  test("a write that fails after the directory is made keeps only an empty directory until cleanup", async () => {
    const tmpDir = freshTmpDir();
    // A 300-character prefix makes the file name too long for the file system.
    const mapping = userContentToCodexInput(imageTurn(PNG_A), {
      tmpDir,
      idPrefix: "x".repeat(300),
    });

    expect(mapping.input).toEqual([
      { type: "text", text: "[image: image/png (write failed)]" },
      { type: "text", text: "describe" },
    ]);
    expect(readdirSync(tmpDir)).toHaveLength(1);
    await mapping.cleanup();
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  test("a malformed part after an image throws and leaves no directory behind", () => {
    const tmpDir = freshTmpDir();
    const content = {
      role: "user",
      parts: [
        {
          inlineData: { mimeType: "image/png", data: PNG_A.toString("base64") },
        },
        { inlineData: { mimeType: 123, data: "x" } },
        {
          get text(): string {
            throw new Error("hostile part");
          },
        },
      ],
    } as unknown as Content;

    expect(() => userContentToCodexInput(content, { tmpDir })).toThrow(
      "hostile part",
    );
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  test("a non-string mime type becomes an octet-stream marker, not a crash", async () => {
    const tmpDir = freshTmpDir();
    const mapping = userContentToCodexInput(
      {
        role: "user",
        parts: [{ inlineData: { mimeType: 123, data: "x" } }, { text: "t" }],
      } as unknown as Content,
      { tmpDir },
    );
    expect(JSON.stringify(mapping.input)).toContain("application/octet-stream");
    await mapping.cleanup();
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  test("text-only turns create no directory", async () => {
    const tmpDir = freshTmpDir();
    const mapping = userContentToCodexInput(
      { role: "user", parts: [{ text: "a" }, { text: "b" }] },
      { tmpDir },
    );
    await mapping.cleanup();
    expect(readdirSync(tmpDir)).toEqual([]);
  });
});

type RunStreamed = (
  input: unknown,
  options: { signal?: AbortSignal },
) => Promise<{ events: AsyncIterable<Record<string, unknown>> }>;

function driverWith(runStreamed: RunStreamed): CodexSdkDriver {
  return new CodexSdkDriver({
    sdk: {
      startThread: () => ({ runStreamed }) as never,
      resumeThread: () => {
        throw new Error("not used");
      },
    },
  });
}

function imageRequest(abortSignal?: AbortSignal) {
  return {
    provider: CODEX_PROVIDER,
    // A session makes the driver collect the turn's parts, images included.
    context: {
      session: { events: [] },
      userContent: imageTurn(PNG_A),
    } as never,
    // The driver cannot turn off an injected sdk client's host MCP servers,
    // and network is off unless allowNetwork is true, so the run opts in.
    permissions: { mode: "read-only" as const, allowNetwork: true },
    abortSignal,
  };
}

async function collect(
  events: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const out: ExternalAgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("CodexSdkDriver temporary image cleanup", () => {
  test("removes the image directory after a successful run", async () => {
    let seen: string[] = [];
    const driver = driverWith(async (input) => {
      seen = imagePaths(input);
      expect(existsSync(seen[0] as string)).toBe(true);
      return {
        events: (async function* () {
          yield { type: "turn.completed", usage: { input_tokens: 1 } };
        })(),
      };
    });

    await collect(driver.run(imageRequest()));

    expect(seen).toHaveLength(1);
    expect(existsSync(dirname(seen[0] as string))).toBe(false);
  });

  test("removes the image directory when the run fails", async () => {
    let seen: string[] = [];
    const driver = driverWith(async (input) => {
      seen = imagePaths(input);
      throw new Error("boom");
    });

    const events = await collect(driver.run(imageRequest()));

    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(seen).toHaveLength(1);
    expect(existsSync(dirname(seen[0] as string))).toBe(false);
  });

  test("removes the image directory when the stream throws mid-turn", async () => {
    let seen: string[] = [];
    const driver = driverWith(async (input) => {
      seen = imagePaths(input);
      return {
        events: (async function* () {
          yield { type: "thread.started", thread_id: "t-1" };
          throw new Error("stream broke");
        })(),
      };
    });

    await collect(driver.run(imageRequest()));

    expect(seen).toHaveLength(1);
    expect(existsSync(dirname(seen[0] as string))).toBe(false);
  });

  test("removes the image directory when the run is aborted", async () => {
    const controller = new AbortController();
    let seen: string[] = [];
    const driver = driverWith(async (input, options) => {
      seen = imagePaths(input);
      return {
        events: (async function* () {
          yield { type: "thread.started", thread_id: "t-1" };
          await new Promise<void>((resolve) => {
            // The abort can fire before this listener is added.
            if (options.signal?.aborted) {
              resolve();
              return;
            }
            options.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          throw new DOMException("The operation was aborted.", "AbortError");
        })(),
      };
    });

    const run = collect(driver.run(imageRequest(controller.signal)));
    await Bun.sleep(0);
    controller.abort();
    await run;

    expect(seen).toHaveLength(1);
    expect(existsSync(dirname(seen[0] as string))).toBe(false);
  });

  test("removes the image directory when the caller stops reading early", async () => {
    let seen: string[] = [];
    const driver = driverWith(async (input) => {
      seen = imagePaths(input);
      return {
        events: (async function* () {
          yield {
            type: "item.completed",
            item: { id: "i-1", type: "agent_message", text: "first" },
          };
          yield {
            type: "item.completed",
            item: { id: "i-2", type: "agent_message", text: "second" },
          };
          yield { type: "turn.completed", usage: { input_tokens: 1 } };
        })(),
      };
    });

    for await (const event of driver.run(imageRequest())) {
      if (event.type === "output") break;
    }

    expect(seen).toHaveLength(1);
    expect(existsSync(dirname(seen[0] as string))).toBe(false);
  });
});
