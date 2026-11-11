import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as workflows from "../../src/workflows/index.js";
import {
  WORKFLOW_CHECKPOINT_URI_SCHEMES,
  WORKFLOW_EVENT_URI_SCHEMES,
} from "../../src/workflows/index.js";

// These tests only read files and the workflows entry's constants. They do not
// open any storage provider.

const REPO_ROOT = resolve(import.meta.dir, "../..");

const STORAGE_PAGE = "docs/storage-providers.md";
const DURABILITY_PAGE = "docs/workflow-durability.md";
const DOCS_INDEX = "docs/README.md";
const README = "README.md";
const CHANGELOG = "CHANGELOG.md";
const ERRORS_SOURCE = "src/workflows/storage/errors.ts";
const CHECKPOINT_SQLITE_INDEX = "src/workflows/checkpoint/sqlite/index.ts";
const EVENT_SQLITE_INDEX = "src/workflows/events/sqlite/index.ts";

const NEW_SUBPATHS = [
  "adk-llm-bridge/workflows/checkpoint/sqlite",
  "adk-llm-bridge/workflows/events/sqlite",
  "adk-llm-bridge/workflows/storage/conformance",
];

/** Names of the public symbols the storage page documents by name. */
const PAGE_SYMBOLS = [
  "BaseWorkflowCheckpointStore",
  "BaseWorkflowEventExporter",
  "registerWorkflowStorageProvider",
  "getWorkflowCheckpointStoreFromUri",
  "getWorkflowEventExporterFromUri",
  "listWorkflowStorageSchemes",
  "redactWorkflowStorageUri",
  "WorkflowEventExportPlugin",
  "WorkflowSpanExportProcessor",
  "workflowEventRecordFromSpan",
  "workflowEventRecordsFromAdkEvent",
  "clipWorkflowEventRecord",
  "createArtifactOverflowHandler",
  "WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE",
  "DEFAULT_WORKFLOW_CHECKPOINT_LEASE_TTL_MS",
  "DEFAULT_WORKFLOW_EVENT_RECORD_MAX_BYTES",
  "DEFAULT_WORKFLOW_EVENT_BUFFER_RECORDS",
  "DEFAULT_WORKFLOW_EVENT_BUFFER_BYTES",
  "WORKFLOW_EVENT_EXPORT_DEGRADED",
  "WORKFLOW_EVENT_EXPORT_RECOVERED",
  "WORKFLOW_EVENT_EXPORT_DROPPED",
  "defineWorkflowStorageConformanceTests",
  "workflowCheckpointStoreConformanceCases",
  "workflowEventExporterConformanceCases",
  "SqliteSessionStore",
  "DatabaseSessionService",
];

/** Reads a repository file, or returns an empty string when it is missing. */
function readRepoFile(relativePath: string): string {
  const path = join(REPO_ROOT, relativePath);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Returns the names from the entries that are not in `text`. */
function missingFrom(text: string, names: readonly string[]): string[] {
  return names.filter((name) => !text.includes(name));
}

/**
 * Returns the body of a Markdown section: from its heading line to the next
 * heading of the same or a higher level. Empty when the heading is missing.
 */
function markdownSection(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) return "";
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Lists the class names of the SQLite entry source that match a suffix. */
function sqliteClassNames(source: string): string[] {
  const names = source.match(/\bSqlite\w+(?:CheckpointStore|EventExporter)\b/g);
  return [...new Set(names ?? [])];
}

/** Lists the classes of the workflows entry that are storage providers or exporters. */
function workflowsStorageClassNames(): string[] {
  return Object.keys(workflows).filter(
    (name) =>
      /^[A-Z]/.test(name) &&
      !name.startsWith("Base") &&
      typeof (workflows as Record<string, unknown>)[name] === "function" &&
      /(CheckpointStore|CheckpointProvider|EventExporter|EventExportPlugin|SpanExportProcessor)$/.test(
        name,
      ),
  );
}

/** Lists the codes of the `WorkflowStorageErrorCode` union in the errors source. */
function storageErrorCodes(): string[] {
  const source = readRepoFile(ERRORS_SOURCE);
  const union = source.match(
    /export type WorkflowStorageErrorCode =([\s\S]*?);/,
  );
  if (!union) return [];
  return [...union[1].matchAll(/"(WORKFLOW_STORAGE_[A-Z_]+)"/g)].map(
    (match) => match[1],
  );
}

/** Words of internal tracking labels, which the published docs must not carry. */
const INTERNAL_LABEL_PATTERNS: readonly RegExp[] = [
  /\b(?:DF|RT|WF|STREAM|W|F|N)-?\d+\b/,
  /\bG-SESS\b/,
  /\bwaves?\b/i,
  /\blanes?\b/i,
  /DESIGN\.md|DECISION\.md/,
  /\bsection \d+\.\d+\b/,
];

function internalLabelsIn(text: string): string[] {
  return INTERNAL_LABEL_PATTERNS.flatMap((pattern) => {
    const match = text.match(pattern);
    return match ? [match[0]] : [];
  });
}

describe("storage providers page (docs/storage-providers.md)", () => {
  test("the page exists", () => {
    expect(existsSync(join(REPO_ROOT, STORAGE_PAGE))).toBe(true);
  });

  test("names every built-in checkpoint URI scheme", () => {
    const page = readRepoFile(STORAGE_PAGE);
    const missing = missingFrom(
      page,
      WORKFLOW_CHECKPOINT_URI_SCHEMES.map((scheme) => `${scheme}://`),
    );
    expect(missing).toEqual([]);
  });

  test("names every built-in event URI scheme", () => {
    const page = readRepoFile(STORAGE_PAGE);
    const missing = missingFrom(
      page,
      WORKFLOW_EVENT_URI_SCHEMES.map((scheme) => `${scheme}://`),
    );
    expect(missing).toEqual([]);
  });

  test("the workflows entry exports the storage provider and exporter classes it is checked against", () => {
    // Guards the filter below: if these disappear, the page check would
    // silently cover fewer classes.
    expect(workflowsStorageClassNames()).toEqual(
      expect.arrayContaining([
        "InMemoryWorkflowCheckpointStore",
        "FileSystemWorkflowCheckpointProvider",
        "AdkSessionServiceWorkflowCheckpointStore",
        "LeasedWorkflowCheckpointStore",
        "InMemoryWorkflowEventExporter",
        "JsonlWorkflowEventExporter",
        "WorkflowEventExportPlugin",
        "WorkflowSpanExportProcessor",
      ]),
    );
  });

  test("names every provider and exporter class of the workflows entry", () => {
    const page = readRepoFile(STORAGE_PAGE);
    expect(missingFrom(page, workflowsStorageClassNames())).toEqual([]);
  });

  test("names every provider and exporter class of the two SQLite entries", () => {
    const page = readRepoFile(STORAGE_PAGE);
    const sqliteClasses = [
      ...sqliteClassNames(readRepoFile(CHECKPOINT_SQLITE_INDEX)),
      ...sqliteClassNames(readRepoFile(EVENT_SQLITE_INDEX)),
    ];
    expect(sqliteClasses).toEqual(
      expect.arrayContaining([
        "SqliteWorkflowCheckpointStore",
        "SqliteWorkflowEventExporter",
      ]),
    );
    expect(missingFrom(page, sqliteClasses)).toEqual([]);
  });

  test("names the three new subpaths", () => {
    const page = readRepoFile(STORAGE_PAGE);
    expect(missingFrom(page, NEW_SUBPATHS)).toEqual([]);
  });

  test("names every WorkflowStorageErrorCode", () => {
    const codes = storageErrorCodes();
    // The union has 16 codes in the merged source.
    expect(codes).toHaveLength(16);
    const page = readRepoFile(STORAGE_PAGE);
    expect(missingFrom(page, codes)).toEqual([]);
  });

  test("names no storage error code that the union does not define", () => {
    const codes = new Set(storageErrorCodes());
    const page = readRepoFile(STORAGE_PAGE);
    expect(page).not.toBe("");
    const named = [...page.matchAll(/WORKFLOW_STORAGE_[A-Z_]*[A-Z]/g)].map(
      (match) => match[0],
    );
    expect(named.filter((code) => !codes.has(code))).toEqual([]);
  });

  test("names the public functions, constants and conformance entry points", () => {
    const page = readRepoFile(STORAGE_PAGE);
    expect(missingFrom(page, PAGE_SYMBOLS)).toEqual([]);
  });

  test("names the capability flags of the checkpoint contract", () => {
    const page = readRepoFile(STORAGE_PAGE);
    expect(
      missingFrom(page, [
        "compareAndSet",
        "leases",
        "durable",
        "multiProcess",
        "listing",
        "pruning",
        "maxCheckpointBytes",
      ]),
    ).toEqual([]);
  });

  test("states the one-host limit of the SQLite providers", () => {
    const page = readRepoFile(STORAGE_PAGE);
    expect(page).toMatch(/one host/i);
  });

  test("states the Node and Bun runtime requirements for SQLite", () => {
    const page = readRepoFile(STORAGE_PAGE);
    expect(page).toContain("22.13");
    expect(page).toMatch(/Bun/);
  });

  test("covers event export: plugin, span processor, sequence, clipping, failure policy and kill -9", () => {
    const page = readRepoFile(STORAGE_PAGE);
    expect(page).toMatch(/sequence/i);
    expect(page).toMatch(/clip/i);
    expect(page).toMatch(/kill -9|SIGKILL/);
    expect(page).toMatch(/failure/i);
  });

  test("covers the injection and URI selection paths with an example for each", () => {
    const page = readRepoFile(STORAGE_PAGE);
    expect(page).toMatch(/inject/i);
    expect(page).toContain("checkpointStore");
    expect(page).toMatch(/URI/);
  });

  test("covers running the conformance suite on a custom provider", () => {
    const page = readRepoFile(STORAGE_PAGE);
    expect(page).toMatch(/conformance/i);
  });

  test("covers the deprecation policy and the known limits", () => {
    const page = readRepoFile(STORAGE_PAGE);
    expect(page).toMatch(/deprecat/i);
    expect(page).toMatch(/known limits|limits/i);
  });

  test("uses no internal tracking labels or design-file references", () => {
    const page = readRepoFile(STORAGE_PAGE);
    expect(page).not.toBe("");
    expect(internalLabelsIn(page)).toEqual([]);
  });

  test("has a Shutdown section that tells the host to flush or close the pipeline and close the stores", () => {
    const section = markdownSection(readRepoFile(STORAGE_PAGE), "## Shutdown");
    expect(section).not.toBe("");
    expect(section).toContain("pipeline.close(");
    expect(section).toContain("flush");
    expect(section).toContain("flushOnRunEndMs");
    expect(section).toMatch(/keeps? the process (alive|open)/);
    expect(section).toMatch(/exporter\.close\(\)/);
    expect(section).toMatch(/store\.close\(\)/);
  });
});

describe("workflow durability page (docs/workflow-durability.md)", () => {
  test("has a Checkpoint providers section after Checkpoint commit semantics", () => {
    const page = readRepoFile(DURABILITY_PAGE);
    const commitIndex = page.indexOf("\n## Checkpoint commit semantics\n");
    const providersIndex = page.indexOf("\n## Checkpoint providers\n");
    expect(commitIndex).toBeGreaterThan(-1);
    expect(providersIndex).toBeGreaterThan(commitIndex);
  });

  test("the Checkpoint providers section links to the new page", () => {
    const section = markdownSection(
      readRepoFile(DURABILITY_PAGE),
      "## Checkpoint providers",
    );
    expect(section).not.toBe("");
    expect(section).toMatch(/\]\((\.\/)?storage-providers\.md(#[^)]*)?\)/);
  });

  test("the Checkpoint providers section names the capability table, the lease decorator and the file-system default", () => {
    const section = markdownSection(
      readRepoFile(DURABILITY_PAGE),
      "## Checkpoint providers",
    );
    expect(section).toContain("compareAndSet");
    expect(section).toContain("LeasedWorkflowCheckpointStore");
    expect(section).toContain("FileSystemWorkflowCheckpointStore");
    expect(section).toMatch(/default/i);
  });

  test("the Checkpoint failure reasons section points to WorkflowStorageError", () => {
    const section = markdownSection(
      readRepoFile(DURABILITY_PAGE),
      "### Checkpoint failure reasons",
    );
    expect(section).toContain("WorkflowStorageError");
  });

  test("the new text uses no internal tracking labels", () => {
    const section = markdownSection(
      readRepoFile(DURABILITY_PAGE),
      "## Checkpoint providers",
    );
    expect(section).not.toBe("");
    expect(internalLabelsIn(section)).toEqual([]);
  });
});

describe("links to the new page", () => {
  test("docs/README.md links to storage-providers.md", () => {
    expect(readRepoFile(DOCS_INDEX)).toMatch(
      /\]\((\.\/)?storage-providers\.md(#[^)]*)?\)/,
    );
  });

  test("README.md links to docs/storage-providers.md", () => {
    expect(readRepoFile(README)).toMatch(
      /\]\(docs\/storage-providers\.md(#[^)]*)?\)/,
    );
  });
});

describe("CHANGELOG", () => {
  test("the last entry of the [0.7.0] Added list mentions the storage providers", () => {
    const changelog = readRepoFile(CHANGELOG);
    const start = changelog.indexOf("## [0.7.0]");
    expect(start).toBeGreaterThan(-1);
    const nextRelease = changelog.indexOf("\n## [", start + 1);
    const release = changelog.slice(
      start,
      nextRelease === -1 ? undefined : nextRelease,
    );
    const addedStart = release.indexOf("\n### Added\n");
    expect(addedStart).toBeGreaterThan(-1);
    const afterAdded = release.slice(addedStart + "\n### Added\n".length);
    const addedEnd = afterAdded.search(/\n### /);
    const added = (
      addedEnd === -1 ? afterAdded : afterAdded.slice(0, addedEnd)
    ).trimEnd();
    const entries = added.split(/\n(?=- )/);
    const lastEntry = entries[entries.length - 1] ?? "";
    expect(lastEntry).toMatch(/storage provider/i);
  });
});
