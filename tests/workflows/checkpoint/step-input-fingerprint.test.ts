import { describe, expect, test } from "bun:test";
import {
  diffCanonicalInput,
  fingerprintCanonicalInput,
  inputPathAt,
} from "../../../src/workflows/checkpoint/input-diff.js";

const text = (length: number, seed = "a") =>
  JSON.stringify(seed.repeat(length));

describe("input fingerprint bounds", () => {
  test("length 0 and 1 store only the length", async () => {
    expect(await fingerprintCanonicalInput("")).toEqual({ inputLength: 0 });
    expect(await fingerprintCanonicalInput("x")).toEqual({ inputLength: 1 });
  });

  test("256 code units is one chunk: no digest", async () => {
    expect(await fingerprintCanonicalInput("x".repeat(256))).toEqual({
      inputLength: 256,
    });
  });

  test("257 code units give two chunks of 256", async () => {
    const fingerprint = await fingerprintCanonicalInput("x".repeat(257));
    expect(fingerprint.inputLength).toBe(257);
    expect(fingerprint.inputDigest?.chunkSize).toBe(256);
    expect(fingerprint.inputDigest?.chunks).toHaveLength(2);
    for (const chunk of fingerprint.inputDigest?.chunks ?? []) {
      expect(chunk).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  test("8192 code units give 32 chunks of 256; 1 MiB gives 32 chunks of a power of two", async () => {
    const small = await fingerprintCanonicalInput("y".repeat(8192));
    expect(small.inputDigest?.chunkSize).toBe(256);
    expect(small.inputDigest?.chunks).toHaveLength(32);
    const large = await fingerprintCanonicalInput("z".repeat(1024 * 1024));
    const size = large.inputDigest?.chunkSize ?? 0;
    expect(size).toBe(32768);
    expect(Number.isInteger(Math.log2(size))).toBe(true);
    expect(large.inputDigest?.chunks).toHaveLength(32);
    const odd = await fingerprintCanonicalInput("w".repeat(8193));
    expect(odd.inputDigest?.chunkSize).toBe(512);
    expect(odd.inputDigest?.chunks).toHaveLength(17);
  });

  test("a surrogate pair cut at a chunk boundary hashes the same on every run", async () => {
    const input = `${"a".repeat(255)}😀${"b".repeat(300)}`;
    const first = await fingerprintCanonicalInput(input);
    const second = await fingerprintCanonicalInput(input);
    expect(second).toEqual(first);
    expect(first.inputDigest?.chunks).toHaveLength(3);
  });
});

describe("input diff hint", () => {
  async function diff(saved: string, current: string) {
    return diffCanonicalInput(await fingerprintCanonicalInput(saved), current, {
      enabled: true,
    });
  }

  const base = text(1000);
  const change = (at: number) => `${base.slice(0, at)}Z${base.slice(at + 1)}`;

  test("a change at offset 0 names the first window", async () => {
    expect(await diff(base, change(0))).toMatchObject({
      available: true,
      savedLength: base.length,
      length: base.length,
      chunkSize: 256,
      firstDifference: { start: 0, end: 256 },
    });
  });

  test("a change in the middle and in the last chunk", async () => {
    expect(await diff(base, change(600))).toMatchObject({
      firstDifference: { start: 512, end: 768 },
    });
    expect(await diff(base, change(900))).toMatchObject({
      firstDifference: { start: 768, end: base.length },
    });
  });

  test("appending names the window where the saved input ended", async () => {
    const longer = `${base}${"q".repeat(500)}`;
    const hint = await diff(base, longer);
    expect(hint).toMatchObject({
      available: true,
      savedLength: base.length,
      length: longer.length,
    });
    if (!hint.available) throw new Error("expected a hint");
    expect(hint.firstDifference.start).toBeLessThanOrEqual(base.length);
    expect(hint.firstDifference.end).toBeGreaterThan(
      hint.firstDifference.start,
    );
  });

  test("truncating mid-chunk reports the last shared chunk's window", async () => {
    const hint = await diff(base, base.slice(0, 600));
    if (!hint.available) throw new Error("expected a hint");
    expect(hint.length).toBe(600);
    expect(hint.firstDifference.start).toBe(512);
    expect(hint.firstDifference.end).toBe(600);
  });

  test("truncating exactly at a chunk boundary gives the empty window at the length", async () => {
    const hint = await diff(base, base.slice(0, 768));
    if (!hint.available) throw new Error("expected a hint");
    expect(hint.firstDifference).toEqual({ start: 768, end: 768 });
  });

  test("equal lengths with one character changed", async () => {
    const hint = await diff(base, change(300));
    if (!hint.available) throw new Error("expected a hint");
    expect(hint.savedLength).toBe(hint.length);
    expect(hint.firstDifference).toEqual({ start: 256, end: 512 });
  });

  test("the window is in the current form's coordinates and covers the edit", async () => {
    const longer = `${base.slice(0, 300)}INSERTED${base.slice(300)}`;
    const hint = await diff(base, longer);
    if (!hint.available) throw new Error("expected a hint");
    expect(hint.firstDifference.start).toBeLessThanOrEqual(300);
    expect(hint.firstDifference.end).toBeGreaterThan(300);
  });

  test("a single-chunk saved input names the whole current form and has no chunkSize", async () => {
    const hint = await diff('"short"', '"shorter"');
    expect(hint).toEqual({
      available: true,
      savedLength: 7,
      length: 9,
      firstDifference: { start: 0, end: 9 },
      path: "",
    });
  });

  test("the saved chunk size is used, not one recomputed from the current length", async () => {
    const saved = "k".repeat(400);
    const current = `${"k".repeat(300)}!${"k".repeat(20000)}`;
    const hint = await diff(saved, current);
    if (!hint.available) throw new Error("expected a hint");
    expect(hint.chunkSize).toBe(256);
    expect(hint.firstDifference.start).toBe(256);
  });
});

describe("input diff reasons", () => {
  test("no saved length is not-recorded, or disabled when the option is off", async () => {
    expect(await diffCanonicalInput({}, "abc", { enabled: true })).toEqual({
      available: false,
      reason: "not-recorded",
    });
    expect(await diffCanonicalInput({}, "abc", { enabled: false })).toEqual({
      available: false,
      reason: "disabled",
    });
  });

  test("every chunk equal although the hashes differ is inconclusive", async () => {
    const saved = "m".repeat(600);
    const hint = await diffCanonicalInput(
      await fingerprintCanonicalInput(saved),
      saved,
      { enabled: true },
    );
    expect(hint).toEqual({ available: false, reason: "inconclusive" });
  });
});

describe("input path", () => {
  const canonical = JSON.stringify({
    parts: [
      { text: "hello" },
      { text: "second part" },
      { functionCall: { args: { secretKey: "v" }, name: "f" } },
    ],
    role: "user",
  });
  const at = (needle: string) => canonical.indexOf(needle);

  test("a plain string input has the empty path", () => {
    expect(inputPathAt('"hello world"', 3)).toBe("");
  });

  test("a Content input names array indexes and allowlisted keys", () => {
    expect(inputPathAt(canonical, at("second"))).toBe("parts[1].text");
    expect(inputPathAt(canonical, at("hello"))).toBe("parts[0].text");
    expect(inputPathAt(canonical, at('"user"') + 2)).toBe("role");
  });

  test("a key outside the allowlist is written ?", () => {
    expect(inputPathAt(canonical, at('"v"') + 1)).toBe(
      "parts[2].functionCall.args.?",
    );
  });

  test("never throws: malformed input or an offset past the end gives undefined", () => {
    expect(inputPathAt("{not json", 3)).toBeUndefined();
    expect(inputPathAt(canonical, canonical.length)).toBeUndefined();
    expect(inputPathAt(canonical, -1)).toBeUndefined();
  });
});

describe("input diff hint never carries input text or digests", () => {
  /** Small deterministic generator, so a failure reproduces. */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  test("no 8-character window of the input and no chunk digest appears in the serialized hint", async () => {
    const next = random(7);
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 ";
    const word = (length: number) =>
      Array.from(
        { length },
        () => alphabet[Math.floor(next() * alphabet.length)],
      ).join("");
    for (let round = 0; round < 25; round++) {
      const saved = JSON.stringify(word(300 + Math.floor(next() * 4000)));
      const edit = Math.floor(next() * saved.length);
      const current = `${saved.slice(0, edit)}${word(12)}${saved.slice(edit + 3)}`;
      const savedFingerprint = await fingerprintCanonicalInput(saved);
      const hint = await diffCanonicalInput(savedFingerprint, current, {
        enabled: true,
      });
      const serialized = JSON.stringify(hint);
      for (let at = 0; at + 8 <= current.length; at += 7) {
        expect(serialized).not.toContain(current.slice(at, at + 8));
      }
      const digests = [
        ...(savedFingerprint.inputDigest?.chunks ?? []),
        ...((await fingerprintCanonicalInput(current)).inputDigest?.chunks ??
          []),
      ];
      for (const digest of digests) expect(serialized).not.toContain(digest);
    }
  });
});
