import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  buildCodexEnv,
  resolveCodexBinary,
  withBinaryPathDirs,
} from "../../../src/agents/driver/codex-run-env.js";
import { CODEX_PROVIDER } from "../../../src/agents/provider/schema.js";

const AMBIENT = {
  PATH: "/bin",
  HOME: "/home/u",
  USER: "u",
  SHELL: "/bin/zsh",
  XDG_CONFIG_HOME: "/home/u/.config",
  HTTPS_PROXY: "http://proxy",
  SSL_CERT_FILE: "/ca.pem",
  CODEX_HOME: "/home/u/.codex",
  OPENAI_API_KEY: "blocked",
  SECRET: "blocked",
};

function request(env: Record<string, string> = {}) {
  return {
    provider: CODEX_PROVIDER,
    context: {} as never,
    credential: { kind: "env", env },
  } as never;
}

describe("Codex run environment", () => {
  test("the SDK profile forwards proxy, certificate and CODEX_HOME, never other secrets", () => {
    const env = buildCodexEnv(AMBIENT, request(), { ambientPassthrough: true });

    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/u",
      USER: "u",
      SHELL: "/bin/zsh",
      XDG_CONFIG_HOME: "/home/u/.config",
      HTTPS_PROXY: "http://proxy",
      SSL_CERT_FILE: "/ca.pem",
      CODEX_HOME: "/home/u/.codex",
    });
  });

  test("the CLI profile copies only the five base variables", () => {
    const env = buildCodexEnv(AMBIENT, request(), {
      ambientPassthrough: false,
    });

    expect(Object.keys(env).sort()).toEqual(
      ["HOME", "PATH", "SHELL", "USER", "XDG_CONFIG_HOME"].sort(),
    );
  });

  test("an env credential overrides the ambient value but cannot add unlisted names", () => {
    const env = buildCodexEnv(
      AMBIENT,
      request({ CODEX_HOME: "/cred", CODEX_API_KEY: "k", SECRET: "x" }),
      { ambientPassthrough: true },
    );

    expect(env.CODEX_HOME).toBe("/cred");
    expect(env.CODEX_API_KEY).toBe("k");
    expect(env).not.toHaveProperty("SECRET");
  });

  test("binary path directories go first, once", () => {
    const env = withBinaryPathDirs(
      { PATH: ["/a", "/x", "/b"].join(delimiter) },
      ["/x", "/y"],
    );

    expect(env.PATH).toBe(["/x", "/y", "/a", "/b"].join(delimiter));
    expect(withBinaryPathDirs({ PATH: "/a" }, []).PATH).toBe("/a");
  });

  test("an explicit executable wins and the lookup list is reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-run-env-"));
    try {
      const bin = join(dir, "codex");
      writeFileSync(bin, "#!/bin/sh\n");
      chmodSync(bin, 0o755);
      const found = resolveCodexBinary(request(), { PATH: "/bin" }, bin);

      expect(found.path).toBe(bin);
      const missing = resolveCodexBinary(
        request(),
        { PATH: "/nonexistent-dir" },
        join(dir, "nope"),
      );
      expect(missing.checked.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
