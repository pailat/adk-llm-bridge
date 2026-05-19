// Backward-compatible alias for the previous smoke script name.
// The external-agents example now demonstrates a hybrid HelpDesk.
import { main } from "./smoke-helpdesk.js";

if (import.meta.main) {
  await main();
}
