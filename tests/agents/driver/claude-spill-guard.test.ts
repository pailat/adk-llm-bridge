/**
 * The spill guard: Claude Code saves a large tool result under
 * `<config>/projects/<project key>/<session id>/tool-results/`, even with
 * `persistSession: false` (seen in a live run). The guard reserves
 * `<session id>` as an empty read-only file, so no directory can be made
 * there and every spill falls back to inline truncation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_PROJECT_KEY_MAX,
  claudeProjectKey,
  type ReservedFileIdentity,
  reserveClaudeSpillPath,
  sameReservedFile,
} from "../../../src/agents/driver/claude-spill-guard.js";

const SID = "0b5e8a3c-1d2f-4a6b-9c7d-8e9f0a1b2c3d";
let root: string;
let configDir: string;
let cwd: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "spill-guard-")));
  configDir = join(root, "config");
  cwd = join(root, "work dir");
  mkdirSync(cwd, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const reserve = (overrides: Partial<{ sessionId: string; cwd: string }> = {}) =>
  reserveClaudeSpillPath({
    configDir,
    workingDirectory: overrides.cwd ?? cwd,
    sessionId: overrides.sessionId ?? SID,
  });

describe("claudeProjectKey: Claude Code's project folder name", () => {
  test("every character other than an ASCII letter or digit becomes '-'", () => {
    expect(claudeProjectKey("/Users/a/b c.d_é")).toBe("-Users-a-b-c-d--");
  });

  test("up to 200 characters; a longer key (hashed by Claude Code) is undefined", () => {
    expect(CLAUDE_PROJECT_KEY_MAX).toBe(200);
    expect(claudeProjectKey(`/${"a".repeat(199)}`)).toHaveLength(200);
    expect(claudeProjectKey(`/${"a".repeat(200)}`)).toBeUndefined();
  });
});

describe("reserveClaudeSpillPath", () => {
  test("reserves <config>/projects/<key>/<session id> as an empty read-only file", () => {
    const reservation = reserve();
    const key = claudeProjectKey(cwd) as string;
    expect(reservation.path).toBe(join(configDir, "projects", key, SID));
    const stats = lstatSync(reservation.path);
    expect(stats.isFile()).toBe(true);
    expect(stats.size).toBe(0);
    expect(stats.mode & 0o777).toBe(0o400);
    reservation.release();
  });

  test("no tool-results directory can be made under it", () => {
    const reservation = reserve();
    expect(() =>
      mkdirSync(join(reservation.path, "tool-results"), { recursive: true }),
    ).toThrow();
    expect(() =>
      writeFileSync(join(reservation.path, "tool-results", "x.txt"), "x"),
    ).toThrow();
    reservation.release();
  });

  test("the key comes from the real path of the working directory", () => {
    const link = join(root, "link");
    symlinkSync(cwd, link);
    const reservation = reserve({ cwd: link });
    expect(reservation.path).toBe(
      join(configDir, "projects", claudeProjectKey(cwd) as string, SID),
    );
    reservation.release();
  });

  test("refuses a session id longer than 64 characters before it makes any folder", () => {
    expect(() => reserve({ sessionId: "a".repeat(65) })).toThrow(
      /not a plain id/,
    );
    expect(() => reserve({ sessionId: "a".repeat(300) })).toThrow(
      /not a plain id/,
    );
    expect(existsSync(configDir)).toBe(false);
    const edge = reserve({ sessionId: "a".repeat(64) });
    edge.release();
  });

  test("refuses a session path that already exists", () => {
    const first = reserve();
    expect(() => reserve()).toThrow(/already exists/);
    first.release();
  });

  test("refuses when the projects folder cannot hold it", () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "projects"), "");
    expect(() => reserve()).toThrow(/could not reserve/);
  });

  test("refuses a working directory whose key Claude Code would hash", () => {
    const deep = join(root, "d".repeat(120), "e".repeat(120));
    mkdirSync(deep, { recursive: true });
    expect(() => reserve({ cwd: deep })).toThrow(/longer than 200/);
  });

  test("release removes the file and the folders it made, nothing else", () => {
    const reservation = reserve();
    reservation.release();
    expect(existsSync(reservation.path)).toBe(false);
    expect(existsSync(join(configDir, "projects"))).toBe(false);
    expect(existsSync(configDir)).toBe(false);
    // A project folder that existed before stays.
    const projectDir = join(
      configDir,
      "projects",
      claudeProjectKey(cwd) as string,
    );
    mkdirSync(projectDir, { recursive: true });
    const again = reserve();
    again.release();
    expect(existsSync(projectDir)).toBe(true);
    expect(existsSync(again.path)).toBe(false);
  });

  test("release leaves a path that is no longer its file alone", () => {
    const reservation = reserve();
    rmSync(reservation.path);
    mkdirSync(reservation.path);
    reservation.release();
    expect(lstatSync(reservation.path).isDirectory()).toBe(true);
  });

  test("release leaves another file at the path alone", () => {
    const reservation = reserve();
    rmSync(reservation.path);
    writeFileSync(reservation.path, "someone else's");
    reservation.release();
    expect(existsSync(reservation.path)).toBe(true);
  });

  test("release leaves an empty file that replaced it alone", () => {
    // Linux may give the new file the deleted one's inode: the change time
    // still tells them apart.
    const reservation = reserve();
    rmSync(reservation.path);
    Bun.sleepSync(20);
    writeFileSync(reservation.path, "");
    reservation.release();
    expect(existsSync(reservation.path)).toBe(true);
  });

  test("refuses a session id that is not a plain id", () => {
    for (const sessionId of ["../escape", "a/b", "", "a b"]) {
      expect(() => reserve({ sessionId })).toThrow(/not a plain id/);
    }
    expect(existsSync(configDir)).toBe(false);
  });

  test("release twice is harmless", () => {
    const reservation = reserve();
    reservation.release();
    expect(() => reservation.release()).not.toThrow();
  });
});

describe("matches: the runtime's hook input names the reserved session", () => {
  const input = (
    projectDir: string,
    sessionId: string = SID,
  ): Record<string, unknown> => ({
    session_id: sessionId,
    transcript_path: join(projectDir, `${sessionId}.jsonl`),
  });

  test("the reserved session and project folder match", () => {
    const reservation = reserve();
    expect(
      reservation.matches(
        input(join(configDir, "projects", claudeProjectKey(cwd) as string)),
      ),
    ).toBe(true);
    reservation.release();
  });

  test("through a symlinked config folder too", () => {
    const reservation = reserve();
    const link = join(root, "config-link");
    symlinkSync(configDir, link);
    expect(
      reservation.matches(
        input(join(link, "projects", claudeProjectKey(cwd) as string)),
      ),
    ).toBe(true);
    reservation.release();
  });

  test("another session id, another project folder or no transcript path do not", () => {
    const reservation = reserve();
    const projectDir = join(
      configDir,
      "projects",
      claudeProjectKey(cwd) as string,
    );
    const other = join(configDir, "projects", "-elsewhere");
    mkdirSync(other, { recursive: true });
    expect(
      reservation.matches(
        input(projectDir, "11111111-2222-4333-8444-555555555555"),
      ),
    ).toBe(false);
    expect(
      reservation.matches({ ...input(projectDir), session_id: "other" }),
    ).toBe(false);
    expect(reservation.matches(input(other))).toBe(false);
    expect(reservation.matches({ session_id: SID })).toBe(false);
    expect(reservation.matches({ session_id: SID, transcript_path: 3 })).toBe(
      false,
    );
    expect(
      reservation.matches({
        session_id: SID,
        transcript_path: join(projectDir, "x.jsonl"),
      }),
    ).toBe(false);
    reservation.release();
  });
});

describe("sameReservedFile: the identity check behind stillReserved and release", () => {
  const id: ReservedFileIdentity = { dev: 1n, ino: 2n, ctimeNs: 3n };
  const stats = (over: Partial<Record<string, unknown>> = {}) => ({
    isFile: () => true,
    size: 0n,
    dev: 1n,
    ino: 2n,
    ctimeNs: 3n,
    ...over,
  });

  test("the same empty regular file matches", () => {
    expect(sameReservedFile(id, stats())).toBe(true);
  });

  test("each difference alone is another file", () => {
    // Deterministic: Linux may reuse the inode, so ctime and size must count
    // on their own.
    expect(sameReservedFile(id, stats({ ctimeNs: 4n }))).toBe(false);
    expect(sameReservedFile(id, stats({ size: 1n }))).toBe(false);
    expect(sameReservedFile(id, stats({ ino: 9n }))).toBe(false);
    expect(sameReservedFile(id, stats({ dev: 9n }))).toBe(false);
    expect(sameReservedFile(id, stats({ isFile: () => false }))).toBe(false);
  });
});

describe("stillReserved and inspect: the reservation during the run", () => {
  test("the untouched reservation is still reserved", () => {
    const reservation = reserve();
    expect(reservation.stillReserved()).toBe(true);
    expect(reservation.inspect()).toBe("reserved");
    reservation.release();
  });

  test("a removed file is not", () => {
    const reservation = reserve();
    rmSync(reservation.path);
    expect(reservation.stillReserved()).toBe(false);
    expect(reservation.inspect()).toBe("missing");
    reservation.release();
  });

  test("a folder in its place is not, and is reported as a folder", () => {
    const reservation = reserve();
    rmSync(reservation.path);
    mkdirSync(join(reservation.path, "tool-results"), { recursive: true });
    expect(reservation.stillReserved()).toBe(false);
    expect(reservation.inspect()).toBe("folder");
    reservation.release();
    expect(existsSync(join(reservation.path, "tool-results"))).toBe(true);
  });

  test("another file in its place is not", () => {
    const reservation = reserve();
    rmSync(reservation.path);
    writeFileSync(reservation.path, "x");
    expect(reservation.stillReserved()).toBe(false);
    expect(reservation.inspect()).toBe("other");
    reservation.release();
  });
});

describe("scrubLeftover: a spill folder that appeared anyway", () => {
  const SECRET = "spill-guard-canary-77a1c2d9";
  const scrub = (text: string) => text.split(SECRET).join("[redacted]");

  test("rewrites every regular file under the folder, and keeps the folder", () => {
    const reservation = reserve();
    rmSync(reservation.path);
    const dir = join(reservation.path, "tool-results");
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "a.txt"), `echo ${SECRET} end`);
    writeFileSync(join(dir, "nested", "b.json"), `{"h":"${SECRET}"}`);
    writeFileSync(join(dir, "clean.txt"), "nothing here");
    const result = reservation.scrubLeftover(scrub);
    expect(result).toEqual({ files: 3, rewritten: 2 });
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe(
      "echo [redacted] end",
    );
    expect(readFileSync(join(dir, "nested", "b.json"), "utf8")).not.toContain(
      SECRET,
    );
    expect(existsSync(dir)).toBe(true);
    reservation.release();
  });

  test("does not follow a symlink out of the folder", () => {
    const reservation = reserve();
    rmSync(reservation.path);
    const outside = join(root, "outside.txt");
    writeFileSync(outside, `keep ${SECRET}`);
    mkdirSync(reservation.path);
    symlinkSync(outside, join(reservation.path, "link.txt"));
    symlinkSync(root, join(reservation.path, "dir-link"));
    expect(reservation.scrubLeftover(scrub)).toEqual({
      files: 0,
      rewritten: 0,
    });
    expect(readFileSync(outside, "utf8")).toBe(`keep ${SECRET}`);
    reservation.release();
  });

  test("nothing to do while reserved, or for a symlink at the path", () => {
    const reservation = reserve();
    expect(reservation.scrubLeftover(scrub)).toEqual({
      files: 0,
      rewritten: 0,
    });
    rmSync(reservation.path);
    writeFileSync(join(root, "beside.txt"), `keep ${SECRET}`);
    symlinkSync(root, reservation.path);
    expect(reservation.scrubLeftover(scrub)).toEqual({
      files: 0,
      rewritten: 0,
    });
    expect(readFileSync(join(root, "beside.txt"), "utf8")).toBe(
      `keep ${SECRET}`,
    );
    rmSync(reservation.path);
    reservation.release();
  });
});
