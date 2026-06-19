/**
 * The Demo Registry: a Map keyed by Demo.name with thin accessors.
 *
 * Pure data structure with no demo imports — demos register themselves in the
 * composition root (`src/demos/index.ts`) to avoid import cycles.
 */
import type { Demo } from "./types";

export class DemoRegistry {
  private readonly demos = new Map<string, Demo>();

  register(demo: Demo): void {
    this.demos.set(demo.name, demo);
  }

  get(name: string): Demo | undefined {
    return this.demos.get(name);
  }

  list(): Demo[] {
    return [...this.demos.values()];
  }
}

export const registry = new DemoRegistry();
