import { mock } from "bun:test";
import {
  type Logger,
  type LogLevel,
  resetLogger,
  setLogger,
} from "@google/adk";

/** `[adk-llm-bridge] [<code>] <message>`, as `warn` in src/utils/log.ts writes it. */
const CODED_WARNING = /^(\[adk-llm-bridge\]) \[([^\]\s]+)\] ([\s\S]*)$/;

/**
 * Installs a fake ADK logger and returns a spy over its `warn` calls.
 *
 * The spy receives each warning without its `[<code>]` part
 * (`[adk-llm-bridge] <message>`), and the stable warning code is collected in
 * `codes`. A warning without a code is passed through as is. Use it where tests
 * used to spy on `console.warn`. Call `mockRestore()` (or `resetLogger()`) to
 * reinstate ADK's default logger.
 */
export function captureWarnings() {
  const spy = mock((_message: unknown) => {});
  const codes: unknown[] = [];
  const noop = () => {};
  const fake: Logger = {
    log: noop,
    debug: noop,
    info: noop,
    error: noop,
    setLogLevel: (_level: LogLevel) => {},
    warn: (message: unknown) => {
      const match =
        typeof message === "string" ? CODED_WARNING.exec(message) : null;
      spy(match ? `${match[1]} ${match[3]}` : message);
      codes.push(match?.[2]);
    },
  };
  setLogger(fake);
  Object.defineProperty(spy, "mockRestore", {
    value: () => resetLogger(),
    configurable: true,
  });
  return Object.assign(spy, { codes });
}
