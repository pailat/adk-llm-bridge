// Fixture: blocks the host thread in a WebAssembly loop that never returns,
// under the watchdog. Run by tests/helpers/sandbox-watchdog.test.ts with Bun
// and with Node.
import { watchSyncBlock } from "../sandbox-watchdog.ts";

// (module (func (export "spin") (loop (br 0))))
const SPIN = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4, 115,
  112, 105, 110, 0, 0, 10, 9, 1, 7, 0, 3, 64, 12, 0, 11, 11,
]);
const { instance } = await WebAssembly.instantiate(SPIN);
watchSyncBlock("fixture > a turn stuck in wasm", 300, 200);
instance.exports.spin();
