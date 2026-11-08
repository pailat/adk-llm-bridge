import { afterEach, describe, expect, it } from "bun:test";
import { LogLevel, resetLogger, setLogLevel } from "@google/adk";
import {
  LogCode,
  resetWarnOnce,
  WarningScope,
  warn,
  warnOnce,
} from "../../src/utils/log.js";
import { captureWarnings } from "../helpers/fake-logger.js";

afterEach(() => {
  resetLogger();
  resetWarnOnce();
});

describe("log", () => {
  it("prefixes messages and attaches the stable code as second argument", () => {
    const spy = captureWarnings();
    warn(LogCode.TOOL_CALL_MISSING_ID, "functionCall missing id");
    expect(spy.mock.calls).toEqual([
      ["[adk-llm-bridge] functionCall missing id"],
    ]);
    expect(spy.codes).toEqual(["TOOL_CALL_MISSING_ID"]);
  });

  it("warnOnce logs a code once per process until reset", () => {
    const spy = captureWarnings();
    warnOnce("X", "first");
    warnOnce("X", "second");
    warnOnce("Y", "other");
    expect(spy.codes).toEqual(["X", "Y"]);
    resetWarnOnce();
    warnOnce("X", "again");
    expect(spy.codes).toEqual(["X", "Y", "X"]);
  });

  it("WarningScope de-duplicates per scope, not globally", () => {
    const spy = captureWarnings();
    const a = new WarningScope();
    a.warnOnce("X", "m");
    a.warnOnce("X", "m");
    new WarningScope().warnOnce("X", "m");
    expect(spy.codes).toEqual(["X", "X"]);
  });

  it("respects ADK's log level", () => {
    const spy = captureWarnings();
    // The fake logger ignores levels; verify against the default logger path
    // by checking that resetting restores a logger that honors setLogLevel.
    spy.mockRestore();
    setLogLevel(LogLevel.ERROR);
    const written: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      written.push(args);
    };
    try {
      warn("X", "silenced");
    } finally {
      console.warn = original;
    }
    expect(written).toEqual([]);
  });
});
