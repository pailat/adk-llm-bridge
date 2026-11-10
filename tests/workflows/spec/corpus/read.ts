import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CorpusGroup, generatedCorpusCases } from "./generated.js";

/** Directory holding the valid and invalid run spec case files. */
const CORPUS_DIR = fileURLToPath(new URL("./", import.meta.url));

/** One corpus case as JSON text, before it is parsed. */
export interface CorpusFile {
  readonly group: CorpusGroup;
  readonly name: string;
  readonly text: string;
}

/**
 * Every corpus case of the groups: the `.json` files on disk and the
 * generated cases, sorted by name within each group.
 *
 * @remarks
 * A generated case is given as the `JSON.stringify` text of its value, so a
 * reader handles it exactly like a file. A missing group folder yields only
 * the generated cases of that group.
 */
export function readCorpusFiles(
  groups: readonly CorpusGroup[] = ["valid", "invalid"],
): CorpusFile[] {
  const generated = generatedCorpusCases();
  const files: CorpusFile[] = [];
  for (const group of groups) {
    const dir = join(CORPUS_DIR, group);
    const inGroup: CorpusFile[] = existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith(".json"))
          .map((name) => ({
            group,
            name,
            text: readFileSync(join(dir, name), "utf8"),
          }))
      : [];
    for (const item of generated) {
      if (item.group === group) {
        inGroup.push({
          group,
          name: item.name,
          text: JSON.stringify(item.value),
        });
      }
    }
    inGroup.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    files.push(...inGroup);
  }
  return files;
}
