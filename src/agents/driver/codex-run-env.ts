import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import type { ExternalAgentRunRequest } from "../external-agent-driver.js";
import {
  agentWritableRoots,
  buildChildEnv,
  candidateBaseDirectories,
  executableCandidates,
  findExecutable,
  isSearchableExecutable,
  readCredentialEnv,
} from "./shared.js";

/**
 * Variables every Codex run copies from the ambient environment.
 */
const CODEX_BASE_ENV = ["PATH", "HOME", "USER", "SHELL", "XDG_CONFIG_HOME"];

/**
 * Ambient environment variables forwarded into the Codex SDK's replacement
 * env (the SDK does not inherit `process.env`). Covers proxy/cert egress
 * configuration plus a custom shell `CODEX_HOME`.
 */
const CODEX_AMBIENT_PASSTHROUGH = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CODEX_HOME",
];

/** Which Codex binary a run uses, and where the driver looked. */
export interface CodexBinaryResolution {
  /** The binary, or `undefined` when none was found. */
  path?: string;
  /** Every location tried, in order. */
  checked: string[];
  /**
   * Directories the binary needs on `PATH` (the `codex-path` or `path`
   * directory of an npm-installed Codex package). The SDK adds them only
   * when it finds the binary itself, so the driver adds them to the env of
   * the client and of the MCP listing.
   */
  pathDirs?: string[];
}

/** Options for {@link buildCodexEnv}. */
export interface CodexEnvOptions {
  /**
   * Also forward the ambient proxy, certificate and `CODEX_HOME` variables.
   * The SDK builds a replacement env, so it needs them; the CLI transport
   * keeps to the five base variables.
   */
  ambientPassthrough: boolean;
}

/**
 * The environment of one Codex process.
 *
 * @remarks
 * Security invariant: this is an allowlist. Only `PATH`, `HOME`, `USER`,
 * `SHELL` and `XDG_CONFIG_HOME` are copied from the ambient environment (plus
 * proxy, certificate and `CODEX_HOME` variables with `ambientPassthrough`),
 * and the keys in the provider `envAllowlist` that an `env` credential
 * supplies, which override the ambient values. Other secrets in the host
 * environment never reach the agent.
 *
 * @param ambient - The host environment to copy from.
 * @param request - The run, for its credential.
 * @param options - Which ambient variables to forward.
 * @returns A new environment.
 */
export function buildCodexEnv(
  ambient: Record<string, string | undefined>,
  request: ExternalAgentRunRequest,
  options: CodexEnvOptions,
): Record<string, string> {
  return buildChildEnv(
    ambient,
    options.ambientPassthrough
      ? [...CODEX_BASE_ENV, ...CODEX_AMBIENT_PASSTHROUGH]
      : CODEX_BASE_ENV,
    request,
  );
}

/**
 * `env` with the binary's own `PATH` directories in front, as the SDK does
 * for a binary it finds itself.
 *
 * @param env - The run environment.
 * @param dirs - Directories the binary needs on `PATH`.
 * @returns The same object, updated.
 */
export function withBinaryPathDirs(
  env: Record<string, string>,
  dirs: readonly string[] | undefined,
): Record<string, string> {
  if (!dirs || dirs.length === 0) {
    return env;
  }
  const rest = (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0 && !dirs.includes(entry));
  env.PATH = [...dirs, ...rest].join(delimiter);
  return env;
}

/**
 * Finds the Codex binary for a run, never inside a directory the agent can
 * write.
 *
 * @param request - The run: its working directory, allowed paths and
 * credential decide which locations are excluded or consulted.
 * @param ambient - The host environment (`CODEX_EXECUTABLE`,
 * `CODEX_CLI_PATH`, `PATH`).
 * @param codexPathOverride - A configured binary path, which wins.
 * @returns The binary when found, and every location tried.
 */
export function resolveCodexBinary(
  request: ExternalAgentRunRequest,
  ambient: Record<string, string | undefined>,
  codexPathOverride?: string,
): CodexBinaryResolution {
  const excluded = agentWritableRoots(request);
  const found = findExecutable(
    [
      codexPathOverride,
      ambient.CODEX_EXECUTABLE,
      ambient.CODEX_CLI_PATH,
      readCredentialEnv(request, "CODEX_EXECUTABLE"),
      readCredentialEnv(request, "CODEX_CLI_PATH"),
    ],
    codexBinaryCandidates({ env: ambient, excluded }),
  );
  if (found.path) {
    return found;
  }
  const { checked } = found;

  // The npm-installed binary, found the way @openai/codex-sdk finds it.
  for (const base of candidateBaseDirectories()) {
    const npm = findNpmCodexBinary(base, checked, excluded);
    if (npm) {
      return { ...npm, checked };
    }
  }

  return { checked };
}

function codexBinaryCandidates({
  env,
  excluded,
}: {
  env: Record<string, string | undefined>;
  excluded: readonly string[];
}): string[] {
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  return executableCandidates({
    executable,
    env,
    excluded,
    packagePaths: (base) =>
      platformCodexPackages().map(([platformPackage, targetTriple]) =>
        join(
          base,
          "node_modules",
          "@openai",
          platformPackage,
          "vendor",
          targetTriple,
          "codex",
          executable,
        ),
      ),
  });
}

/**
 * The binary of the `@openai/codex` npm package, resolved like
 * `@openai/codex-sdk` does: `@openai/codex/package.json` from the
 * SDK's own location (or from `base`), then the platform package from
 * there, then `vendor/<triple>/bin/codex` (with `codex-package.json` next to
 * it, and `codex-path` for `PATH`) or the older `vendor/<triple>/codex/codex`
 * (with `path`).
 */
function findNpmCodexBinary(
  base: string,
  checked: string[],
  excluded: readonly string[],
): { path: string; pathDirs: string[] } | undefined {
  const [platform] = platformCodexPackages();
  if (!platform) {
    return undefined;
  }
  const [platformPackage, targetTriple] = platform;
  const sdkEntry = join(
    base,
    "node_modules",
    "@openai",
    "codex-sdk",
    "dist",
    "index.js",
  );
  // createRequire only needs a file name to resolve from; it may not exist.
  const starts = existsSync(sdkEntry)
    ? [sdkEntry, join(base, "index.js")]
    : [join(base, "index.js")];
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  for (const start of starts) {
    let vendorRoot: string;
    try {
      const codexPackage = createRequire(start).resolve(
        "@openai/codex/package.json",
      );
      const platformJson = createRequire(codexPackage).resolve(
        `@openai/${platformPackage}/package.json`,
      );
      vendorRoot = join(dirname(platformJson), "vendor");
    } catch {
      continue;
    }
    const root = join(vendorRoot, targetTriple);
    // The package resolution can follow a symlink into the workspace.
    if (!isSearchableExecutable(root, excluded)) {
      continue;
    }
    const current = join(root, "bin", executable);
    checked.push(current);
    if (isFile(current) && isFile(join(root, "codex-package.json"))) {
      return {
        path: current,
        pathDirs: existingDirs(join(root, "codex-path")),
      };
    }
    const legacy = join(root, "codex", executable);
    checked.push(legacy);
    if (isFile(legacy)) {
      return { path: legacy, pathDirs: existingDirs(join(root, "path")) };
    }
  }
  return undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function existingDirs(...paths: string[]): string[] {
  return paths.filter((path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  });
}

function platformCodexPackages(): Array<[string, string]> {
  switch (`${process.platform}:${process.arch}`) {
    case "darwin:arm64":
      return [["codex-darwin-arm64", "aarch64-apple-darwin"]];
    case "darwin:x64":
      return [["codex-darwin-x64", "x86_64-apple-darwin"]];
    case "linux:arm64":
      return [["codex-linux-arm64", "aarch64-unknown-linux-musl"]];
    case "linux:x64":
      return [["codex-linux-x64", "x86_64-unknown-linux-musl"]];
    case "win32:arm64":
      return [["codex-win32-arm64", "aarch64-pc-windows-msvc"]];
    case "win32:x64":
      return [["codex-win32-x64", "x86_64-pc-windows-msvc"]];
    default:
      return [];
  }
}
