import { describe, expect, test } from "bun:test";

type InheritanceModule =
  typeof import("../../src/agents/permissions/inheritance.js");

const REGISTRY_KEY = Symbol.for("adk-llm-bridge.permissions.inheritance.v1");

// Distinct query strings give distinct module instances, like the duplicated
// copies the bundler emits into several entry points.
async function loadCopy(tag: string): Promise<InheritanceModule> {
  return (await import(
    `../../src/agents/permissions/inheritance.ts?copy=${tag}`
  )) as InheritanceModule;
}

describe("permission inheritance registry is process-wide", () => {
  test("a policy set through one module instance is visible through another", async () => {
    const [a, b] = await Promise.all([loadCopy("a"), loadCopy("b")]);
    expect(a).not.toBe(b);
    expect(a.setInheritedPermissions).not.toBe(b.setInheritedPermissions);

    const session = {};
    a.setInheritedPermissions(session, { mode: "read-only" });

    expect(b.getInheritedPermissions(session)).toEqual({ mode: "read-only" });
    expect(
      b.resolveEffectivePermissions(session, {
        mode: "full-access",
        allowNetwork: true,
      }),
    ).toEqual({ mode: "read-only", allowNetwork: false });
  });

  test("inheritSessionPermissions works across copies and only narrows", async () => {
    const [a, b] = await Promise.all([loadCopy("c"), loadCopy("d")]);
    const parent = {};
    const child = {};
    a.setInheritedPermissions(parent, { mode: "workspace-write" });
    b.inheritSessionPermissions(parent, child);
    expect(a.getInheritedPermissions(child)?.mode).toBe("workspace-write");

    a.setInheritedPermissions(child, {
      mode: "full-access",
      allowNetwork: true,
    });
    expect(b.getInheritedPermissions(child)?.mode).toBe("workspace-write");
  });

  test("the registry is non-enumerable, non-writable and never replaced", async () => {
    const mod = await loadCopy("e");
    mod.setInheritedPermissions({}, { mode: "ask" });

    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      REGISTRY_KEY,
    );
    expect(descriptor).toBeDefined();
    expect(descriptor?.enumerable).toBe(false);
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
    expect(Object.getOwnPropertySymbols(globalThis)).toContain(REGISTRY_KEY);
    expect(() => {
      (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = new WeakMap();
    }).toThrow();
  });

  test("a loaded copy keeps using the existing registry", async () => {
    const before = (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];
    const mod = await loadCopy("f");
    const session = {};
    mod.setInheritedPermissions(session, { mode: "ask" });
    expect((globalThis as Record<symbol, unknown>)[REGISTRY_KEY]).toBe(before);
    expect((before as WeakMap<object, unknown>).has(session)).toBe(true);
  });

  test("stored and derived policies are deep-frozen", async () => {
    const mod = await loadCopy("g");
    const session = {};
    const allowedPaths = ["/repo"];
    mod.setInheritedPermissions(session, {
      mode: "workspace-write",
      allowedPaths,
    });

    const stored = mod.getInheritedPermissions(session);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.allowedPaths)).toBe(true);
    // The caller's array is copied, not frozen or aliased.
    expect(Object.isFrozen(allowedPaths)).toBe(false);
    expect(stored?.allowedPaths).not.toBe(allowedPaths);
    expect(() => {
      (stored as { mode: string }).mode = "full-access";
    }).toThrow();

    const effective = mod.resolveEffectivePermissions(session, {
      mode: "full-access",
    });
    expect(Object.isFrozen(effective)).toBe(true);
  });

  test("a look-alike object parked on the registry key fails closed", async () => {
    const script = `
      Object.defineProperty(globalThis, Symbol.for("adk-llm-bridge.permissions.inheritance.v1"), {
        value: { get() {}, set() {}, has() { return false; } },
      });
      const m = await import(${JSON.stringify(
        new URL("../../src/agents/permissions/inheritance.ts", import.meta.url)
          .href,
      )});
      try { m.getInheritedPermissions({}); console.log("no-throw"); }
      catch (error) { console.log("throws:" + error.message); }
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain("throws:");
    expect(out).toContain("corrupted");
  });
});
