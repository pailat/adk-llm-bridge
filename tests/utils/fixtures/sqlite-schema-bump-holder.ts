/**
 * Child process that migrates a component to a newer schema version while
 * another process is about to.
 *
 * Usage: `bun sqlite-schema-bump-holder.ts <path> <component> <version> <holdMs>`.
 * Takes the write lock (`BEGIN IMMEDIATE`), stores `<version>` for
 * `<component>` in the helper's version table, prints `locked`, keeps the
 * transaction open for `<holdMs>` milliseconds, then commits and exits.
 */
import { createRequire } from "node:module";

// The installed type definitions do not describe `node:sqlite`, so the module
// is loaded through `require` with the few members this script uses.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (
    path: string,
  ) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...values: unknown[]): unknown };
    close(): void;
  };
};

const [path, component, version, holdMs] = process.argv.slice(2);
if (!path || !component || !version || !holdMs) {
  console.error("usage: <path> <component> <version> <holdMs>");
  process.exit(2);
}

const db = new DatabaseSync(path);
db.exec("BEGIN IMMEDIATE");
db.exec(
  "CREATE TABLE IF NOT EXISTS adk_llm_bridge_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL)",
);
db.prepare(
  `INSERT INTO adk_llm_bridge_schema_versions (component, version) VALUES (?, ?)
   ON CONFLICT (component) DO UPDATE SET version = excluded.version`,
).run(component, Number(version));
console.log("locked");
await new Promise<void>((resolve) => setTimeout(resolve, Number(holdMs)));
db.exec("COMMIT");
db.close();
