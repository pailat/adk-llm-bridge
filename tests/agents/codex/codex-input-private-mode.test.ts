import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userContentToCodexInput } from "../../../src/agents/driver/codex-input-mapper.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("Codex image temp files are owner-only", () => {
  test.skipIf(process.platform === "win32")(
    "image file is written with mode 0600 regardless of a permissive umask",
    () => {
      const base = mkdtempSync(join(tmpdir(), "codex-input-mode-"));
      dirs.push(base);
      const previous = process.umask(0o000);
      let mapping: ReturnType<typeof userContentToCodexInput>;
      try {
        mapping = userContentToCodexInput(
          {
            role: "user",
            parts: [
              { text: "look" },
              {
                inlineData: {
                  mimeType: "image/png",
                  data: Buffer.from("png-bytes").toString("base64"),
                },
              },
            ],
          },
          { tmpDir: base, idPrefix: "t" },
        );
      } finally {
        process.umask(previous);
      }
      const input = mapping.input as { type: string; path?: string }[];
      const image = input.find((part) => part.type === "local_image");
      const path = image?.path;
      if (path === undefined) throw new Error("expected a local_image part");
      expect(readFileSync(path, "utf8")).toBe("png-bytes");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      mapping.cleanup();
    },
  );
});
