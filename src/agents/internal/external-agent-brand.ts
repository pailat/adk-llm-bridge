/**
 * Brand carried by every `ExternalAgent` instance. `Symbol.for` makes it the
 * same key in every copy of this module (a duplicated install or a bundle
 * split), where `instanceof` would fail and silently skip the ancestor.
 *
 * @remarks
 * Lives in its own module so code that must not import the `ExternalAgent`
 * class (it pulls every driver) can still recognize one.
 *
 * @internal
 */
export const EXTERNAL_AGENT_BRAND: unique symbol = Symbol.for(
  "adk-llm-bridge.agents.external-agent.v1",
);

/**
 * Whether `agent` is an `ExternalAgent`, read from its own brand property (a
 * key inherited through the prototype does not count).
 *
 * @internal
 */
export function hasExternalAgentBrand(agent: object): boolean {
  return (
    Object.getOwnPropertyDescriptor(agent, EXTERNAL_AGENT_BRAND) !== undefined
  );
}
