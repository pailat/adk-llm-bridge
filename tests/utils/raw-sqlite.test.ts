import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nodeSqliteAvailable,
  openRawDatabase,
  openRawDatabaseWith,
} from "./fixtures/raw-sqlite.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("raw sqlite fixture", () => {
  test("nodeSqliteAvailable is a boolean", () => {
    expect(typeof nodeSqliteAvailable).toBe("boolean");
  });

  test.skipIf(!nodeSqliteAvailable)(
    "openRawDatabase round-trips a row through prepare and query",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "raw-sqlite-"));
      directories.push(directory);
      const database = openRawDatabase(join(directory, "test.db"));
      try {
        database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
        database.prepare("INSERT INTO items (name) VALUES (?)").run("alpha");
        expect(database.query("SELECT name FROM items").get()).toEqual({
          name: "alpha",
        });
        expect(database.prepare("SELECT id FROM items").all()).toHaveLength(1);
      } finally {
        database.close();
      }
    },
  );

  test("a loader that throws gives the error naming node:sqlite and the guard", () => {
    const load = () => {
      throw new Error("Cannot find module");
    };
    expect(() => openRawDatabaseWith(load, ":memory:")).toThrow(
      /node:sqlite.*nodeSqliteAvailable/s,
    );
  });

  test("a loader returning a module without DatabaseSync gives the same error", () => {
    expect(() => openRawDatabaseWith(() => ({}), ":memory:")).toThrow(
      /node:sqlite.*nodeSqliteAvailable/s,
    );
  });

  test("the loader is asked for node:sqlite", () => {
    const asked: string[] = [];
    expect(() =>
      openRawDatabaseWith((specifier) => {
        asked.push(specifier);
        return {};
      }, ":memory:"),
    ).toThrow();
    expect(asked).toEqual(["node:sqlite"]);
  });
});
