// Worker side of tests/helpers/sandbox-watchdog.ts. It runs while the host
// thread is blocked, so it must not rely on the host's event loop.
import { writeSync } from "node:fs";
import { workerData } from "node:worker_threads";

const SEQUENCE = 0;
const START = 1;
const LIMIT = 2;
const NAME_LENGTH = 3;

const { buffer, slots: count, nameBytes } = workerData;
const slots = new BigInt64Array(buffer, 0, count);
const name = new Uint8Array(buffer, count * 8, nameBytes);

setInterval(() => {
  // Read start, limit and name as one set: skip a round while the writer is
  // updating them (odd sequence) or when it changed them meanwhile.
  const before = Atomics.load(slots, SEQUENCE);
  if (before % 2n === 1n) return;
  const started = Atomics.load(slots, START);
  const limit = Atomics.load(slots, LIMIT);
  const text = new TextDecoder().decode(
    name.slice(0, Number(Atomics.load(slots, NAME_LENGTH))),
  );
  if (Atomics.load(slots, SEQUENCE) !== before || started === 0n) return;
  const elapsed = process.hrtime.bigint() - started;
  if (elapsed <= limit) return;
  writeSync(
    2,
    `SANDBOX WATCHDOG: ${text} blocked the host for ${elapsed / 1_000_000n} ms\n`,
  );
  process.kill(process.pid, "SIGKILL");
}, 100);
