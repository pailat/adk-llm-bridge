/**
 * Declared MCP servers: construction checks (names, shape, URL grammar,
 * secret literals), run-time stdio and network checks, and
 * `selectMcpServers`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_MCP_SERVER_NAME_PATTERN,
  checkClaudeMcpServers,
  checkMcpServerNetwork,
  checkStdioServerForRun,
  isCodeLoadingEnvName,
  MCP_STDIO_CODE_ENV_NAMES,
  MCP_STDIO_LAUNCHERS,
  parseMcpServerUrl,
  selectMcpServers,
  stdioArgForm,
} from "../../../src/agents/driver/claude-mcp-servers.js";
import {
  EXTERNAL_AGENT_MCP_PROVIDER_UNKNOWN,
  EXTERNAL_AGENT_MCP_SECRET_LITERAL,
  EXTERNAL_AGENT_MCP_SERVER_INVALID,
  EXTERNAL_AGENT_MCP_SERVER_NETWORK_REQUIRED,
  EXTERNAL_AGENT_MCP_STDIO_UNSAFE,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import { RunSpecAgentSchema } from "../../../src/workflows/spec/index.js";

const POSIX = process.platform !== "win32";

function policyCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalAgentPolicyError);
    return (error as ExternalAgentPolicyError).code;
  }
  throw new Error("expected a policy error");
}

function policyMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected an error");
}

const RESOLVE = { resolve: () => "s3cr3t-value" };
const http = (url: string, extra: Record<string, unknown> = {}) => ({
  docs: { type: "http", url, ...extra },
});

describe("server names", () => {
  test("names follow the provider-id grammar", () => {
    for (const name of ["reui", "a", "a-b", "a_b", "A1-b2_c3"]) {
      expect(() =>
        checkClaudeMcpServers({
          [name]: { type: "http", url: "http://127.0.0.1:1/" },
        }),
      ).not.toThrow();
    }
    for (const name of [
      "",
      "a__b",
      "a--b",
      "-a",
      "a-",
      "a.b",
      "a b",
      "a/b",
      "a:b",
      "x".repeat(65),
    ]) {
      expect(
        policyCode(() =>
          checkClaudeMcpServers({
            [name]: { type: "http", url: "http://127.0.0.1:1/" },
          }),
        ),
      ).toBe(EXTERNAL_AGENT_MCP_SERVER_INVALID);
    }
  });

  test("adk_bridge is reserved in any case", () => {
    for (const name of ["adk_bridge", "ADK_BRIDGE", "Adk_Bridge"]) {
      expect(
        policyMessage(() =>
          checkClaudeMcpServers({
            [name]: { type: "http", url: "http://127.0.0.1:1/" },
          }),
        ),
      ).toContain("reserved");
    }
  });

  test("a case-folded duplicate is refused", () => {
    expect(
      policyMessage(() =>
        checkClaudeMcpServers({
          Docs: { type: "http", url: "http://127.0.0.1:1/" },
          docs: { type: "http", url: "http://127.0.0.1:2/" },
        }),
      ),
    ).toContain("twice");
  });

  test("at most 16 servers", () => {
    const servers = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `s${i}`,
          { type: "http", url: "http://127.0.0.1:1/" },
        ]),
      );
    expect(checkClaudeMcpServers(servers(16))).toHaveLength(16);
    expect(policyCode(() => checkClaudeMcpServers(servers(17)))).toBe(
      EXTERNAL_AGENT_MCP_SERVER_INVALID,
    );
  });

  test("the name grammar matches the run spec MCP provider id grammar", () => {
    const samples = [
      "reui",
      "a-b",
      "a_b",
      "a__b",
      "a--b",
      "-a",
      "a-",
      "a.b",
      "A1",
      "x".repeat(64),
      "x".repeat(65),
      "é",
      "a b",
    ];
    for (const id of samples) {
      const spec = RunSpecAgentSchema.shape.mcp.safeParse([id]).success;
      const ours = id.length <= 64 && CLAUDE_MCP_SERVER_NAME_PATTERN.test(id);
      expect({ id, ours }).toEqual({ id, ours: spec });
    }
  });
});

describe("server shape", () => {
  const invalid: [string, unknown][] = [
    ["not an object", "http://127.0.0.1:1/"],
    ["an array", []],
    ["a class instance", new (class {})()],
    ["mcpServers itself an array", undefined],
    ["unknown type", { type: "ws", url: "http://127.0.0.1:1/" }],
    ["no type", { url: "http://127.0.0.1:1/" }],
    ["unknown key", { type: "http", url: "http://127.0.0.1:1/", extra: 1 }],
    [
      "http with command",
      { type: "http", url: "http://127.0.0.1:1/", command: "/bin/x" },
    ],
    ["stdio with url", { type: "stdio", command: "/bin/x", url: "x" }],
    ["url not a string", { type: "http", url: 1 }],
    [
      "tools not an array",
      { type: "http", url: "http://127.0.0.1:1/", tools: "a" },
    ],
    [
      "tool with a dot",
      { type: "http", url: "http://127.0.0.1:1/", tools: ["a.b"] },
    ],
    [
      "duplicate tool",
      { type: "http", url: "http://127.0.0.1:1/", tools: ["a", "a"] },
    ],
    [
      "tool too long",
      { type: "http", url: "http://127.0.0.1:1/", tools: ["a".repeat(65)] },
    ],
    [
      "readOnly without tools",
      { type: "http", url: "http://127.0.0.1:1/", readOnly: true },
    ],
    [
      "readOnly with empty tools",
      { type: "http", url: "http://127.0.0.1:1/", readOnly: true, tools: [] },
    ],
    [
      "readOnly not a boolean",
      { type: "http", url: "http://127.0.0.1:1/", readOnly: "yes" },
    ],
    [
      "timeoutMs too small",
      { type: "http", url: "http://127.0.0.1:1/", timeoutMs: 999 },
    ],
    [
      "timeoutMs too large",
      { type: "http", url: "http://127.0.0.1:1/", timeoutMs: 600_001 },
    ],
    [
      "timeoutMs not an integer",
      { type: "http", url: "http://127.0.0.1:1/", timeoutMs: 1000.5 },
    ],
    ["relative command", { type: "stdio", command: "bin/server" }],
    ["bare command", { type: "stdio", command: "server" }],
    ["args not strings", { type: "stdio", command: "/bin/x", args: [1] }],
    [
      "header name not a token",
      {
        type: "http",
        url: "http://127.0.0.1:1/",
        headers: { "X Bad": { public: "v" } },
      },
    ],
    [
      "header names duplicated ignoring case",
      {
        type: "http",
        url: "http://127.0.0.1:1/",
        headers: { "X-A": { public: "v" }, "x-a": { public: "w" } },
      },
    ],
    [
      "env name invalid",
      { type: "stdio", command: "/bin/x", env: { "1A": { public: "v" } } },
    ],
    [
      "value with two kinds",
      {
        type: "http",
        url: "http://127.0.0.1:1/",
        headers: { Authorization: { env: "A", resolve: () => "x" } },
      },
    ],
    [
      "value with an unknown key",
      {
        type: "http",
        url: "http://127.0.0.1:1/",
        headers: { Authorization: { env: "A", extra: 1 } },
      },
    ],
    [
      "resolve not a function",
      {
        type: "http",
        url: "http://127.0.0.1:1/",
        headers: { Authorization: { resolve: "x" } },
      },
    ],
    [
      "env ref not a variable name",
      {
        type: "http",
        url: "http://127.0.0.1:1/",
        headers: { Authorization: { env: "A-B" } },
      },
    ],
    [
      "prefix with CRLF",
      {
        type: "http",
        url: "http://127.0.0.1:1/",
        headers: { Authorization: { env: "A", prefix: "Bearer\r\n" } },
      },
    ],
    [
      "public value with LF",
      {
        type: "http",
        url: "http://127.0.0.1:1/",
        headers: { "X-Mode": { public: "a\nb" } },
      },
    ],
  ];
  for (const [label, server] of invalid) {
    test(`refused: ${label}`, () => {
      const value =
        label === "mcpServers itself an array" ? [] : { docs: server };
      expect(policyCode(() => checkClaudeMcpServers(value))).toBe(
        EXTERNAL_AGENT_MCP_SERVER_INVALID,
      );
    });
  }

  test("a null-prototype config is accepted and frozen", () => {
    const servers = Object.assign(Object.create(null), {
      docs: { type: "sse", url: "http://127.0.0.1:1/", tools: ["a"] },
    });
    const [checked] = checkClaudeMcpServers(servers);
    expect(Object.isFrozen(checked)).toBe(true);
    expect(checked).toMatchObject({
      name: "docs",
      type: "sse",
      readOnly: false,
      tools: ["a"],
    });
  });
});

describe("secret literals", () => {
  test("a bare string header or env value is refused", () => {
    expect(
      policyCode(() =>
        checkClaudeMcpServers(
          http("http://127.0.0.1:1/", {
            headers: { "X-Mode": "plain" },
          }),
        ),
      ),
    ).toBe(EXTERNAL_AGENT_MCP_SECRET_LITERAL);
    expect(
      policyCode(() =>
        checkClaudeMcpServers({
          s: { type: "stdio", command: "/bin/x", env: { MODE: "plain" } },
        }),
      ),
    ).toBe(EXTERNAL_AGENT_MCP_SECRET_LITERAL);
  });

  test("a { public } value under a sensitive name is refused", () => {
    for (const name of [
      "Authorization",
      "authorization",
      "Proxy-Authorization",
      "Cookie",
      "X-Api-Key",
      "X-Auth-Token",
      "X-Session-Id",
      "X-Secret",
      "X-Credential",
      "X-Passwd",
      "X-Password",
      "Api-Key",
    ]) {
      expect(
        policyCode(() =>
          checkClaudeMcpServers(
            http("http://127.0.0.1:1/", {
              headers: { [name]: { public: "value" } },
            }),
          ),
        ),
      ).toBe(EXTERNAL_AGENT_MCP_SECRET_LITERAL);
    }
    for (const name of ["API_TOKEN", "DB_PASSWORD", "AWS_SECRET", "MY_KEY"]) {
      expect(
        policyCode(() =>
          checkClaudeMcpServers({
            s: {
              type: "stdio",
              command: "/bin/x",
              env: { [name]: { public: "value" } },
            },
          }),
        ),
      ).toBe(EXTERNAL_AGENT_MCP_SECRET_LITERAL);
    }
  });

  test("a { public } value under a plain name, and refs anywhere, pass", () => {
    expect(() =>
      checkClaudeMcpServers(
        http("http://127.0.0.1:1/", {
          headers: {
            Accept: { public: "application/json" },
            Authorization: { ...RESOLVE, prefix: "Bearer " },
            "X-Api-Key": { env: "DOCS_KEY" },
          },
        }),
      ),
    ).not.toThrow();
  });
});

describe("URL grammar", () => {
  const accepted: [string, boolean][] = [
    ["http://127.0.0.1:8080/mcp", true],
    ["http://127.255.255.254/", true],
    ["http://[::1]:1/", true],
    ["https://127.0.0.1/mcp", true],
    ["http://127.0.0.1", true],
    ["https://example.com/mcp", false],
    ["https://10.0.0.5:8443/mcp", false],
    ["https://[2001:db8::1]/", false],
    ["https://mcp.example.com:65535/a/b", false],
  ];
  for (const [url, loopback] of accepted) {
    test(`accepted: ${url}`, () => {
      const parsed = parseMcpServerUrl(url);
      expect(typeof parsed).toBe("object");
      expect(parsed).toMatchObject({ loopback });
    });
  }

  test("the given href is passed on unchanged", () => {
    for (const url of [
      "http://127.0.0.1:8080/mcp",
      "http://[::1]:1/",
      "https://example.com/mcp",
    ]) {
      const [checked] = checkClaudeMcpServers(http(url));
      expect(checked).toMatchObject({ url });
    }
    // A URL without a path gets the canonical `/`.
    const [bare] = checkClaudeMcpServers(http("http://127.0.0.1:9"));
    expect(bare).toMatchObject({ url: "http://127.0.0.1:9/" });
  });

  const refused = [
    "http://0x7f.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://127.000.0.1/",
    "http://127.0.0.01/",
    "http://localhost/",
    "http://0.0.0.0/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::127.0.0.1]/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[::1%lo0]/",
    "http://[::1%25lo0]/",
    "http://127.0.0.1./",
    "http://user@127.0.0.1/",
    "http://user:pw@127.0.0.1/",
    "http://127.0.0.1/?k=v",
    "http://127.0.0.1/#f",
    "http://127.0.0.1/%2e%2e",
    "http://127.0.0.1/a b",
    "http://example.com/",
    "http://127.0.0.1:0/",
    "http://127.0.0.1:65536/",
    "http://127.0.0.1:080/",
    "HTTP://127.0.0.1/",
    "ftp://127.0.0.1/",
    "https://[2001:0db8::1]/",
    "https://[2001:DB8::1]/",
    "https://0.0.0.0/",
    "https://0.1.2.3/",
    "https://[::]/",
    "https://[::ffff:7f00:1]/",
    "https://[::7f00:1]/",
    "https://localhost/",
    "https://a.localhost/",
    "https://2130706433/",
    "https://0x7f.1/",
    "https://127.1/",
    "https://127.0.0.1.nip.io./",
    "https://example.com./",
    "https://-a.example.com/",
    "https://exa_mple.com/",
  ];
  test("the raw grammar refuses non-canonical loopback octets itself", () => {
    for (const url of ["http://127.000.0.1/", "http://127.0.0.01/"]) {
      expect(parseMcpServerUrl(url)).toContain("https unless");
    }
  });
  for (const url of refused) {
    test(`refused: ${url}`, () => {
      expect(typeof parseMcpServerUrl(url)).toBe("string");
      expect(policyCode(() => checkClaudeMcpServers(http(url)))).toBe(
        EXTERNAL_AGENT_MCP_SERVER_INVALID,
      );
    });
  }

  test("127.x.x.x is never remote", () => {
    expect(parseMcpServerUrl("https://127.0.0.2/")).toMatchObject({
      loopback: true,
    });
    expect(typeof parseMcpServerUrl("https://127.0.0.1.:1/")).toBe("string");
  });
});

describe("network check", () => {
  const servers = checkClaudeMcpServers({
    local: { type: "http", url: "http://127.0.0.1:1/" },
    remote: { type: "http", url: "https://10.0.0.5/" },
  });

  test("a remote server needs allowNetwork: true", () => {
    expect(() =>
      checkMcpServerNetwork(servers, {
        mode: "workspace-write",
        allowNetwork: true,
      }),
    ).not.toThrow();
    for (const policy of [
      undefined,
      { mode: "workspace-write" as const },
      { mode: "workspace-write" as const, allowNetwork: false },
    ]) {
      const message = policyMessage(() =>
        checkMcpServerNetwork(servers, policy),
      );
      expect(message).toContain("remote");
      expect(policyCode(() => checkMcpServerNetwork(servers, policy))).toBe(
        EXTERNAL_AGENT_MCP_SERVER_NETWORK_REQUIRED,
      );
    }
  });

  test("loopback and stdio servers pass with the network off", () => {
    expect(() =>
      checkMcpServerNetwork(
        checkClaudeMcpServers({
          local: { type: "http", url: "http://127.0.0.1:1/" },
          six: { type: "sse", url: "http://[::1]:2/" },
          proc: { type: "stdio", command: "/bin/x" },
        }),
        { mode: "workspace-write" },
      ),
    ).not.toThrow();
  });
});

describe("stdio argument forms", () => {
  const ok = ["-v", "-I", "--flag", "--port=8080", "--", "--x=", "--a-b=c"];
  for (const arg of ok) {
    test(`accepted: ${arg}`, () => {
      expect(stdioArgForm(arg)).toEqual({});
    });
  }
  test("accepted with a path: an absolute path and --flag=/abs", () => {
    expect(stdioArgForm("/host/abs")).toEqual({ path: "/host/abs" });
    expect(stdioArgForm("--config=/host/abs")).toEqual({
      path: "/host/abs",
    });
  });

  const refused = [
    "server.py",
    "8080",
    "a/b",
    "./x",
    "-",
    "-m",
    "-mmod",
    "-M",
    "-Mfoo",
    "-M/x",
    "-I/work/lib",
    "-r",
    "-rfoo",
    "-e",
    "-c",
    "-p",
    "-Ec",
    "-Ecimport os",
    "-jar",
    "--require",
    "--require=x",
    "--eval",
    "--eval=1",
    "--print",
    "--import=x",
    "--loader=x",
    "--experimental-loader=x",
    "--inspect",
    "--inspect=9229",
    "--inspect-brk",
    "--inspect-port=1",
    "--inspect-wait",
    "--inspect-publish-uid=http",
    "--config=rel/x",
    "--config=./x",
    "--a/b",
    "--x=a\\b",
    "-\u0000",
    "--x=\n",
  ];
  for (const arg of refused) {
    test(`refused: ${JSON.stringify(arg)}`, () => {
      expect(stdioArgForm(arg)).toHaveProperty("refused");
    });
  }

  test("a lone dash is refused as code from stdin", () => {
    expect(stdioArgForm("-")).toEqual({ refused: "reads code from stdin" });
  });
});

describe("code-loading env names", () => {
  for (const name of MCP_STDIO_CODE_ENV_NAMES) {
    test(`refused: ${name}`, () => {
      expect(isCodeLoadingEnvName(name)).toBe(true);
      expect(isCodeLoadingEnvName(name.toLowerCase())).toBe(true);
    });
  }
  test("refused by prefix, any case", () => {
    for (const name of [
      "LD_PRELOAD",
      "ld_preload",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "dyld_library_path",
      "GIT_SSH_COMMAND",
      "GIT_CONFIG_GLOBAL",
    ]) {
      expect(isCodeLoadingEnvName(name)).toBe(true);
    }
  });
  test("plain names pass", () => {
    for (const name of ["MODE", "API_URL", "PATHS", "LOG_LEVEL", "NODE_ENV"]) {
      expect(isCodeLoadingEnvName(name)).toBe(false);
    }
  });
});

// Host-owned fixtures: next to this file, not in the temp directory, which
// a runtime sandbox keeps writable and the driver therefore refuses.
const scratch = realpathSync.native(
  mkdtempSync(join(import.meta.dir, ".host-scratch-")),
);
const tempScratch = realpathSync.native(mkdtempSync(join(tmpdir(), "mcp-")));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(tempScratch, { recursive: true, force: true });
});

function executable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(!POSIX)("stdio run-time checks", () => {
  const host = join(scratch, "host");
  const work = join(scratch, "work");
  const allowed = join(scratch, "allowed");
  mkdirSync(work, { recursive: true });
  mkdirSync(allowed, { recursive: true });
  const server = executable(host, "mcp-server");
  const config = join(host, "config.json");
  writeFileSync(config, "{}");
  const roots = [work, allowed, tempScratch];
  // Existing files, so the root check (not the existence check) refuses them.
  const inWork = join(work, "x.json");
  const inAllowed = join(allowed, "y.json");
  writeFileSync(inWork, "{}");
  writeFileSync(inAllowed, "{}");

  const check = (
    command: string,
    args: string[] = [],
    envNames: string[] = [],
  ) => checkStdioServerForRun({ name: "s", command, args, envNames }, roots);

  test("a host executable with flag and absolute arguments passes", () => {
    expect(check(server, ["-v", `--config=${config}`, config])).toEqual({
      command: server,
      args: ["-v", `--config=${config}`, config],
    });
  });

  test("the command and path arguments are passed on as real paths", () => {
    const links = join(scratch, "links");
    mkdirSync(links, { recursive: true });
    symlinkSync(server, join(links, "server-link"));
    symlinkSync(config, join(links, "config-link"));
    const checked = check(join(links, "server-link"), [
      join(links, "config-link"),
      `--config=${join(links, "config-link")}`,
    ]);
    expect(checked.command).toBe(server);
    expect(checked.args).toEqual([config, `--config=${config}`]);
  });

  const unsafe: [string, () => unknown][] = [
    ["a command in the working directory", () => check(executable(work, "x"))],
    ["a command in allowedPaths", () => check(executable(allowed, "x"))],
    ["a command in the temp area", () => check(executable(tempScratch, "x"))],
    [
      "a symlink into a writable root",
      () => {
        const target = executable(work, "target");
        const link = join(host, "to-work");
        symlinkSync(target, link);
        return check(link);
      },
    ],
    ["a missing command", () => check(join(host, "missing"))],
    ["a directory as command", () => check(host)],
    [
      "a command that is not executable",
      () => {
        const path = join(host, "plain");
        writeFileSync(path, "");
        chmodSync(path, 0o644);
        return check(path);
      },
    ],
    ["npx", () => check(executable(join(host, "bin"), "npx"))],
    ["bunx", () => check(executable(join(host, "bin2"), "bunx"))],
    ["uvx.exe", () => check(executable(join(host, "bin3"), "uvx.exe"))],
    ["a relative script arg", () => check(server, ["server.py"])],
    ["-m mod", () => check(server, ["-m", "mod"])],
    ["--port 8080", () => check(server, ["--port", "8080"])],
    ["an absolute arg in cwd", () => check(server, [inWork])],
    ["--config=/cwd/x", () => check(server, [`--config=${inWork}`])],
    ["an absolute arg in allowedPaths", () => check(server, [inAllowed])],
    ["a missing absolute arg", () => check(server, [join(host, "nope")])],
    ["NODE_OPTIONS env", () => check(server, [], ["NODE_OPTIONS"])],
    ["ld_preload env", () => check(server, [], ["ld_preload"])],
    ["PATH env", () => check(server, [], ["Path"])],
  ];
  for (const [label, fn] of unsafe) {
    test(`refused: ${label}`, () => {
      expect(policyCode(fn)).toBe(EXTERNAL_AGENT_MCP_STDIO_UNSAFE);
    });
  }

  test("every launcher is refused", () => {
    for (const launcher of MCP_STDIO_LAUNCHERS) {
      const path = executable(join(host, `l-${launcher}`), launcher);
      expect(policyCode(() => check(path))).toBe(
        EXTERNAL_AGENT_MCP_STDIO_UNSAFE,
      );
    }
  });

  test("an existing path in a writable root is refused for its root", () => {
    expect(policyMessage(() => check(server, [inWork]))).toContain(
      "inside a directory the agent can write",
    );
  });

  test("the message names the variable", () => {
    expect(
      policyMessage(() => check(server, [], ["DYLD_INSERT_LIBRARIES"])),
    ).toContain("DYLD_INSERT_LIBRARIES");
  });
});

describe("selectMcpServers", () => {
  const providers = {
    reui: { type: "http" as const, url: "http://127.0.0.1:1/" },
    docs: { type: "http" as const, url: "http://127.0.0.1:2/" },
  };

  test("picks exactly the granted ids, in grant order", () => {
    expect(selectMcpServers(["docs", "reui"], providers)).toEqual({
      docs: providers.docs,
      reui: providers.reui,
    });
    expect(Object.keys(selectMcpServers(["docs"], providers))).toEqual([
      "docs",
    ]);
  });

  test("an empty grant gives no server", () => {
    expect(selectMcpServers([], providers)).toEqual({});
  });

  test("an unknown id, another case, or an inherited key is refused", () => {
    for (const id of ["nope", "REUI", "toString", "__proto__"]) {
      expect(policyCode(() => selectMcpServers([id], providers))).toBe(
        EXTERNAL_AGENT_MCP_PROVIDER_UNKNOWN,
      );
    }
  });
});
