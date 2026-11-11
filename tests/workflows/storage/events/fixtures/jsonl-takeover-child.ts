/**
 * Child process of jsonl-event-exporter-processes.test.ts that stops inside a
 * takeover of the directory lock until the parent lets it go on, so that the
 * parent can order two takeovers exactly.
 *
 * Usage: `bun jsonl-takeover-child.ts <holder|claim|lock|same> <directory> <executionId>`.
 *
 * - `holder`: stops right after it first opens the lock file to read it.
 * - `claim`: stops right after it opens a takeover claim file to read it.
 * - `lock`: stops right after it opens the lock file to read it, once it has
 *   created a claim.
 * - `same`: two exporters in this process. The first stops like `lock` for
 *   6.5 seconds; the second starts 5.5 seconds into that stop, when the
 *   first one's claim is older than the claim freshness limit. Prints
 *   `first <result>` and `second <result>`.
 *
 * At the stop it prints `paused` and waits for a line on stdin. Then it prints
 * `holding` and keeps the exporter open until stdin closes, or prints
 * `refused <code>`. The file system is replaced in this process only, so the
 * module mock cannot leak into other tests.
 */
import { mock } from "bun:test";
import { constants } from "node:fs";
import { basename } from "node:path";

const [stopAt, directory, executionId] = process.argv.slice(2);
if (
  !["holder", "claim", "lock", "same"].includes(stopAt ?? "") ||
  !directory ||
  !executionId
) {
  console.error("usage: <holder|claim|lock|same> <directory> <executionId>");
  process.exit(2);
}

const lines: string[] = [];
const waiters: Array<(line: string | undefined) => void> = [];
let ended = false;
let pending = "";
process.stdin.on("data", (chunk: Buffer) => {
  pending += chunk.toString("utf8");
  for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
    const line = pending.slice(0, at);
    pending = pending.slice(at + 1);
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  }
});
process.stdin.on("end", () => {
  ended = true;
  for (const waiter of waiters.splice(0)) waiter(undefined);
});

function nextLine(): Promise<string | undefined> {
  const line = lines.shift();
  if (line !== undefined || ended) return Promise.resolve(line);
  return new Promise((resolve) => waiters.push(resolve));
}

let pause: () => Promise<unknown> = async () => {
  console.log("paused");
  await nextLine();
};

const real = { ...(await import("node:fs/promises")) };
const WRITES = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT;
let armed = true;
let claimed = false;

mock.module("node:fs/promises", () => ({
  ...real,
  link: async (from: string, to: string) => {
    await real.link(from, to);
    claimed = true;
  },
  open: async (...args: Parameters<typeof real.open>) => {
    const handle = await real.open(...args);
    const [path, flags] = args;
    const readOnly = typeof flags === "number" && (flags & WRITES) === 0;
    const name = basename(String(path));
    const stop =
      stopAt === "holder"
        ? name === ".writer.lock"
        : stopAt === "claim"
          ? name.startsWith(".writer.lock.takeover-") && !name.endsWith(".tmp")
          : claimed && name === ".writer.lock";
    if (armed && readOnly && stop) {
      armed = false;
      await pause();
    }
    return handle;
  },
}));

const { JsonlWorkflowEventExporter } = await import(
  "../../../../../src/workflows/storage/jsonl-event-exporter.js"
);
type Exporter = InstanceType<typeof JsonlWorkflowEventExporter>;

async function attempt(exporter: Exporter): Promise<string> {
  try {
    await append(exporter);
    return "holding";
  } catch (error) {
    return `refused ${(error as { code?: string }).code ?? "UNKNOWN"}`;
  }
}

async function append(exporter: Exporter): Promise<void> {
  await exporter.append({
    executionId,
    records: [
      {
        id: `${process.pid}-takeover`,
        executionId,
        kind: "workflow",
        type: "custom",
        timestamp: Date.now(),
        payload: {},
      },
    ],
  });
}

if (stopAt === "same") {
  let stopped: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  pause = async () => {
    stopped();
    await Bun.sleep(6_500);
  };
  const first = attempt(new JsonlWorkflowEventExporter({ directory }));
  await reached;
  await Bun.sleep(5_500);
  const second = attempt(new JsonlWorkflowEventExporter({ directory }));
  console.log(`first ${await first}`);
  console.log(`second ${await second}`);
  process.exit(0);
}

const exporter = new JsonlWorkflowEventExporter({ directory });
const result = await attempt(exporter);
console.log(result);
if (result === "holding") {
  while ((await nextLine()) !== undefined) {
    // Holds the directory until the parent closes stdin.
  }
  await exporter.close();
}
