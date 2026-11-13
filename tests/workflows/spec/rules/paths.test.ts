import { describe, expect, test } from "bun:test";
import type { RunSpecIssue } from "../../../../src/workflows/spec/issues.js";
import {
  checkPathRules,
  MAX_GLOB_MATCH_WORK,
} from "../../../../src/workflows/spec/rules/paths.js";
import {
  RUN_SPEC_LIMITS,
  type RunRules,
  type RunSpec,
} from "../../../../src/workflows/spec/schema.js";
import { testRules, validSpec, wideSpec } from "../helpers.js";

function run(spec: RunSpec, rules: RunRules = testRules()): RunSpecIssue[] {
  const issues: RunSpecIssue[] = [];
  checkPathRules(spec, rules, issues);
  return issues;
}

function withPaths(...lanePaths: string[][]): RunSpec {
  const spec = validSpec();
  spec.lanes = spec.lanes.map((lane, index) => ({
    ...lane,
    allowedPaths: lanePaths[index] ?? lane.allowedPaths,
  }));
  return spec;
}

function codes(issues: RunSpecIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function onlyCode(spec: RunSpec, code: string, path: (string | number)[]) {
  const issues = run(spec);
  expect(codes(issues)).toEqual([code]);
  expect(issues[0]?.path).toEqual(path);
}

const lane0 = (index: number) => ["lanes", 0, "allowedPaths", index];

describe("checkPathRules: valid input", () => {
  test("reports nothing for the valid spec", () => {
    expect(run(validSpec())).toEqual([]);
  });

  test("accepts names that only resemble denied names", () => {
    const spec = withPaths(["src/environment", "src/keystone", "src/envoy"]);
    expect(run(spec)).toEqual([]);
  });

  test("accepts a root of dot and a nested root", () => {
    expect(run({ ...validSpec(), projectRoot: "." })).toEqual([]);
    expect(run({ ...validSpec(), projectRoot: "packages/app" })).toEqual([]);
  });

  test("does not flag siblings whose names share a prefix", () => {
    const spec = withPaths(["a"], ["a-b", "ab"]);
    expect(run(spec)).toEqual([]);
  });

  test("does not mutate the spec or the rules", () => {
    const spec = validSpec();
    const rules = testRules();
    const before = JSON.stringify([spec, rules]);
    run(spec, rules);
    expect(JSON.stringify([spec, rules])).toBe(before);
  });

  test("appends to issues already present", () => {
    const existing: RunSpecIssue[] = [
      { code: "RUN_SPEC_INVALID_VALUE", path: [], message: "x" },
    ];
    checkPathRules(withPaths(["/etc"]), testRules(), existing);
    expect(existing).toHaveLength(2);
    expect(existing[0]?.code).toBe("RUN_SPEC_INVALID_VALUE");
  });
});

describe("RUN_SPEC_PATH_ABSOLUTE", () => {
  for (const bad of [
    "/etc/passwd",
    "/",
    "C:/x",
    "c:/x",
    "C:\\x",
    "//host/share",
  ]) {
    test(`rejects allowed path ${JSON.stringify(bad)}`, () => {
      const issues = run(withPaths([bad]));
      expect(codes(issues)).toContain("RUN_SPEC_PATH_ABSOLUTE");
      expect(
        issues.find((i) => i.code === "RUN_SPEC_PATH_ABSOLUTE")?.path,
      ).toEqual(lane0(0));
    });
  }

  test("rejects an absolute project root at the root path", () => {
    onlyCode(
      { ...validSpec(), projectRoot: "/repo" },
      "RUN_SPEC_PATH_ABSOLUTE",
      ["projectRoot"],
    );
  });

  test("points at the entry index, not the first entry", () => {
    const issues = run(withPaths(["src/api", "/etc"]));
    expect(issues.map((i) => i.path)).toContainEqual(lane0(1));
  });
});

describe("RUN_SPEC_PATH_TRAVERSAL", () => {
  for (const bad of [
    "../x",
    "src/../x",
    "src/..",
    "a/b/../../..",
    "..",
    "src/../../etc",
  ]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      const issues = run(withPaths([bad]));
      expect(codes(issues)).toContain("RUN_SPEC_PATH_TRAVERSAL");
    });
  }

  test("rejects traversal even when it stays inside the root", () => {
    onlyCode(
      withPaths(["src/../src/api"]),
      "RUN_SPEC_PATH_TRAVERSAL",
      lane0(0),
    );
  });

  test("rejects traversal in the project root", () => {
    onlyCode(
      { ...validSpec(), projectRoot: "../outside" },
      "RUN_SPEC_PATH_TRAVERSAL",
      ["projectRoot"],
    );
  });

  test("does not read dots inside a name as traversal", () => {
    expect(run(withPaths(["src/..a", "docs/a..b"]))).toEqual([]);
  });

  for (const [name, bad] of [
    ["dot-dot and a trailing space", ".. /x"],
    ["dot-dot and trailing dots", "src/.../x"],
    ["dot-dot, a space and a dot", "src/.. ./x"],
    ["percent-encoded dots", "%2e%2e/x"],
    ["upper-case percent-encoded dots", "src/%2E%2E/x"],
    ["a percent-encoded slash", "src/..%2fx"],
    ["a percent-encoded backslash", "src/..%5Cx"],
    ["fullwidth full stops", "\uff0e\uff0e/x"],
    ["a two dot leader", "src/\u2025/x"],
    ["ideographic full stops", "\u3002\u3002/x"],
    ["a fullwidth solidus", "..\uff0fx"],
    ["a fullwidth reverse solidus", "..\uff3cx"],
    ["a division slash", "..\u2215x"],
    ["a fraction slash", "src/..\u2044x"],
  ]) {
    test(`rejects a segment that a host reads as dot-dot: ${name}`, () => {
      onlyCode(withPaths([bad as string]), "RUN_SPEC_PATH_TRAVERSAL", lane0(0));
    });
  }

  test("rejects a dot-dot alias in the project root", () => {
    onlyCode(
      { ...validSpec(), projectRoot: "%2e%2e/outside" },
      "RUN_SPEC_PATH_TRAVERSAL",
      ["projectRoot"],
    );
  });

  test("accepts names that only contain those characters", () => {
    const spec = withPaths([
      "src/%2ea",
      "src/a%2e%2e",
      "src/v1.2",
      "src/a \u2215 b",
      "src/\uff0ea",
      "docs/50%25",
    ]);
    expect(run(spec)).toEqual([]);
  });
});

describe("RUN_SPEC_PATH_BACKSLASH", () => {
  for (const bad of ["src\\api", "src\\..\\x", "a/b\\c"]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      const issues = run(withPaths([bad]));
      expect(codes(issues)).toContain("RUN_SPEC_PATH_BACKSLASH");
    });
  }

  test("reports the exact path of a backslash entry", () => {
    onlyCode(withPaths(["src\\api"]), "RUN_SPEC_PATH_BACKSLASH", lane0(0));
  });

  test("never reads a backslash as a separator for overlap", () => {
    const issues = run(withPaths(["src\\api"], ["src/api"]));
    expect(codes(issues)).not.toContain("RUN_SPEC_PATH_OVERLAP");
    expect(codes(issues)).toContain("RUN_SPEC_PATH_BACKSLASH");
  });
});

describe("RUN_SPEC_PATH_NOT_CANONICAL", () => {
  for (const bad of [
    "src//api",
    "./src",
    "src/",
    "src/./api",
    "src/api/.",
    "a///b",
  ]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      const issues = run(withPaths([bad]));
      expect(codes(issues)).toEqual(["RUN_SPEC_PATH_NOT_CANONICAL"]);
      expect(issues[0]?.path).toEqual(lane0(0));
    });
  }

  test("rejects a trailing slash on the project root", () => {
    onlyCode(
      { ...validSpec(), projectRoot: "pkg/" },
      "RUN_SPEC_PATH_NOT_CANONICAL",
      ["projectRoot"],
    );
  });

  test("a non-canonical path is not silently rewritten for overlap", () => {
    // "src/api/" and "src/api" must not be merged into one valid path.
    const issues = run(withPaths(["src/api/"], ["src/api"]));
    expect(codes(issues)).toContain("RUN_SPEC_PATH_NOT_CANONICAL");
  });
});

describe("RUN_SPEC_PATH_ROOT_NOT_ALLOWED", () => {
  test("rejects a lane that names the project root", () => {
    onlyCode(withPaths(["."]), "RUN_SPEC_PATH_ROOT_NOT_ALLOWED", lane0(0));
  });

  test("keeps dot valid as the project root", () => {
    expect(run({ ...validSpec(), projectRoot: "." })).toEqual([]);
  });

  test("rejects the root listed beside a real path", () => {
    const issues = run(withPaths(["src/api", "."]));
    expect(codes(issues)).toContain("RUN_SPEC_PATH_ROOT_NOT_ALLOWED");
    expect(issues.map((i) => i.path)).toContainEqual(lane0(1));
  });
});

describe("RUN_SPEC_PATH_INVALID", () => {
  for (const [name, bad] of [
    ["a NUL character", "src/a\u0000b"],
    ["a trailing NUL", "src/api\u0000"],
    ["an empty string", ""],
    ["spaces only", "  "],
    ["a tab only", "\t"],
  ] as const) {
    test(`rejects ${name}`, () => {
      const issues = run(withPaths([bad]));
      expect(codes(issues)).toContain("RUN_SPEC_PATH_INVALID");
      expect(
        issues.find((i) => i.code === "RUN_SPEC_PATH_INVALID")?.path,
      ).toEqual(lane0(0));
    });
  }

  for (const bad of ["", "a\u0000b"]) {
    test(`reports a lane path on its own when the root is invalid (${JSON.stringify(bad)})`, () => {
      const issues = run({ ...withPaths([bad]), projectRoot: "/repo" });
      expect(
        issues.some(
          (i) =>
            i.code === "RUN_SPEC_PATH_INVALID" &&
            JSON.stringify(i.path) === JSON.stringify(lane0(0)),
        ),
      ).toBe(true);
      expect(
        issues.some(
          (i) =>
            i.code === "RUN_SPEC_PATH_ABSOLUTE" &&
            i.path.length === 1 &&
            i.path[0] === "projectRoot",
        ),
      ).toBe(true);
    });
  }

  test("rejects a blank project root", () => {
    const issues = run({ ...validSpec(), projectRoot: " " });
    expect(codes(issues)).toContain("RUN_SPEC_PATH_INVALID");
    expect(issues[0]?.path).toEqual(["projectRoot"]);
  });

  test("rejects a root and a path that join above 4,096 characters", () => {
    const root = "r".repeat(2_000);
    const path = "p".repeat(2_100);
    const issues = run({ ...withPaths([path]), projectRoot: root });
    expect(codes(issues)).toContain("RUN_SPEC_PATH_INVALID");
    expect(
      issues.find((i) => i.code === "RUN_SPEC_PATH_INVALID")?.path,
    ).toEqual(lane0(0));
  });

  test("accepts a joined path of exactly 4,096 characters at the boundary", () => {
    // 4,095 + "/" + 0 would be invalid; this one is root + "/" + path = 4,096.
    const root = "r".repeat(2_000);
    const path = "p".repeat(4_096 - 2_001);
    const issues = run({ ...withPaths([path]), projectRoot: root });
    expect(codes(issues)).not.toContain("RUN_SPEC_PATH_INVALID");
  });

  test("handles a huge path without throwing and keeps the message short", () => {
    const huge = "a".repeat(1_000_000);
    const issues = run(withPaths([huge]));
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.message.length).toBeLessThanOrEqual(512);
    }
  });

  test("handles a path of a million segments without throwing", () => {
    const huge = "a/".repeat(500_000).concat("a");
    const issues = run(withPaths([huge]));
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("hidden characters in paths", () => {
  const hidden: [string, string][] = [
    ["a newline", "src/a\nb"],
    ["an escape sequence", "src/\u001b[31ma"],
    ["a delete character", "src/a\u007f"],
    ["a right-to-left override", "src/\u202eab"],
    ["a zero-width space alone", "\u200b"],
    ["a zero-width non-joiner", "src/a\u200cpi"],
    ["a byte order mark", "\ufeffsrc/a"],
    ["a soft hyphen", "src/a\u00adb"],
    ["a line separator", "src/a\u2028b"],
    ["a lone high surrogate", "src/\ud800"],
    ["a lone low surrogate", "src/\udc00"],
  ];

  test.each(hidden)("rejects an allowed path with %s", (_name, path) => {
    onlyCode(withPaths([path]), "RUN_SPEC_PATH_INVALID", lane0(0));
  });

  test("rejects a project root with a hidden character", () => {
    const spec = validSpec();
    spec.projectRoot = "pkg\u200b";
    expect(codes(run(spec))).toEqual(["RUN_SPEC_PATH_INVALID"]);
    expect(run(spec)[0]?.path).toEqual(["projectRoot"]);
  });

  test("never echoes the path in the message", () => {
    const [issue] = run(withPaths(["src/secret\u202eab"]));
    expect(issue?.message).not.toContain("secret");
  });

  test("also reports a denied name hidden by an ignorable character", () => {
    for (const path of [".g\u200cit/hooks", "\ufeff.env", "src/.e\u200dnv"]) {
      expect(codes(run(withPaths([path])))).toEqual([
        "RUN_SPEC_PATH_INVALID",
        "RUN_SPEC_PATH_DENIED",
      ]);
    }
  });

  test("leaves paths with hidden characters out of the overlap pass", () => {
    const spec = withPaths(["src/a\u200cpi/v1"], ["src/api"]);
    expect(codes(run(spec))).toEqual(["RUN_SPEC_PATH_INVALID"]);
    const surrogates = withPaths(["src/\ud800"], ["src/\ud801"]);
    expect(codes(run(surrogates))).toEqual([
      "RUN_SPEC_PATH_INVALID",
      "RUN_SPEC_PATH_INVALID",
    ]);
  });

  test("accepts visible non-ASCII names", () => {
    expect(run(withPaths(["src/caf\u00e9", "docs/\u65e5\u672c"]))).toEqual([]);
  });
});

describe("RUN_SPEC_PATH_DENIED", () => {
  for (const bad of [
    ".env",
    ".env.local",
    "config/.env",
    "config/.ENV.local",
    ".Env",
    "keys/id_rsa",
    "keys/id_rsa.pub",
    "keys/ID_ED25519",
    "certs/server.pem",
    "certs/SERVER.PEM",
    "certs/a.key",
    "store/a.p12",
    ".ssh",
    ".ssh/config",
    "home/.aws/credentials",
    ".npmrc",
    ".netrc",
    ".git",
    ".git/hooks",
    "credentials.json",
    "secrets.yaml",
    "deep/er/.gnupg/x",
  ]) {
    test(`denies ${JSON.stringify(bad)}`, () => {
      const issues = run(withPaths([bad]));
      expect(codes(issues)).toEqual(["RUN_SPEC_PATH_DENIED"]);
      expect(issues[0]?.path).toEqual(lane0(0));
    });
  }

  test("denies a secret segment of the project root", () => {
    onlyCode({ ...validSpec(), projectRoot: ".ssh" }, "RUN_SPEC_PATH_DENIED", [
      "projectRoot",
    ]);
  });

  test("denies when only the root segment is secret and the path is clean", () => {
    const issues = run({ ...validSpec(), projectRoot: "app/.env" });
    expect(codes(issues)).toContain("RUN_SPEC_PATH_DENIED");
  });

  test("matches on any segment, not only the last", () => {
    onlyCode(
      withPaths([".aws/nested/deeper/file.txt"]),
      "RUN_SPEC_PATH_DENIED",
      lane0(0),
    );
  });

  test("does not match a pattern across a slash", () => {
    // "id_rsa*" must not match "id_/rsa", and "*.pem" is per segment.
    expect(run(withPaths(["id_/rsa", "x.pe/m"]))).toEqual([]);
  });

  test("does not deny a name that merely contains a pattern in the middle", () => {
    expect(
      run(withPaths(["src/my.environment", "src/pem", "src/a.pem.txt"])),
    ).toEqual([]);
  });

  test("folds Unicode composition before matching", () => {
    const rules = { ...testRules(), deniedPathPatterns: ["caf\u00e9"] };
    const issues = run(withPaths(["src/cafe\u0301"]), rules);
    expect(codes(issues)).toContain("RUN_SPEC_PATH_DENIED");
  });

  test("folds case of a configured pattern", () => {
    const rules = { ...testRules(), deniedPathPatterns: ["Vault"] };
    expect(codes(run(withPaths(["src/VAULT"]), rules))).toContain(
      "RUN_SPEC_PATH_DENIED",
    );
  });

  test("does not treat a pattern as a regular expression", () => {
    const rules = {
      ...testRules(),
      deniedPathPatterns: ["a.c", "(x+)+$", "[ab]"],
    };
    expect(run(withPaths(["src/abc", "src/xxxx", "src/a"]), rules)).toEqual([]);
    expect(codes(run(withPaths(["src/a.c"]), rules))).toContain(
      "RUN_SPEC_PATH_DENIED",
    );
  });

  test("a pattern with many stars finishes quickly on a long name", () => {
    const rules = {
      ...testRules(),
      deniedPathPatterns: ["*a*a*a*a*a*a*a*a*b"],
    };
    const start = performance.now();
    const issues = run(withPaths(["a".repeat(4_000)]), rules);
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(issues).toEqual([]);
  });

  test("an empty deniedPathPatterns list denies nothing", () => {
    const rules = { ...testRules(), deniedPathPatterns: [] };
    expect(run(withPaths([".env", "id_rsa"]), rules)).toEqual([]);
  });

  test("denies names a platform may normalize to a secret", () => {
    // Trailing dot or space is dropped by some file systems: ".env." is ".env".
    for (const bad of [".env.", ".env ", "src/.ssh. "]) {
      expect(codes(run(withPaths([bad])))).toEqual(["RUN_SPEC_PATH_DENIED"]);
    }
    expect(codes(run(withPaths([".env\u0000"])))).toEqual([
      "RUN_SPEC_PATH_INVALID",
    ]);
    expect(codes(run(withPaths([".env/"])))).toEqual([
      "RUN_SPEC_PATH_NOT_CANONICAL",
    ]);
  });

  test("denies alternate data stream spellings of a secret", () => {
    for (const bad of [".env::$DATA", ".env:x", "a/.ssh:stream"]) {
      expect(codes(run(withPaths([bad])))).toEqual(["RUN_SPEC_PATH_DENIED"]);
    }
  });

  test("folds characters that only fold to ASCII under full case folding", () => {
    // U+017F (long s) is the same letter as "s" on case-insensitive volumes.
    for (const bad of [
      ".\u017f\u017fh",
      "keys/id_r\u017fa",
      "\u017fecrets.yaml",
    ]) {
      expect(codes(run(withPaths([bad])))).toEqual(["RUN_SPEC_PATH_DENIED"]);
    }
  });

  test("matches a middle part that ends right where the suffix begins", () => {
    const rules = { ...testRules(), deniedPathPatterns: ["a*b*c"] };
    expect(codes(run(withPaths(["src/abc"]), rules))).toEqual([
      "RUN_SPEC_PATH_DENIED",
    ]);
    expect(run(withPaths(["src/ac", "src/abx"]), rules)).toEqual([]);
  });

  test("reads percent-encoded dots, as the traversal check does, and no other escape", () => {
    // A URL-decoding layer opens "%2Eenv" as ".env"; "%45" is not decoded.
    expect(codes(run(withPaths(["%2Eenv"])))).toEqual(["RUN_SPEC_PATH_DENIED"]);
    expect(codes(run(withPaths([".%45nv"])))).not.toContain(
      "RUN_SPEC_PATH_DENIED",
    );
  });

  test("denies a name in the widened reading of the traversal check", () => {
    // Fullwidth and ideographic full stops (NFKC, best-fit code pages) and
    // percent-encoded dots read as ".".
    for (const bad of [
      "src/\uff0egit",
      "src/\u3002env",
      "src/%2eenv",
      "src/%2Essh",
      "src/\uff0e\uff53\uff53\uff48",
      "src%2f.env",
    ]) {
      expect(codes(run(withPaths([bad])))).toEqual(["RUN_SPEC_PATH_DENIED"]);
    }
  });

  test("the widened reading denies nothing the patterns do not name", () => {
    expect(
      run(withPaths(["src/\uff05", "src/%2egitx", "src/\uff41pi"])),
    ).toEqual([]);
  });

  test("reports each denied entry separately", () => {
    const issues = run(withPaths([".env", "src/api", "x/.ssh"]));
    expect(issues.map((i) => i.path)).toEqual([lane0(0), lane0(2)]);
  });
});

describe("RUN_SPEC_PATH_DENIED: Windows short names", () => {
  test("denies a segment shaped like an 8.3 short name, such as GIT~1", () => {
    for (const path of [
      "GIT~1/hooks",
      "src/GIT~1",
      "src/progra~2/x",
      "a/ENV~1.TXT",
      "src/abcd~123",
    ]) {
      const issues = run(withPaths([path]));
      expect(codes(issues)).toEqual(["RUN_SPEC_PATH_DENIED"]);
      expect(issues[0]?.message).toContain("short name");
    }
  });

  test("denies a short-name projectRoot", () => {
    const spec = validSpec();
    spec.projectRoot = "PROJEC~1";
    expect(codes(run(spec))).toContain("RUN_SPEC_PATH_DENIED");
  });

  test("denies short names even when the rule set denies nothing", () => {
    const rules = testRules();
    rules.deniedPathPatterns = [];
    expect(codes(run(withPaths(["GIT~1"]), rules))).toEqual([
      "RUN_SPEC_PATH_DENIED",
    ]);
  });

  test("accepts a tilde that is not a short-name suffix", () => {
    for (const path of [
      "src/~1",
      "src/a~",
      "src/a~b",
      "src/abcdefg~1",
      "src/a~1x",
      "src/a.b~1",
      "src/abcd~1234",
    ]) {
      expect(run(withPaths([path]))).toEqual([]);
    }
  });
});

describe("RUN_SPEC_PATH_DENIED: default patterns", () => {
  test.each([
    ".envrc",
    ".env-production",
    "env.local",
    ".gitconfig",
    ".yarnrc.yml",
    "prod.env",
    "secrets",
    "secret",
    "credentials",
    "credentials.toml",
    "application_default_credentials.json",
    ".kube",
    "kubeconfig",
    ".docker",
    ".pgpass",
    ".my.cnf",
    ".htpasswd",
    ".vault-token",
    ".s3cfg",
    ".boto",
    ".azure",
    ".terraformrc",
    "terraform.tfstate",
    "terraform.tfstate.backup",
    "prod.tfvars",
    "deploy.ppk",
    "AuthKey_ABC.p8",
    "service.keytab",
    "vault.kdbx",
  ])("denies %s by default", (name) => {
    onlyCode(withPaths([`config/${name}`]), "RUN_SPEC_PATH_DENIED", lane0(0));
  });

  test("does not deny names that only resemble the new patterns", () => {
    const spec = withPaths([
      "src/environment",
      "src/secretary",
      "src/credential-form",
      "src/docker-compose",
      "src/kube-client",
      "src/env.ts",
    ]);
    expect(run(spec)).toEqual([]);
  });
});

describe("RUN_SPEC_PATH_DUPLICATE", () => {
  test("flags an exact repeat on the later entry", () => {
    onlyCode(
      withPaths(["src/api", "src/api"]),
      "RUN_SPEC_PATH_DUPLICATE",
      lane0(1),
    );
  });

  test("flags a nested path in one lane", () => {
    const issues = run(withPaths(["src/api", "src/api/v1"]));
    expect(codes(issues)).toEqual(["RUN_SPEC_PATH_DUPLICATE"]);
    expect(issues[0]?.path).toEqual(lane0(1));
  });

  test("flags a repeat that differs only in case", () => {
    const issues = run(withPaths(["src/api", "SRC/API"]));
    expect(codes(issues)).toEqual(["RUN_SPEC_PATH_DUPLICATE"]);
    expect(issues[0]?.path).toEqual(lane0(1));
  });

  test("flags a repeat that differs only in Unicode composition", () => {
    const issues = run(withPaths(["src/caf\u00e9", "src/cafe\u0301"]));
    expect(codes(issues)).toContain("RUN_SPEC_PATH_DUPLICATE");
  });

  test("flags the ancestor listed after the descendant on the later entry", () => {
    const issues = run(withPaths(["src/api/v1", "src/api"]));
    expect(codes(issues)).toEqual(["RUN_SPEC_PATH_DUPLICATE"]);
  });

  test("does not flag siblings in one lane", () => {
    expect(run(withPaths(["src/a", "src/a-b", "src/ab", "src/a.b"]))).toEqual(
      [],
    );
  });

  test("reports the same-lane case as DUPLICATE and not OVERLAP", () => {
    const issues = run(withPaths(["src/api", "src/api"]));
    expect(codes(issues)).not.toContain("RUN_SPEC_PATH_OVERLAP");
  });
});

describe("RUN_SPEC_PATH_OVERLAP", () => {
  test("flags equal paths in two lanes", () => {
    const issues = run(withPaths(["src/api"], ["src/api"]));
    expect(codes(issues)).toEqual(["RUN_SPEC_PATH_OVERLAP"]);
  });

  test("flags a path nested below another lane's path", () => {
    const issues = run(withPaths(["src/api"], ["src/api/v1"]));
    expect(codes(issues)).toEqual(["RUN_SPEC_PATH_OVERLAP"]);
    expect(issues[0]?.path).toEqual(["lanes", 1, "allowedPaths", 0]);
  });

  test("flags a path above another lane's path", () => {
    const issues = run(withPaths(["src/api/v1"], ["src"]));
    expect(codes(issues)).toEqual(["RUN_SPEC_PATH_OVERLAP"]);
  });

  test("flags paths that differ only in case", () => {
    expect(codes(run(withPaths(["src/api"], ["Src/Api"])))).toEqual([
      "RUN_SPEC_PATH_OVERLAP",
    ]);
  });

  test("flags a nested path that differs in case", () => {
    expect(codes(run(withPaths(["src/api"], ["SRC/API/V1"])))).toEqual([
      "RUN_SPEC_PATH_OVERLAP",
    ]);
  });

  test("flags paths that differ only in a full case fold", () => {
    expect(codes(run(withPaths(["src/api"], ["\u017frc/api"])))).toEqual([
      "RUN_SPEC_PATH_OVERLAP",
    ]);
  });

  for (const [name, alias] of [
    ["a trailing dot", "src/api./v1"],
    ["trailing dots and spaces", "src/api. ./v1"],
    ["a trailing space", "src/api /v1"],
    ["an NTFS stream suffix", "src/api::$INDEX_ALLOCATION/v1"],
    ["a named stream", "src/api:stream"],
  ]) {
    test(`flags a path that Windows opens as another lane's path: ${name}`, () => {
      onlyCode(
        withPaths(["src/api"], [alias as string]),
        "RUN_SPEC_PATH_OVERLAP",
        ["lanes", 1, "allowedPaths", 0],
      );
    });
  }

  test("flags a repeat in one lane that differs only in a trailing dot", () => {
    onlyCode(
      withPaths(["src/api", "src/api."]),
      "RUN_SPEC_PATH_DUPLICATE",
      lane0(1),
    );
  });

  test("does not flag names that differ beyond trailing dots, spaces and streams", () => {
    const spec = withPaths(["src/api"], ["src/api.v1", "src/a pi", "src/.api"]);
    expect(run(spec)).toEqual([]);
  });

  test("keeps a segment that would fold to nothing as written", () => {
    expect(run(withPaths(["src/:a"], ["src/:b"]))).toEqual([]);
  });

  test("flags paths that differ only in Unicode composition", () => {
    expect(
      codes(run(withPaths(["src/caf\u00e9"], ["src/cafe\u0301/x"]))),
    ).toContain("RUN_SPEC_PATH_OVERLAP");
  });

  test("a trailing slash is rejected rather than folded into an overlap", () => {
    const issues = run(withPaths(["src/api/"], ["src/api"]));
    expect(codes(issues)).toEqual(["RUN_SPEC_PATH_NOT_CANONICAL"]);
  });

  test("does not flag a sibling that shares a string prefix", () => {
    expect(run(withPaths(["a"], ["a-b"]))).toEqual([]);
    expect(run(withPaths(["a"], ["ab"]))).toEqual([]);
    expect(run(withPaths(["a"], ["a.b"]))).toEqual([]);
  });

  test("a segment sorting between ancestor and child does not hide the overlap", () => {
    // "a-b" sorts between "a" and "a/b" under plain string order.
    const spec = withPaths(["a", "a-b"], ["a/b"]);
    const issues = run(spec);
    expect(codes(issues)).toEqual(["RUN_SPEC_PATH_OVERLAP"]);
  });

  test("flags a, a-b and a/b across lanes once, without flagging a-b", () => {
    const spec = validSpec();
    spec.lanes = [
      { ...laneAt(spec, 0), allowedPaths: ["a"] },
      { ...laneAt(spec, 1), allowedPaths: ["a-b"] },
      {
        ...laneAt(spec, 0),
        taskId: "third",
        dependsOn: [],
        allowedPaths: ["a/b"],
      },
    ];
    const issues = run(spec);
    expect(codes(issues)).toEqual(["RUN_SPEC_PATH_OVERLAP"]);
    expect(issues[0]?.path).toEqual(["lanes", 2, "allowedPaths", 0]);
  });

  test("compares each later path with the kept ancestor, not the previous path", () => {
    const spec = validSpec();
    spec.lanes = ["l0", "l1", "l2"].map((taskId, i) => ({
      ...laneAt(spec, 0),
      taskId,
      dependsOn: [],
      allowedPaths: [["src"], ["src/a"], ["src/b"]][i] ?? [],
    }));
    const issues = run(spec);
    expect(codes(issues)).toEqual([
      "RUN_SPEC_PATH_OVERLAP",
      "RUN_SPEC_PATH_OVERLAP",
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      ["lanes", 1, "allowedPaths", 0],
      ["lanes", 2, "allowedPaths", 0],
    ]);
  });

  test("names both lanes in the message", () => {
    const issues = run(withPaths(["src/api"], ["src/api/v1"]));
    expect(issues[0]?.message).toContain("api");
    expect(issues[0]?.message).toContain("docs");
  });

  test("overlap applies even when one lane depends on the other", () => {
    // docs depends on api in validSpec; ordering does not share ownership.
    expect(codes(run(withPaths(["src"], ["src/x"])))).toContain(
      "RUN_SPEC_PATH_OVERLAP",
    );
  });

  test("every pair of three overlapping lanes is covered", () => {
    const spec = validSpec();
    spec.lanes = ["l0", "l1", "l2"].map((taskId) => ({
      ...laneAt(spec, 0),
      taskId,
      dependsOn: [],
      allowedPaths: ["shared"],
    }));
    const issues = run(spec);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(new Set(codes(issues))).toEqual(new Set(["RUN_SPEC_PATH_OVERLAP"]));
    const lanes = new Set(issues.map((i) => i.path[1]));
    expect(lanes.has(1)).toBe(true);
    expect(lanes.has(2)).toBe(true);
  });

  test("invalid paths are left out of the overlap pass", () => {
    const issues = run(withPaths(["../src"], ["../src"]));
    expect(codes(issues)).not.toContain("RUN_SPEC_PATH_OVERLAP");
  });

  test("does not flag unrelated lanes of a wide spec, and does so fast", () => {
    const spec = wideSpec(1_000);
    const start = performance.now();
    const issues = run(spec);
    expect(performance.now() - start).toBeLessThan(2_000);
    expect(issues).toEqual([]);
  });

  test("finds one overlap hidden in a wide spec", () => {
    const spec = wideSpec(1_000);
    laneAt(spec, 999).allowedPaths = ["SRC/LANE-3/deep"];
    const issues = run(spec);
    expect(codes(issues)).toEqual(["RUN_SPEC_PATH_OVERLAP"]);
    expect(issues[0]?.path).toEqual(["lanes", 999, "allowedPaths", 0]);
  });
});

describe("cost", () => {
  test("checks 40 lanes of 64 paths with 2,000 segments each within the time budget", () => {
    const deep = Array(2_000).fill("a").join("/");
    const spec = wideSpec(40);
    spec.lanes.forEach((lane, laneIndex) => {
      lane.allowedPaths = Array.from(
        { length: 64 },
        (_, index) => `p${laneIndex}/q${index}/${deep}`,
      );
    });
    const started = performance.now();
    const issues = run(spec);
    expect(performance.now() - started).toBeLessThan(2_000);
    // Each path is over the segment limit, so none is matched or compared.
    expect(issues).toHaveLength(40 * 64);
    expect(new Set(codes(issues))).toEqual(new Set(["RUN_SPEC_PATH_INVALID"]));
    expect(issues[0]?.message).toContain(
      `at most ${RUN_SPEC_LIMITS.maxPathSegments} segments`,
    );
  });

  test("accepts a path at the segment limit and rejects one segment more", () => {
    const at = Array.from(
      { length: RUN_SPEC_LIMITS.maxPathSegments },
      (_, index) => `s${index}`,
    ).join("/");
    expect(run(withPaths([at]))).toEqual([]);
    expect(codes(run(withPaths([`${at}/x`])))).toEqual([
      "RUN_SPEC_PATH_INVALID",
    ]);
    const root = validSpec();
    root.projectRoot = `${at}/x`;
    expect(codes(run(root))).toContain("RUN_SPEC_PATH_INVALID");
  });

  test("matches distinct segments against many glob patterns within the time budget", () => {
    // Every segment name is new, so no remembered result helps. 1,024 paths of
    // 64 segments against 1,024 globs is the most a valid spec and rule set
    // can ask for, and it fits the matching budget.
    const rules = testRules();
    rules.deniedPathPatterns = Array.from(
      { length: 1_024 },
      (_, index) => `zz${index}*.secret`,
    );
    const spec = wideSpec(16);
    spec.lanes.forEach((lane, laneIndex) => {
      lane.allowedPaths = Array.from({ length: 64 }, (_, pathIndex) =>
        Array.from(
          { length: RUN_SPEC_LIMITS.maxPathSegments },
          (_, segment) => `l${laneIndex}p${pathIndex}s${segment}`,
        ).join("/"),
      );
    });
    const started = performance.now();
    expect(run(spec, rules)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("the matching budget covers every segment and pattern pair of a spec at the plan limits", () => {
    expect(MAX_GLOB_MATCH_WORK).toBe(
      RUN_SPEC_LIMITS.maxTotalAllowedPaths *
        RUN_SPEC_LIMITS.maxPathSegments *
        RUN_SPEC_LIMITS.maxRuleListEntries,
    );
  });

  test("denies a path it cannot match within the budget, once, and keeps checking the rest", () => {
    // The longest literal of each pattern is in every segment, so each pair is
    // a full match that fails at the end: about four units per pair.
    const rules = testRules();
    rules.deniedPathPatterns = Array.from(
      { length: 1_024 },
      (_, index) => `*${"a".repeat(40)}*q${index}`,
    );
    const spec = wideSpec(16);
    spec.lanes.forEach((lane, laneIndex) => {
      lane.allowedPaths = Array.from({ length: 64 }, (_, pathIndex) =>
        Array.from(
          { length: RUN_SPEC_LIMITS.maxPathSegments },
          (_, segment) =>
            `${"a".repeat(45)}l${laneIndex}p${pathIndex}s${segment}`,
        ).join("/"),
      );
    });
    laneAt(spec, 15).allowedPaths[63] = "x/y~1";
    const started = performance.now();
    const issues = run(spec, rules);
    expect(performance.now() - started).toBeLessThan(5_000);
    const budget = issues.filter((issue) =>
      issue.message.includes("matching budget"),
    );
    expect(budget).toHaveLength(1);
    expect(budget[0]?.code).toBe("RUN_SPEC_PATH_DENIED");
    // The short-name check does not depend on the patterns and still runs.
    expect(
      issues.some(
        (issue) =>
          issue.message.includes("short name") &&
          issue.path.join("/") === "lanes/15/allowedPaths/63",
      ),
    ).toBe(true);
  });

  test("2,048 distinct segments that contain no glob's longest literal are accepted by the literal check alone", () => {
    const rules = testRules();
    rules.deniedPathPatterns = Array.from(
      { length: 1_024 },
      (_, index) => `*${"a*".repeat(55)}-${index}*`,
    );
    let next = 0;
    const paths = Array.from({ length: 32 }, () =>
      Array.from(
        { length: 64 },
        () => `${"a".repeat(55)}${(next++).toString(36).padStart(4, "0")}`,
      ).join("/"),
    );
    const started = performance.now();
    expect(run(withPaths(paths), rules)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("1,024 distinct segments that contain the longest literal of globs with many parts are fully matched within the budget", () => {
    // Each pattern needs 55 `a` before `-q<index>`; each segment has 54, so
    // every full match runs through the parts and fails at the last `a`.
    const rules = testRules();
    rules.deniedPathPatterns = Array.from(
      { length: 1_024 },
      (_, index) => `*${"a*".repeat(55)}-q${index}*`,
    );
    const paths = Array.from({ length: 16 }, (_, pathIndex) =>
      Array.from(
        { length: 64 },
        (_, segment) => `${"a".repeat(54)}-q${pathIndex * 64 + segment}`,
      ).join("/"),
    );
    const started = performance.now();
    expect(run(withPaths(paths), rules)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5_000);
    // One more `a` and the same full match succeeds.
    expect(codes(run(withPaths([`src/${"a".repeat(55)}-q7`]), rules))).toEqual([
      "RUN_SPEC_PATH_DENIED",
    ]);
  });

  test("a glob still matches when its longest literal is in the middle", () => {
    const rules = testRules();
    rules.deniedPathPatterns = ["a*secret*z"];
    expect(codes(run(withPaths(["src/aXsecretYz"]), rules))).toEqual([
      "RUN_SPEC_PATH_DENIED",
    ]);
    // The literal alone, out of place, is not a match.
    expect(run(withPaths(["src/secretaz"]), rules)).toEqual([]);
  });
});

describe("trailing dots and spaces", () => {
  test("a run of 4,000 dots or spaces inside a segment is checked within a generous time bound", () => {
    for (const filler of [" ", "."]) {
      const paths = Array.from(
        { length: 64 },
        (_, index) => `p${index}${filler.repeat(4_000)}b`,
      );
      const started = performance.now();
      expect(run(withPaths(paths))).toEqual([]);
      // A quadratic scan of these runs takes far longer than this bound.
      expect(performance.now() - started).toBeLessThan(5_000);
    }
  });

  test("are still dropped at the end of a segment before matching", () => {
    for (const path of ["cfg/.env. . .", "cfg/.env   ", "cfg/.git...::$DATA"]) {
      expect(codes(run(withPaths([path])))).toContain("RUN_SPEC_PATH_DENIED");
    }
  });

  test("are still dropped at the end of a segment for overlap", () => {
    expect(codes(run(withPaths(["src/api"], ["src/api. ."])))).toContain(
      "RUN_SPEC_PATH_OVERLAP",
    );
  });
});

describe("reporting", () => {
  test("every code is a paths family code", () => {
    const spec = withPaths(
      ["/etc", "../x", "a\\b", "a//b", ".", "", ".env", "src/api", "src/api"],
      ["src/api"],
    );
    const issues = run(spec);
    const expected = new Set([
      "RUN_SPEC_PATH_ABSOLUTE",
      "RUN_SPEC_PATH_TRAVERSAL",
      "RUN_SPEC_PATH_BACKSLASH",
      "RUN_SPEC_PATH_NOT_CANONICAL",
      "RUN_SPEC_PATH_ROOT_NOT_ALLOWED",
      "RUN_SPEC_PATH_INVALID",
      "RUN_SPEC_PATH_DENIED",
      "RUN_SPEC_PATH_DUPLICATE",
      "RUN_SPEC_PATH_OVERLAP",
    ]);
    expect(new Set(codes(issues))).toEqual(expected);
  });

  test("reports one issue per bad entry for an unrelated set of defects", () => {
    const issues = run(withPaths(["/etc", "../x", "a\\b", "a//b", "."]));
    expect(codes(issues)).toEqual([
      "RUN_SPEC_PATH_ABSOLUTE",
      "RUN_SPEC_PATH_TRAVERSAL",
      "RUN_SPEC_PATH_BACKSLASH",
      "RUN_SPEC_PATH_NOT_CANONICAL",
      "RUN_SPEC_PATH_ROOT_NOT_ALLOWED",
    ]);
  });

  test("keeps messages short and free of the full offending value", () => {
    const secret = `src/${"s".repeat(3_000)}/../x`;
    const issues = run(withPaths([secret]));
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.message.length).toBeLessThanOrEqual(512);
    }
  });

  test("never throws on an empty allowed path list", () => {
    expect(run(withPaths([]))).toEqual([]);
  });
});

function laneAt(spec: RunSpec, index: number): RunSpec["lanes"][number] {
  const lane = spec.lanes[index];
  if (lane === undefined) throw new Error(`missing lane ${index}`);
  return lane;
}
