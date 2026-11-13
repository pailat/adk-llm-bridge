/**
 * Strict binary resolution for the SDK drivers: refuse to let an SDK fall
 * back to the binary bundled with its own install when that install is
 * inside a directory the run's agent can write.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPath, isUnderAny } from "../permissions/paths.js";
import {
  EXTERNAL_AGENT_MISSING_BINARY,
  ExternalAgentPolicyError,
} from "./policy-errors.js";

/** Where the SDK's bundled-binary fallback would load code from. */
export interface BundledBinaryLocations {
  /** Absolute paths: the bridge module, the SDK package and the packages it resolves its binary from. */
  readonly locations: readonly string[];
  /** Set when the SDK package itself cannot be found from the bridge install. */
  readonly sdkMissing?: boolean;
}

/** What the strict check needs to know about one SDK driver. */
export interface StrictBinaryCheck {
  /** Runtime name for the message, such as `"Claude Agent SDK"`. */
  readonly runtime: string;
  /** The SDK package, such as `"@anthropic-ai/claude-agent-sdk"`. */
  readonly sdkPackage: string;
  /**
   * Packages the SDK resolves its binary from besides its own optional
   * dependencies, such as `"@openai/codex"`. Their optional dependencies
   * (the platform packages) are checked too.
   */
  readonly binaryPackages?: readonly string[];
  /** The driver option that sets an explicit path. */
  readonly option: string;
  /** The environment variable that sets an explicit path. */
  readonly envVar: string;
}

/** A package found by {@link findPackageDir}. */
interface FoundPackage {
  /** Where the lookup found it: `<dir>/node_modules/<name>`, possibly a symlink. */
  readonly lookup: string;
  /** Its real path, which Node loads from and resolves its dependencies from. */
  readonly real: string;
}

/**
 * Finds a package directory from `fromDir` the way Node's package lookup
 * does: `<dir>/node_modules/<name>` in `fromDir` and each parent.
 *
 * @remarks
 * Checks for `package.json` only, so packages whose `exports` hide
 * `package.json` are still found.
 *
 * @param name - The package name.
 * @param fromDir - The directory to start from.
 * @returns The package, or `undefined`.
 */
function findPackageDir(
  name: string,
  fromDir: string,
): FoundPackage | undefined {
  let current = fromDir;
  for (;;) {
    const lookup = join(current, "node_modules", name);
    if (existsSync(join(lookup, "package.json"))) {
      try {
        return { lookup, real: realpathSync.native(lookup) };
      } catch {
        return { lookup, real: lookup };
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/** The keys of a package's `optionalDependencies`; empty when unreadable. */
function optionalDependencies(packageDir: string): string[] {
  try {
    const parsed = JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    ) as { optionalDependencies?: Record<string, unknown> };
    return Object.keys(parsed.optionalDependencies ?? {});
  } catch {
    return [];
  }
}

/**
 * Locates the code an SDK's bundled-binary fallback would run.
 *
 * @remarks
 * The bridge module itself, the SDK package found from it, every installed
 * optional dependency of the SDK (its platform binary packages), and each
 * of `binaryPackages` found from the SDK with its own installed optional
 * dependencies. Each package is listed twice: where the lookup found it
 * (a symlink in isolated installs, which the agent could re-point) and its
 * real path (where Node loads it and resolves its dependencies from).
 * Optional packages that are not installed are skipped: the SDK cannot
 * load them either.
 *
 * @param sdkPackage - The SDK package name.
 * @param binaryPackages - Extra packages the SDK resolves its binary from.
 * @param bridgeModule - The bridge module path; defaults to this module.
 * @returns The locations, and whether the SDK package was not found.
 * @internal
 */
export function bundledBinaryLocations(
  sdkPackage: string,
  binaryPackages: readonly string[] = [],
  bridgeModule: string = fileURLToPath(import.meta.url),
): BundledBinaryLocations {
  const locations = [bridgeModule];
  const sdk = findPackageDir(sdkPackage, dirname(bridgeModule));
  if (!sdk) {
    return { locations, sdkMissing: true };
  }
  const add = (found: FoundPackage): void => {
    locations.push(found.lookup, found.real);
  };
  const withPlatforms = (packageDir: string): void => {
    for (const name of optionalDependencies(packageDir)) {
      const found = findPackageDir(name, packageDir);
      if (found) add(found);
    }
  };
  add(sdk);
  withPlatforms(sdk.real);
  for (const name of binaryPackages) {
    const found = findPackageDir(name, sdk.real);
    if (found) {
      add(found);
      withPlatforms(found.real);
    }
  }
  return { locations: [...new Set(locations)] };
}

/**
 * The canonical location of `path` itself: its parent's symlinks are
 * resolved, its own last component is kept, so a symlink is judged where it
 * lives, not where it points.
 */
function linkLocation(path: string): string | undefined {
  const parent = canonicalPath(dirname(path), process.cwd());
  return parent === undefined ? undefined : join(parent, basename(path));
}

/**
 * The strict-mode refusal for a run whose binary lookup found nothing.
 *
 * @remarks
 * Security invariant: with strict binary resolution on, an SDK driver never
 * lets the SDK fall back to the binary bundled with its install when that
 * install could have been changed by the run's agent. The run is refused
 * when the bridge module, the SDK package or a package the SDK resolves
 * its binary from overlaps one of the run's writable roots: it is at or
 * under the root, or the root is at or under it (symlinks resolved). It is
 * also refused when the SDK package cannot be found, since then nothing
 * proves where the fallback would load from (fail closed). The check
 * narrows the hole, it does not close it: an agent that can write the
 * installed JavaScript still changes what the next host start loads, and
 * the SDK checked is the one Node finds from the bridge, not an SDK module
 * the host injects.
 *
 * @param check - The driver's runtime, SDK package and explicit-path names.
 * @param excluded - The run's writable roots, canonical.
 * @param locate - Finds the locations; for tests.
 * @returns A `MISSING_BINARY` policy error, or `undefined` to let the SDK
 * use its bundled binary.
 * @internal
 */
export function strictBinaryRefusal(
  check: StrictBinaryCheck,
  excluded: readonly string[],
  locate: () => BundledBinaryLocations = () =>
    bundledBinaryLocations(check.sdkPackage, check.binaryPackages),
): ExternalAgentPolicyError | undefined {
  const { locations, sdkMissing } = locate();
  const fix = `Set ${check.option} or ${check.envVar} to a binary outside the run's working directory and allowedPaths, or install the host (adk-llm-bridge and ${check.sdkPackage}) outside them.`;
  const inside = locations.find((location) => {
    // Both the path itself and its target must be outside; a path that
    // cannot be resolved cannot be proved outside.
    const own = linkLocation(location);
    const target = canonicalPath(location, process.cwd());
    if (own === undefined || target === undefined) {
      return true;
    }
    // Overlap either way: the location at or under a root, or a root at or
    // under the location (a writable directory nested inside the install,
    // such as a package's vendor directory).
    return (
      isUnderAny(own, excluded) ||
      isUnderAny(target, excluded) ||
      excluded.some((root) => isUnderAny(root, [own, target]))
    );
  });
  if (inside !== undefined) {
    return new ExternalAgentPolicyError(
      EXTERNAL_AGENT_MISSING_BINARY,
      `${check.runtime}: strictBinaryResolution is on and no binary was found outside the directories the agent can write, so the SDK would fall back to the binary bundled with its install, and that install (${inside}) overlaps the run's working directory or allowedPaths, where the agent can replace it. ${fix}`,
    );
  }
  if (sdkMissing) {
    return new ExternalAgentPolicyError(
      EXTERNAL_AGENT_MISSING_BINARY,
      `${check.runtime}: strictBinaryResolution is on and no binary was found, and ${check.sdkPackage} could not be located from the bridge install, so where the SDK's bundled binary would load from cannot be checked. ${fix}`,
    );
  }
  return undefined;
}
