import { canonicalPath, isAnchoredPath, isUnder } from "./paths.js";
import type {
  ExternalAgentPermissionMode,
  ExternalAgentPermissionPolicy,
} from "./schema.js";

const MODE_RANK: Record<ExternalAgentPermissionMode, number> = {
  "read-only": 0,
  ask: 1,
  "workspace-write": 2,
  "full-access": 3,
};

const MODES: readonly ExternalAgentPermissionMode[] = [
  "read-only",
  "ask",
  "workspace-write",
  "full-access",
];

/**
 * Computes the policy a delegated sub-agent runs with: never broader than its
 * parent's.
 *
 * @remarks
 * Fail-closed rules: the mode is the more restrictive of the two; network is
 * allowed only when both allow it; `allowedPaths` is the intersection when both
 * set it, and whichever one is set otherwise. A missing parent counts as `ask`
 * and a missing child inherits the parent's policy.
 *
 * The `allowedPaths` intersection works by containment, not string equality:
 * a child root inside a parent root is kept, and so is a parent root inside a
 * child root, so `["/repo"]` and `["/repo/src"]` give `["/repo/src"]`. Roots
 * are compared after `path.resolve` and symlink resolution, as the permission
 * guard compares them, so `..` segments and symlinks cannot leave a parent
 * root. A parent's relative roots never pass to the child: each is relative
 * to its own agent's working directory, which is not known here. So a child
 * of a parent with only relative roots gets `[]`, whether or not it sets
 * `allowedPaths`. A child's own relative roots stay when the parent sets no
 * `allowedPaths`, and are dropped when both sides set them. An empty result
 * allows no path.
 *
 * Both sides' absolute roots are also kept as `pathBounds` (with the bounds
 * either side already had). The guard checks them when a request arrives, so
 * a kept root that a symlink later points elsewhere still cannot leave the
 * parent's roots.
 *
 * Read roots (`readPaths`) follow the same rules on each side's whole read
 * set (`allowedPaths` plus `readPaths`): the child reads only where both may
 * read, a parent's read root never becomes writable for the child, and both
 * sides' absolute read roots are kept as `readPathBounds`. Policies without
 * `readPaths` or `readPathBounds` derive no read fields.
 *
 * @param parent - Policy of the delegating agent. Defaults to mode `ask`.
 * @param child - Policy the sub-agent asks for. Defaults to the parent's.
 * @returns The effective policy for the sub-agent.
 */
export function deriveSubAgentPermissionPolicy(
  parent?: ExternalAgentPermissionPolicy,
  child?: ExternalAgentPermissionPolicy,
): ExternalAgentPermissionPolicy {
  return derivePolicy(parent, child, false);
}

/**
 * {@link deriveSubAgentPermissionPolicy}, where `parentPathsAreChilds` says
 * that the parent's `allowedPaths` are the child's own roots, delegated to it
 * by a parent that set none. They are then not a bound from a parent: a
 * relative root on both sides is the same directory (both are relative to the
 * child's working directory) and is kept, and they add no `pathBounds`.
 */
function derivePolicy(
  parent: ExternalAgentPermissionPolicy | undefined,
  child: ExternalAgentPermissionPolicy | undefined,
  parentPathsAreChilds: boolean,
): ExternalAgentPermissionPolicy {
  const parentPolicy = parent ?? { mode: "ask" as const };
  const childPolicy = child ?? parentPolicy;
  const mode = moreRestrictiveMode(parentPolicy.mode, childPolicy.mode);
  const allowedPaths = deriveAllowedPaths(
    parentPolicy.allowedPaths,
    childPolicy.allowedPaths,
    parentPathsAreChilds,
  );
  const pathBounds = derivePathBounds(
    parentPolicy,
    childPolicy,
    parentPathsAreChilds,
  );
  const reads = deriveReads(
    parentPolicy,
    childPolicy,
    parentPathsAreChilds,
    allowedPaths !== undefined,
  );

  return {
    mode,
    allowNetwork: Boolean(
      parentPolicy.allowNetwork && childPolicy.allowNetwork,
    ),
    ...(allowedPaths ? { allowedPaths } : {}),
    ...(reads?.readPaths ? { readPaths: reads.readPaths } : {}),
    ...(pathBounds.length > 0 ? { pathBounds } : {}),
    ...(reads && reads.readPathBounds.length > 0
      ? { readPathBounds: reads.readPathBounds }
      : {}),
  };
}

/**
 * Every root a policy's read tools may reach (`allowedPaths` plus
 * `readPaths`), or `undefined` when its reads are not restricted by roots.
 */
function readRoots(
  policy: ExternalAgentPermissionPolicy,
): readonly string[] | undefined {
  return policy.allowedPaths
    ? [...policy.allowedPaths, ...(policy.readPaths ?? [])]
    : policy.readPaths;
}

/** The bound lists a policy's read tools are checked against. */
function readBounds(
  policy: ExternalAgentPermissionPolicy,
): readonly (readonly string[])[] {
  return policy.readPathBounds ?? policy.pathBounds ?? [];
}

/**
 * The derived `readPaths` and `readPathBounds`, when either side sets
 * `readPaths` or `readPathBounds`; `undefined` otherwise, so policies without
 * read roots derive exactly as before (reads then follow `allowedPaths` and
 * `pathBounds`).
 *
 * The read roots are the containment intersection of both sides' read roots,
 * with the same rules as `allowedPaths` (relative roots of a parent dropped).
 * The read bounds are both sides' read bounds plus both sides' absolute read
 * roots, so the child never reads where the parent could not, even after a
 * symlink is retargeted. Without derived `allowedPaths` there is no
 * `readPaths` (paths are not restricted then), but the read bounds stay.
 */
function deriveReads(
  parent: ExternalAgentPermissionPolicy,
  child: ExternalAgentPermissionPolicy,
  parentPathsAreChilds: boolean,
  hasAllowedPaths: boolean,
):
  | {
      readPaths: readonly string[] | undefined;
      readPathBounds: readonly (readonly string[])[];
    }
  | undefined {
  const involved = (policy: ExternalAgentPermissionPolicy) =>
    policy.readPaths !== undefined || policy.readPathBounds !== undefined;
  if (!involved(parent) && !involved(child)) {
    return undefined;
  }
  const parentRoots = readRoots(parent);
  const childRoots = readRoots(child);
  const readPaths = hasAllowedPaths
    ? deriveAllowedPaths(parentRoots, childRoots, parentPathsAreChilds)
    : undefined;
  const bounds = [...readBounds(parent)];
  if (child !== parent) {
    bounds.push(...readBounds(child));
    if (parentRoots && childRoots && !parentPathsAreChilds) {
      bounds.push(parentRoots.filter(isAnchoredPath));
      bounds.push(childRoots.filter(isAnchoredPath));
    }
  }
  return { readPaths, readPathBounds: bounds };
}

function moreRestrictiveMode(
  parent: ExternalAgentPermissionMode,
  child: ExternalAgentPermissionMode,
): ExternalAgentPermissionMode {
  return MODES[Math.min(MODE_RANK[parent], MODE_RANK[child])] ?? "read-only";
}

function deriveAllowedPaths(
  parent: readonly string[] | undefined,
  child: readonly string[] | undefined,
  parentPathsAreChilds: boolean,
): readonly string[] | undefined {
  if (!child) {
    // A parent's relative root is relative to the parent's working directory;
    // the child would resolve it against its own. Only anchored roots pass.
    return parent?.filter(isAnchoredPath);
  }
  if (!parent) {
    return child;
  }
  const result: string[] = [];
  const kept = new Set<string>();
  const keep = (path: string, canonical: string) => {
    if (!kept.has(canonical)) {
      kept.add(canonical);
      result.push(path);
    }
  };
  // Anchored roots do not depend on the base; it only satisfies the signature.
  const base = process.cwd();
  // A root whose symlinks cannot be resolved is dropped: it allows nothing.
  const anchored = (paths: readonly string[]) =>
    paths.filter(isAnchoredPath).flatMap((path) => {
      const canonical = canonicalPath(path, base);
      return canonical === undefined ? [] : [{ path, canonical }];
    });
  if (parentPathsAreChilds) {
    // The same relative string on both sides names the same directory here.
    for (const path of child) {
      if (!isAnchoredPath(path) && parent.includes(path)) keep(path, path);
    }
  }
  const parentRoots = anchored(parent);
  const childRoots = anchored(child);
  for (const root of childRoots) {
    if (parentRoots.some((outer) => isUnder(root.canonical, outer.canonical))) {
      keep(root.path, root.canonical);
    }
  }
  for (const root of parentRoots) {
    if (childRoots.some((outer) => isUnder(root.canonical, outer.canonical))) {
      keep(root.path, root.canonical);
    }
  }
  return result;
}

function derivePathBounds(
  parent: ExternalAgentPermissionPolicy,
  child: ExternalAgentPermissionPolicy,
  parentPathsAreChilds: boolean,
): readonly (readonly string[])[] {
  const bounds = [...(parent.pathBounds ?? [])];
  // A child without a policy inherits the parent's whole policy, bounds
  // included, so they are not added twice.
  if (child === parent) return bounds;
  bounds.push(...(child.pathBounds ?? []));
  if (parent.allowedPaths && child.allowedPaths && !parentPathsAreChilds) {
    bounds.push(parent.allowedPaths.filter(isAnchoredPath));
    bounds.push(child.allowedPaths.filter(isAnchoredPath));
  }
  return bounds;
}

/**
 * Policies inherited through delegation, keyed by the child session view that
 * `AgentInvocationGateway` creates once per delegation.
 *
 * Why a `WeakMap` on the session and not a context property: ADK rebuilds an
 * `InvocationContext` from a closed list of named fields at every hop
 * (`BaseAgent.createInvocationContext`, `InvocationContext.clone()`, the
 * Workflow node runner), so any ad-hoc property is dropped by an intermediate
 * agent (SequentialAgent, ParallelAgent, LlmAgent transfer, ...). The session
 * object, in contrast, travels by reference through all of them. It is not
 * `session.state` on purpose: tools called by the LLM can write state, which
 * would let a model raise its own privileges.
 *
 * Limitation: permission inheritance does NOT cross ADK's `AgentTool`. It runs
 * the wrapped agent in a brand new `Runner` with a new session object, which
 * restarts the chain, so an `ExternalAgent` wrapped in `AgentTool` runs with
 * its own permissions only. Expose sub-agents through `subAgents`/delegation
 * instead, or give agents wrapped in `AgentTool` an explicit policy no broader
 * than their caller's.
 *
 * Static ancestry: independently of this registry, `ExternalAgent` also caps
 * its policy by the `ExternalAgent`s above it in the agent tree (they are
 * detected by a `Symbol.for` brand, so a second copy of the class still
 * counts; an ancestor whose policy cannot be read counts as `ask`). That fold
 * covers only policies declared in the static tree (`parentAgent` links set
 * from `subAgents`). A policy granted at run time (a delegation through
 * `ToolGateway`, a workflow step, an `AgentTool` hop) reaches the agent only
 * through this session registry; an agent run on a session that does not
 * carry it is capped by its static ancestors alone.
 *
 * Other session-creating hops (e.g. the gateway that runs workflow steps) must
 * call {@link inheritSessionPermissions} when they build a new child session.
 * This module imports only `./paths.js` (Node built-ins) at run time, so
 * `src/runtime` can use it without an import cycle.
 */
const REGISTRY_KEY = Symbol.for("adk-llm-bridge.permissions.inheritance.v1");

type PolicyRegistry = WeakMap<object, ExternalAgentPermissionPolicy>;

// Captured once so a hostile object parked on the registry key cannot swap the
// methods we call (we never call `registry.get(...)`, always `WeakMap.prototype`).
const weakMapGet = WeakMap.prototype.get;
const weakMapSet = WeakMap.prototype.set;
const weakMapHas = WeakMap.prototype.has;

/**
 * Brand check: only a genuine `WeakMap` (internal slot, works across realms)
 * passes; a look-alike object with `get`/`set`/`has` methods does not.
 */
function isPolicyRegistry(value: unknown): value is PolicyRegistry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  try {
    weakMapHas.call(value, registryProbe);
    return true;
  } catch {
    return false;
  }
}

const registryProbe = {};

function deepFreezePolicy(
  policy: ExternalAgentPermissionPolicy,
): ExternalAgentPermissionPolicy {
  const copy: ExternalAgentPermissionPolicy = {
    ...policy,
    ...(policy.allowedPaths
      ? { allowedPaths: Object.freeze([...policy.allowedPaths]) }
      : {}),
    ...(policy.readPaths
      ? { readPaths: Object.freeze([...policy.readPaths]) }
      : {}),
    ...(policy.pathBounds
      ? {
          pathBounds: Object.freeze(
            policy.pathBounds.map((list) => Object.freeze([...list])),
          ),
        }
      : {}),
    ...(policy.readPathBounds
      ? {
          readPathBounds: Object.freeze(
            policy.readPathBounds.map((list) => Object.freeze([...list])),
          ),
        }
      : {}),
  };
  return Object.freeze(copy);
}

/**
 * The registry is process-wide on purpose. The published package is bundled
 * without code splitting, so this module is copied into several entry points
 * (`agents`, `workflows`, ...); a module-level `WeakMap` would then be one map
 * per copy and a policy written by one copy would be invisible to another,
 * silently dropping the inheritance. It is created lazily, defined once as a
 * non-enumerable, non-writable, non-configurable property and never replaced.
 * If something else already occupies the key with an incompatible value we
 * fail closed instead of running without inheritance.
 *
 * Per realm: `globalThis` is per realm (worker threads, `node:vm` contexts), so
 * each realm has its own registry; sessions never cross realms by reference,
 * so that is the correct scope. Stored and returned policies are deep-frozen so
 * no consumer can widen a policy in place.
 */
function policyRegistry(): PolicyRegistry {
  const host = globalThis as unknown as Record<symbol, unknown>;
  const existing = host[REGISTRY_KEY];
  if (existing !== undefined) {
    if (!isPolicyRegistry(existing)) {
      throw new Error(
        "adk-llm-bridge: the permission inheritance registry on globalThis is corrupted",
      );
    }
    return existing;
  }
  const created: PolicyRegistry = new WeakMap();
  Object.defineProperty(host, REGISTRY_KEY, {
    value: created,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return created;
}

/**
 * Records the policy delegated to the agents running on `session`. Calling it
 * again for the same session can only narrow the policy, never widen it.
 *
 * @internal
 */
export function setInheritedPermissions(
  session: object,
  policy: ExternalAgentPermissionPolicy,
): void {
  // Narrowed by someone else: the stored roots may no longer be the agent's.
  delegatedOwnRoots.delete(session);
  const registry = policyRegistry();
  const existing = weakMapGet.call(registry, session);
  weakMapSet.call(
    registry,
    session,
    deepFreezePolicy(
      existing ? deriveSubAgentPermissionPolicy(existing, policy) : policy,
    ),
  );
}

/**
 * Sessions whose inherited `allowedPaths` are the delegated agent's own roots,
 * keyed to that agent: the delegating parent set no `allowedPaths`. Only
 * {@link delegatePermissions} adds an entry and every other write to the
 * session removes it. It is a module-level map on purpose: a copy of this
 * module that does not see the entry derives as if it were absent, which
 * drops the agent's relative roots (fails closed).
 */
const delegatedOwnRoots = new WeakMap<object, object>();

/**
 * Records the policy delegated to `agent` running on its new `session`: the
 * {@link deriveSubAgentPermissionPolicy} of `parent` and the agent's own
 * `child` policy, narrowed by whatever `session` already carries.
 *
 * @remarks
 * When neither `parent` nor `session` sets `allowedPaths`, the stored roots
 * are the agent's own. The agent derives its policy again when it runs (see
 * {@link resolveEffectivePermissions}); this record lets that second pass keep
 * its own relative roots instead of dropping them as a parent's. It holds only
 * for `agent` on this `session`.
 *
 * @internal
 */
export function delegatePermissions(
  session: object,
  parent: ExternalAgentPermissionPolicy | undefined,
  child: ExternalAgentPermissionPolicy | undefined,
  agent: object,
): void {
  const before = getInheritedPermissions(session);
  setInheritedPermissions(
    session,
    deriveSubAgentPermissionPolicy(parent, child),
  );
  if (child?.allowedPaths && !parent?.allowedPaths && !before?.allowedPaths) {
    delegatedOwnRoots.set(session, agent);
  }
}

/**
 * Carries the policy inherited by `from` over to a new session `to` created
 * on its behalf (a new hop in the delegation chain). No-op when `from` has no
 * inherited policy; otherwise it can only narrow whatever `to` already has.
 *
 * @internal
 */
export function inheritSessionPermissions(
  from: object | undefined,
  to: object,
): void {
  const policy = getInheritedPermissions(from);
  if (policy) {
    setInheritedPermissions(to, policy);
  }
}

/**
 * Reads the policy delegated to the agents running on `session`.
 *
 * @param session - Session view created for a delegation, if any.
 * @returns The inherited (deep-frozen) policy, or `undefined` for a root run.
 * @internal
 */
export function getInheritedPermissions(
  session: object | undefined,
): ExternalAgentPermissionPolicy | undefined {
  return session ? weakMapGet.call(policyRegistry(), session) : undefined;
}

/**
 * Effective policy of an agent running on `session`: the intersection of its
 * own `permissions` and the inherited ones (never more permissive than the
 * delegating parent). Without inheritance (root run) the agent's own apply.
 *
 * @remarks
 * `allowNetwork` of the result is always a boolean: an unset value becomes
 * `false`, so network is off unless a policy sets `allowNetwork: true`. No
 * policy at all stays `undefined`; drivers read it as no network too (see
 * `networkAllowed`).
 *
 * The inherited `allowedPaths` bound the agent as a parent's would, except
 * when {@link delegatePermissions} recorded them as `agent`'s own roots: then
 * a relative root that both they and `own` name is kept, since both are
 * relative to the agent's working directory.
 *
 * @param session - The session the agent runs on.
 * @param own - The agent's own policy, already capped by its static ancestors.
 * @param agent - The agent that runs, matched against the delegation record.
 * @returns The effective policy, or `undefined` when there is none.
 * @internal
 */
export function resolveEffectivePermissions(
  session: object | undefined,
  own: ExternalAgentPermissionPolicy | undefined,
  agent?: object,
): ExternalAgentPermissionPolicy | undefined {
  const inherited = getInheritedPermissions(session);
  if (inherited) {
    const ownRoots =
      session !== undefined &&
      agent !== undefined &&
      delegatedOwnRoots.get(session) === agent;
    return deepFreezePolicy(derivePolicy(inherited, own, ownRoots));
  }
  return own && typeof own.allowNetwork !== "boolean"
    ? { ...own, allowNetwork: false }
    : own;
}
