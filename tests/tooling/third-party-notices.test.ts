import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isThirdPartyLegalComment,
  noticedSourceFiles,
} from "../../scripts/third-party-notices.js";

const root = join(import.meta.dir, "..", "..");
const ADAPTED = "src/agents/driver/codex-sdk-exec.ts";
const LEGAL = "/*! @license Apache-2.0 */";

describe("noticedSourceFiles", () => {
  test("reads the adapted file from the real THIRD-PARTY-NOTICES", () => {
    const notices = readFileSync(join(root, "THIRD-PARTY-NOTICES"), "utf8");
    expect(noticedSourceFiles(notices)).toEqual([ADAPTED]);
  });

  test("ignores a src path inside an upstream path", () => {
    const notices =
      "src/a.ts adapts sdk/typescript/src/exec.ts and ./src/b.ts and x-src/c.ts";
    expect(noticedSourceFiles(notices)).toEqual(["src/a.ts"]);
  });

  test("lists each path once", () => {
    expect(noticedSourceFiles("src/a.ts\nsrc/a.ts (again)")).toEqual([
      "src/a.ts",
    ]);
  });
});

describe("isThirdPartyLegalComment", () => {
  test("accepts the leading /*! comment of a named file", () => {
    expect(
      isThirdPartyLegalComment(ADAPTED, { text: LEGAL, start: 0 }, [ADAPTED]),
    ).toBe(true);
  });

  test("rejects a /*! comment that is not at the start of the file", () => {
    expect(
      isThirdPartyLegalComment(ADAPTED, { text: LEGAL, start: 120 }, [ADAPTED]),
    ).toBe(false);
  });

  test("rejects a file whose path is only a substring of a named one", () => {
    // Before r3 a substring match of the whole notices text let these pass.
    for (const file of ["src/agents/driver/codex-sdk.ts", "src/exec.ts"]) {
      expect(
        isThirdPartyLegalComment(
          file,
          { text: LEGAL, start: 0 },
          noticedSourceFiles(
            "src/agents/driver/codex-sdk-exec.ts adapts sdk/typescript/src/exec.ts",
          ),
        ),
      ).toBe(false);
    }
  });

  test("matches a named path exactly, not as a suffix", () => {
    expect(
      isThirdPartyLegalComment("src/exec.ts", { text: LEGAL, start: 0 }, [
        "src/vendor/src/exec.ts",
      ]),
    ).toBe(false);
  });

  test("rejects a plain block comment of a named file", () => {
    expect(
      isThirdPartyLegalComment(
        ADAPTED,
        { text: "/** Licensed. */", start: 0 },
        [ADAPTED],
      ),
    ).toBe(false);
  });
});
