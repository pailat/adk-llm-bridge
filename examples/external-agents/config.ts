import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

export function parseArchitectureAnalysisPaths(value: string | undefined): string[] {
  const paths = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const normalized = paths.map((path) => normalizeAllowedDirectory(path));
  return [...new Set(normalized)];
}

export function normalizeAllowedDirectory(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error(
      `ARCHITECTURE_ANALYSIS_PATHS entries must be absolute paths. Invalid entry: ${path}`,
    );
  }

  if (!existsSync(path)) {
    throw new Error(
      `ARCHITECTURE_ANALYSIS_PATHS entry does not exist: ${path}`,
    );
  }

  const realPath = realpathSync(path);
  if (!statSync(realPath).isDirectory()) {
    throw new Error(
      `ARCHITECTURE_ANALYSIS_PATHS entries must be directories. Invalid entry: ${path}`,
    );
  }

  return realPath;
}

export function isPathAllowed(requestedPath: string, allowedPaths: readonly string[]): boolean {
  const requested = normalizeAllowedDirectory(requestedPath);
  return allowedPaths.some((allowedPath) => {
    const allowed = normalizeAllowedDirectory(allowedPath);
    const rel = relative(allowed, requested);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}
