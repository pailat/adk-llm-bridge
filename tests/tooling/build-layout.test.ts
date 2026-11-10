import { describe, expect, test } from "bun:test";
import { join, relative, resolve } from "node:path";

const root = join(import.meta.dir, "..", "..");
const pkg = (await Bun.file(join(root, "package.json")).json()) as {
  exports: Record<string, string | { types?: string; import?: string }>;
  scripts: Record<string, string>;
};
// Loaded at run time: the config's inferred type is not part of the
// type-checked project.
const config: unknown = (await import(join(root, "bunup.config.ts"))).default;
const options = (Array.isArray(config) ? config[0] : config) as {
  entry: string[];
  sourceBase?: string;
};

/** Where an entry is written: its path under `sourceBase`, in `dist/`. */
function distPath(entry: string, extension: ".js" | ".d.ts"): string {
  const base = resolve(root, options.sourceBase ?? ".");
  const path = relative(base, resolve(root, entry)).replace(/\.ts$/, "");
  return `./dist/${path.split("\\").join("/")}${extension}`;
}

const exported = Object.values(pkg.exports).filter(
  (value): value is { types: string; import: string } =>
    typeof value === "object",
);

describe("build layout", () => {
  test("output paths are relative to src/, whatever the entry list", () => {
    // Without it Bun uses the lowest common ancestor of the entries, and a
    // change to the list can move every file to dist/src/.
    expect(options.sourceBase).toBe("./src");
  });

  test("every entry builds to a path that package.json exports", () => {
    for (const entry of options.entry) {
      expect(exported.map((value) => value.import)).toContain(
        distPath(entry, ".js"),
      );
      expect(exported.map((value) => value.types)).toContain(
        distPath(entry, ".d.ts"),
      );
    }
  });

  test("every export is built by an entry", () => {
    const built = options.entry.map((entry) => distPath(entry, ".js"));
    for (const value of exported) {
      expect(built).toContain(value.import);
    }
  });

  test("ci checks the built files after the build", () => {
    const ci = pkg.scripts.ci ?? "";
    expect(ci.indexOf("bun run build")).toBeGreaterThanOrEqual(0);
    expect(ci.indexOf("bun run check:dist")).toBeGreaterThan(
      ci.indexOf("bun run build"),
    );
    expect(pkg.scripts["check:dist"]).toContain("check-dist-entries.ts");
  });
});
