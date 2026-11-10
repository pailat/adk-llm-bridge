// Appends `batches` batches of two entries to one transcript; run as a child
// process by the concurrency test. Each run also re-sends its previous batch,
// so the uuid deduplication runs under contention.
import { SqliteSessionStore } from "../../../../src/agents/session-store/sqlite/index.js";

const [path, tag, batches] = process.argv.slice(2);
if (!path || !tag || !batches) throw new Error("usage: path tag batches");
const store = new SqliteSessionStore({ path });
const key = { projectKey: "proj", sessionId: "s1" };
let n = 0;
let previous: Array<{ type: string; uuid: string; tag: string; n: number }> =
  [];
for (let batch = 0; batch < Number(batches); batch++) {
  const entries = [0, 1].map(() => {
    const value = n++;
    return { type: "user", uuid: `${tag}-${value}`, tag, n: value };
  });
  await store.append(key, [...previous, ...entries]);
  previous = entries;
}
store.close();
