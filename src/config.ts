import type { RegisterOptions } from "./types";

let config: RegisterOptions = {};

export function setConfig(options: RegisterOptions): void {
  config = { ...options };
}

export function getConfig(): Readonly<RegisterOptions> {
  return config;
}

export function resetConfig(): void {
  config = {};
}
