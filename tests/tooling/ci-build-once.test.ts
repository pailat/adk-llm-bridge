import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const scripts: Record<string, string> = (
  await Bun.file(join(root, "package.json")).json()
).scripts;
type Workflow = { jobs: Record<string, { steps?: { run?: string }[] }> };
const workflows: [string, Workflow][] = await Promise.all(
  ["ci.yml", "release.yml"].map(
    async (file): Promise<[string, Workflow]> => [
      file,
      Bun.YAML.parse(
        await Bun.file(join(root, ".github/workflows", file)).text(),
      ) as Workflow,
    ],
  ),
);

/** The shell commands a `run` text executes, with `bun run <script>` expanded. */
function commands(text: string, seen: string[] = []): string[] {
  return text
    .split(/&&|\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const name = /^bun run (\S+)$/.exec(part)?.[1];
      if (name === undefined || scripts[name] === undefined) return [part];
      if (seen.includes(name)) throw new Error(`script cycle at ${name}`);
      return commands(scripts[name], [...seen, name]);
    });
}

const builds = (list: string[]) =>
  list.filter((command) => command.startsWith("bunup")).length;

describe("CI builds the package once per job", () => {
  for (const [file, workflow] of workflows) {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      test(`${file} job ${name} runs bunup at most once`, () => {
        const run = (job.steps ?? []).flatMap((step) =>
          step.run ? commands(step.run) : [],
        );
        expect(builds(run)).toBeLessThanOrEqual(1);
      });
    }
  }

  test("bun run ci type checks the NodeNext consumer on its own build", () => {
    const ci = commands(scripts.ci ?? "");
    const build = ci.findIndex((command) => command.startsWith("bunup"));
    const nodenext = ci.findIndex((command) =>
      command.includes("tests/compat/nodenext-consumer/tsconfig.json"),
    );
    expect(builds(ci)).toBe(1);
    expect(nodenext).toBeGreaterThan(build);
  });

  test("the NodeNext check script reuses dist and the convenience script builds first", () => {
    expect(builds(commands(scripts["check:compat:nodenext"] ?? ""))).toBe(0);
    expect(builds(commands(scripts["typecheck:compat:nodenext"] ?? ""))).toBe(
      1,
    );
  });
});
