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
});
