/**
 * MCP secrets: whether a run can keep them from the agent (per platform,
 * with injected platform and `/proc` reader), resolution, and the scrubber.
 */

import { describe, expect, test } from "bun:test";
import {
  type CheckedMcpServer,
  checkClaudeMcpServers,
} from "../../../src/agents/driver/claude-mcp-servers.js";
import {
  checkMcpSecretsEnforceable,
  envReadableReason,
  isDebugSwitch,
  type McpSecretRunContext,
  REDACTED,
  resolveMcpSecrets,
  SecretScrubber,
} from "../../../src/agents/driver/mcp-secrets.js";
import {
  EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
  EXTERNAL_AGENT_MCP_SECRET_UNRESOLVED,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";

const CANARY = "canary-7f3a9c2e-secret";

function servers(value: Record<string, unknown>): readonly CheckedMcpServer[] {
  return checkClaudeMcpServers(value);
}

const resolveHeader = servers({
  docs: {
    type: "http",
    url: "http://127.0.0.1:1/",
    headers: { Authorization: { resolve: () => CANARY, prefix: "Bearer " } },
  },
});
const envHeader = servers({
  docs: {
    type: "http",
    url: "http://127.0.0.1:1/",
    headers: { Authorization: { env: "DOCS_TOKEN" } },
  },
});
const stdioResolveEnv = servers({
  proc: {
    type: "stdio",
    command: "/bin/x",
    env: { API_TOKEN: { resolve: () => CANARY } },
  },
});
const publicOnly = servers({
  docs: {
    type: "http",
    url: "http://127.0.0.1:1/",
    headers: { Accept: { public: "application/json" } },
  },
  proc: { type: "stdio", command: "/bin/x", env: { MODE: { public: "x" } } },
});

function run(extra: Partial<McpSecretRunContext> = {}): McpSecretRunContext {
  return {
    platform: "darwin",
    shellOffered: false,
    shellSandboxed: true,
    fileReadOffered: false,
    policy: undefined,
    workingDirectory: "/work",
    readPtraceScope: () => "1",
    childEnv: {},
    ...extra,
  };
}

function refusal(fn: () => unknown): ExternalAgentPolicyError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalAgentPolicyError);
    const policy = error as ExternalAgentPolicyError;
    expect(policy.code).toBe(EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE);
    return policy;
  }
  throw new Error("expected EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE");
}

describe("envReadable", () => {
  test("a shell reads process environments except on macOS", () => {
    expect(envReadableReason(run({ shellOffered: true }))).toBeUndefined();
    for (const platform of ["linux", "win32", "freebsd"] as const) {
      expect(
        envReadableReason(run({ platform, shellOffered: true })),
      ).toContain("shell");
    }
  });

  test("the macOS exemption needs the no-network sandbox", () => {
    expect(
      envReadableReason(run({ shellOffered: true, shellSandboxed: false })),
    ).toContain("without Claude Code's no-network sandbox");
    // No shell: nothing to sandbox.
    expect(envReadableReason(run({ shellSandboxed: false }))).toBeUndefined();
  });

  test("on Linux a file-read tool without confinement away from /proc", () => {
    const linux = { platform: "linux" as const, fileReadOffered: true };
    expect(envReadableReason(run(linux))).toContain("/proc");
    // readPaths alone does not confine reads.
    expect(
      envReadableReason(
        run({
          ...linux,
          policy: { mode: "workspace-write", readPaths: ["/"] },
        }),
      ),
    ).toContain("/proc");
    expect(
      envReadableReason(
        run({
          ...linux,
          policy: {
            mode: "workspace-write",
            allowedPaths: ["/work"],
            readPaths: ["/opt/docs"],
          },
        }),
      ),
    ).toBeUndefined();
    for (const root of ["/", "/proc", "/proc/self"]) {
      expect(
        envReadableReason(
          run({
            ...linux,
            policy: {
              mode: "workspace-write",
              allowedPaths: ["/work"],
              readPaths: [root],
            },
          }),
        ),
      ).toContain("/proc");
    }
    expect(
      envReadableReason(
        run({
          ...linux,
          workingDirectory: "/",
          policy: { mode: "workspace-write", allowedPaths: ["/work"] },
        }),
      ),
    ).toContain("/proc");
    // macOS and Windows have no /proc term.
    expect(
      envReadableReason(run({ platform: "darwin", fileReadOffered: true })),
    ).toBeUndefined();
    expect(
      envReadableReason(run({ platform: "win32", fileReadOffered: true })),
    ).toBeUndefined();
  });
});

describe("enforceability", () => {
  test("{ env } with a readable environment is refused", () => {
    const error = refusal(() =>
      checkMcpSecretsEnforceable(
        envHeader,
        run({
          platform: "linux",
          shellOffered: true,
          readPtraceScope: () => "1",
        }),
      ),
    );
    expect(error.message).toContain("{ resolve }");
    refusal(() =>
      checkMcpSecretsEnforceable(
        envHeader,
        run({ platform: "linux", fileReadOffered: true }),
      ),
    );
  });

  test("{ env } is accepted on macOS with a shell (env hidden)", () => {
    expect(() =>
      checkMcpSecretsEnforceable(envHeader, run({ shellOffered: true })),
    ).not.toThrow();
  });

  test("a stdio env secret with a readable environment is refused, even { resolve }", () => {
    refusal(() =>
      checkMcpSecretsEnforceable(
        stdioResolveEnv,
        run({ platform: "linux", shellOffered: true }),
      ),
    );
  });

  test("a { resolve } header with a shell is accepted where memory is safe", () => {
    expect(() =>
      checkMcpSecretsEnforceable(
        resolveHeader,
        run({
          platform: "linux",
          shellOffered: true,
          readPtraceScope: () => "1",
        }),
      ),
    ).not.toThrow();
    expect(() =>
      checkMcpSecretsEnforceable(resolveHeader, run({ shellOffered: true })),
    ).not.toThrow();
  });

  test("Linux ptrace_scope 0 or missing with a shell refuses any secret", () => {
    for (const scope of ["0", undefined]) {
      const error = refusal(() =>
        checkMcpSecretsEnforceable(
          resolveHeader,
          run({
            platform: "linux",
            shellOffered: true,
            readPtraceScope: () => scope,
          }),
        ),
      );
      expect(error.message).toContain("Linux ptrace_scope is 0");
    }
    for (const scope of ["1", "2", "3"]) {
      expect(() =>
        checkMcpSecretsEnforceable(
          resolveHeader,
          run({
            platform: "linux",
            shellOffered: true,
            readPtraceScope: () => scope,
          }),
        ),
      ).not.toThrow();
    }
  });

  test("ptrace is not checked without a shell, nor on macOS", () => {
    let reads = 0;
    const readPtraceScope = () => {
      reads++;
      return "0";
    };
    expect(() =>
      checkMcpSecretsEnforceable(
        resolveHeader,
        run({ platform: "linux", readPtraceScope }),
      ),
    ).not.toThrow();
    expect(() =>
      checkMcpSecretsEnforceable(
        resolveHeader,
        run({ shellOffered: true, readPtraceScope }),
      ),
    ).not.toThrow();
    expect(reads).toBe(0);
  });

  test("Windows with a shell refuses any secret", () => {
    const error = refusal(() =>
      checkMcpSecretsEnforceable(
        resolveHeader,
        run({ platform: "win32", shellOffered: true }),
      ),
    );
    expect(error.message).toContain(
      "Windows: same-user processes can read process memory",
    );
    expect(() =>
      checkMcpSecretsEnforceable(resolveHeader, run({ platform: "win32" })),
    ).not.toThrow();
  });

  test("servers without a secret pass everywhere", () => {
    for (const platform of ["linux", "win32", "darwin"] as const) {
      expect(() =>
        checkMcpSecretsEnforceable(
          publicOnly,
          run({
            platform,
            shellOffered: true,
            fileReadOffered: true,
            readPtraceScope: () => "0",
            childEnv: { DEBUG: "*" },
          }),
        ),
      ).not.toThrow();
    }
  });

  test("a debug switch in the child environment refuses a secret", () => {
    for (const name of [
      "DEBUG",
      "ANTHROPIC_LOG",
      "CLAUDE_DEBUG",
      "CLAUDE_CODE_DEBUG_X",
      "CLAUDE_CODE_DEBUG_LOGS_DIR",
      "debug",
    ]) {
      const error = refusal(() =>
        checkMcpSecretsEnforceable(
          resolveHeader,
          run({ childEnv: { [name]: "1" } }),
        ),
      );
      expect(error.message).toContain(name);
      expect(error.message).toContain("Remove the debug variable");
    }
    expect(() =>
      checkMcpSecretsEnforceable(
        resolveHeader,
        run({ childEnv: { DEBUG: undefined, NODE_ENV: "x" } }),
      ),
    ).not.toThrow();
  });

  test("isDebugSwitch names", () => {
    expect(isDebugSwitch("CLAUDE_CODE_DEBUG")).toBe(true);
    expect(isDebugSwitch("DEBUGGER")).toBe(false);
    expect(isDebugSwitch("MY_DEBUG")).toBe(false);
  });
});

async function resolveRejects(
  value: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
  signal: AbortSignal = new AbortController().signal,
  timeoutMs?: number,
): Promise<ExternalAgentPolicyError> {
  try {
    await resolveMcpSecrets(servers(value), {
      env,
      signal,
      scrubber: new SecretScrubber(),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalAgentPolicyError);
    expect((error as ExternalAgentPolicyError).code).toBe(
      EXTERNAL_AGENT_MCP_SECRET_UNRESOLVED,
    );
    return error as ExternalAgentPolicyError;
  }
  throw new Error("expected EXTERNAL_AGENT_MCP_SECRET_UNRESOLVED");
}

const header = (value: unknown) => ({
  docs: {
    type: "http",
    url: "http://127.0.0.1:1/",
    headers: { Authorization: value },
  },
});

describe("resolution", () => {
  test("reads { resolve }, { env } and { public } values, prefix joined", async () => {
    const scrubber = new SecretScrubber();
    const seen: unknown[] = [];
    const resolved = await resolveMcpSecrets(
      servers({
        docs: {
          type: "http",
          url: "http://127.0.0.1:1/",
          headers: {
            Authorization: {
              prefix: "Bearer ",
              resolve: (context: unknown) => {
                seen.push(context);
                return CANARY;
              },
            },
            "X-Api-Key": { env: "DOCS_KEY" },
            Accept: { public: "application/json" },
          },
        },
        proc: {
          type: "stdio",
          command: "/bin/x",
          env: { MODE: { public: "fast" } },
        },
      }),
      {
        env: { DOCS_KEY: "env-value-123" },
        signal: new AbortController().signal,
        scrubber,
      },
    );
    expect(resolved).toEqual([
      {
        name: "docs",
        headers: {
          Authorization: `Bearer ${CANARY}`,
          "X-Api-Key": "env-value-123",
          Accept: "application/json",
        },
      },
      { name: "proc", env: { MODE: "fast" } },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      server: "docs",
      field: "header",
      key: "Authorization",
    });
    expect(scrubber.scrub(`a ${CANARY} b env-value-123`)).toBe(
      `a ${REDACTED} b ${REDACTED}`,
    );
    // Public values are not secrets.
    expect(scrubber.scrub("application/json fast")).toBe(
      "application/json fast",
    );
  });

  test("{ env } missing or empty", async () => {
    expect((await resolveRejects(header({ env: "NOPE" }))).message).toContain(
      "NOPE is missing or empty",
    );
    await resolveRejects(header({ env: "EMPTY" }), { EMPTY: "" });
  });

  test("too short, too long, CR, LF or NUL", async () => {
    for (const value of [
      "q7z1x",
      "x".repeat(8193),
      "abcdefgh\r\nX-Injected: 1",
      "abcdefgh\nmore",
      "abcdefgh\u0000",
    ]) {
      const error = await resolveRejects(header({ resolve: () => value }));
      expect(error.message).not.toContain(value);
    }
    expect(
      (await resolveRejects(header({ env: "E" }), { E: "1234567" })).message,
    ).toContain("shorter than 8");
  });

  test("a resolver that throws: its text is never quoted", async () => {
    const error = await resolveRejects(
      header({
        resolve: () => {
          throw new Error(`failed for ${CANARY}`);
        },
      }),
    );
    expect(error.message).toContain("resolver threw");
    expect(error.message).not.toContain(CANARY);
    expect(error.message).toContain("docs");
    expect(error.message).toContain("Authorization");
  });

  test("a resolver that rejects or returns a non-string", async () => {
    await resolveRejects(
      header({ resolve: () => Promise.reject(new Error(CANARY)) }),
    );
    await resolveRejects(header({ resolve: () => 12345678 as never }));
    await resolveRejects(header({ resolve: () => undefined as never }));
  });

  test("a resolver that times out is aborted", async () => {
    let aborted = false;
    const error = await resolveRejects(
      header({
        resolve: ({ signal }: { signal: AbortSignal }) =>
          new Promise<string>((resolveValue) => {
            signal.addEventListener("abort", () => {
              aborted = true;
            });
            setTimeout(() => resolveValue(CANARY), 5000);
          }),
      }),
      {},
      new AbortController().signal,
      50,
    );
    expect(error.message).toContain("longer than 50 ms");
    expect(aborted).toBe(true);
  });

  test("an aborted run stops the resolver", async () => {
    const controller = new AbortController();
    let aborted = false;
    const pending = resolveRejects(
      header({
        resolve: ({ signal }: { signal: AbortSignal }) =>
          new Promise<string>(() => {
            signal.addEventListener("abort", () => {
              aborted = true;
            });
          }),
      }),
      {},
      controller.signal,
    );
    setTimeout(() => controller.abort(), 10);
    expect((await pending).message).toContain("aborted");
    expect(aborted).toBe(true);
    const before = new AbortController();
    before.abort();
    let called = false;
    await resolveRejects(
      header({
        resolve: () => {
          called = true;
          return CANARY;
        },
      }),
      {},
      before.signal,
    );
    expect(called).toBe(false);
  });
});

describe("secrets the runtime's own environment holds", () => {
  const envRef = checkClaudeMcpServers({
    docs: {
      type: "http",
      url: "http://127.0.0.1:1/",
      headers: { Authorization: { env: "SHARED_TOKEN" } },
    },
  });

  test("an { env } name that is also in the child env is refused", () => {
    expect(
      refusal(() =>
        checkMcpSecretsEnforceable(
          envRef,
          run({ childEnv: { SHARED_TOKEN: "value-in-child" } }),
        ),
      ).message,
    ).toContain("runtime's own environment");
    expect(() =>
      checkMcpSecretsEnforceable(
        envRef,
        run({ childEnv: { SHARED_TOKEN: "" } }),
      ),
    ).not.toThrow();
  });

  test("a resolved value found in a child env value is refused, unquoted", async () => {
    const value = "resolved-secret-123";
    const servers = checkClaudeMcpServers({
      docs: {
        type: "http",
        url: "http://127.0.0.1:1/",
        headers: { Authorization: { resolve: () => value } },
      },
    });
    let caught: unknown;
    try {
      await resolveMcpSecrets(servers, {
        env: {},
        childEnv: { ANTHROPIC_API_KEY: `x${value}y` },
        signal: new AbortController().signal,
        scrubber: new SecretScrubber(),
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as ExternalAgentPolicyError).code).toBe(
      EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
    );
    expect(String((caught as Error).message)).not.toContain(value);
    await expect(
      resolveMcpSecrets(servers, {
        env: {},
        childEnv: { OTHER: "unrelated" },
        signal: new AbortController().signal,
        scrubber: new SecretScrubber(),
      }),
    ).resolves.toHaveLength(1);
  });
});

describe("SecretScrubber", () => {
  const scrubber = new SecretScrubber();
  scrubber.add(CANARY);
  // A value whose encoded forms differ from the raw one.
  const ODD = 'tok+/en="q"&x?ä';
  scrubber.add(ODD);

  const forms: [string, string][] = [
    ["raw", CANARY],
    ["encodeURIComponent", encodeURIComponent(ODD)],
    // ODD's base64 has padding and both + and /, so the four base64 forms
    // all differ.
    ["base64", Buffer.from(ODD).toString("base64")],
    ["base64 unpadded", Buffer.from(ODD).toString("base64").replace(/=+$/, "")],
    ["base64url", Buffer.from(ODD).toString("base64url")],
    [
      "base64url padded",
      Buffer.from(ODD)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_"),
    ],
    ["JSON-escaped", JSON.stringify(ODD).slice(1, -1)],
    [
      "JSON-escaped twice",
      JSON.stringify(JSON.stringify(ODD).slice(1, -1)).slice(1, -1),
    ],
  ];
  test("the base64 forms of the odd value all differ", () => {
    const base64 = forms.filter(([label]) => label.startsWith("base64"));
    expect(new Set(base64.map(([, form]) => form)).size).toBe(4);
  });
  for (const [label, form] of forms) {
    test(`redacts the ${label} form`, () => {
      expect(scrubber.scrub(`<${form}>`)).toBe(`<${REDACTED}>`);
    });
  }

  test("scrubDeep copies arrays and plain objects, keys too, cycle-safe", () => {
    const value: Record<string, unknown> = {
      a: [CANARY, { b: `x${CANARY}y` }],
      [CANARY]: 1,
      n: 5,
      error: new Error(`boom ${CANARY}`),
    };
    value.self = value;
    const { value: out, changed } = scrubber.scrubDeep(value);
    expect(changed).toBe(true);
    const text = JSON.stringify({ ...out, self: undefined });
    expect(text).not.toContain(CANARY);
    expect((out as Record<string, unknown>).self).toBe(out);
    expect(((out as Record<string, unknown>).error as Error).message).toBe(
      `boom ${REDACTED}`,
    );
    expect(value.a).toEqual([CANARY, { b: `x${CANARY}y` }]);
  });

  test("scrubDeep returns the same value when nothing changed", () => {
    const value = { a: ["clean"] };
    const result = scrubber.scrubDeep(value);
    expect(result.changed).toBe(false);
    expect(result.value).toBe(value);
  });

  test("clear forgets every secret", () => {
    const local = new SecretScrubber();
    local.add(CANARY);
    expect(local.active).toBe(true);
    local.clear();
    expect(local.active).toBe(false);
    expect(local.scrub(CANARY)).toBe(CANARY);
  });
});
