import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  describeChild,
  expectChildExit,
  moduleSpecifier,
  preloadArgs,
} from "./fixtures/runtime.js";

describe("moduleSpecifier", () => {
  test("turns a Windows drive path into a file:// URL, whatever the platform", () => {
    expect(
      moduleSpecifier("D:\\a\\adk-llm-bridge\\src\\workflows\\index.ts", {
        windows: true,
      }),
    ).toBe("file:///D:/a/adk-llm-bridge/src/workflows/index.ts");
  });

  test("escapes spaces in a Windows path", () => {
    expect(
      moduleSpecifier("C:\\Users\\some one\\x.mjs", { windows: true }),
    ).toBe("file:///C:/Users/some%20one/x.mjs");
  });

  test("never leaves a drive letter as the scheme", () => {
    const specifier = moduleSpecifier("c:\\x\\y.ts", { windows: true });
    expect(new URL(specifier).protocol).toBe("file:");
  });

  test("turns a path of this platform into a URL that reads back to the same path", () => {
    const path = fileURLToPath(
      new URL("./child-process-support.test.ts", import.meta.url),
    );
    const specifier = moduleSpecifier(path);
    expect(specifier.startsWith("file://")).toBe(true);
    expect(fileURLToPath(specifier)).toBe(path);
  });
});

describe("preloadArgs", () => {
  test("names a flag and a module the runtime can load", () => {
    const [flag, module] = preloadArgs(
      fileURLToPath(
        new URL("./child-process-support.test.ts", import.meta.url),
      ),
    );
    expect(["--preload", "--import"]).toContain(flag as string);
    expect(module).toBeDefined();
  });
});

describe("child capture", () => {
  const child = { exitCode: 1, signal: null, stdout: "out\n", stderr: "err\n" };

  test("describeChild prints exit code, signal, stdout and stderr", () => {
    const text = describeChild("demo", { ...child, signal: "SIGKILL" });
    expect(text).toContain('child "demo"');
    expect(text).toContain("exit code 1, signal SIGKILL");
    expect(text).toContain("--- stdout ---\nout");
    expect(text).toContain("--- stderr ---\nerr");
  });

  test("expectChildExit throws with the capture when the exit code differs", () => {
    expect(() => expectChildExit("demo", child)).toThrow(/stderr ---\nerr/u);
  });

  test("expectChildExit returns the capture when the exit code matches", () => {
    expect(expectChildExit("demo", child, 1)).toBe(child);
  });
});
