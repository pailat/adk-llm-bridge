import { mock } from "bun:test";
import {
  type Logger,
  type LogLevel,
  resetLogger,
  setLogger,
} from "@google/adk";

/**
 * Installs a fake ADK logger and returns a spy over its `warn` calls.
 *
 * The spy receives only the first argument of each `logger.warn(...)`
 * (the formatted message); the stable warning `code` that adk-llm-bridge
 * attaches as the second argument is available in `codes`. Use it where tests
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
    warn: (message: unknown, meta?: unknown) => {
      spy(message);
      codes.push((meta as { code?: unknown } | undefined)?.code);
    },
  };
  setLogger(fake);
  Object.defineProperty(spy, "mockRestore", {
    value: () => resetLogger(),
    configurable: true,
  });
  return Object.assign(spy, { codes });
}
