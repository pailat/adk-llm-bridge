/**
 * Child process that holds the write lock of a SQLite database.
 *
 * Usage: `bun sqlite-write-holder.ts <path>`. Opens the file, starts a
 * `BEGIN IMMEDIATE` transaction, writes a row, prints `locked`, and keeps the
 * transaction open until its stdin closes; then it rolls back.
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

const [path] = process.argv.slice(2);
if (!path) {
  console.error("usage: <path>");
  process.exit(2);
}

const db = new DatabaseSync(path);
db.exec("BEGIN IMMEDIATE");
db.exec("CREATE TABLE IF NOT EXISTS held_by_another_process (x INTEGER)");
db.exec("INSERT INTO held_by_another_process (x) VALUES (1)");
console.log("locked");
process.stdin.resume();
await new Promise<void>((resolve) => process.stdin.on("end", resolve));
db.exec("ROLLBACK");
db.close();
