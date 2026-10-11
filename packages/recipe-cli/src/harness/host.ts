import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RECIPE_PROCESS_SIGNALS } from '@farmslot/recipe-runner/adapters/core';

/**
 * Who is running the generic harness commands. A product harness (`mm-harness`)
 * configures this once at startup, so every message and environment variable
 * keeps that product's spelling; `farmslot-recipe` uses the defaults. Runtime
 * paths are not per host: every host shares the checkout layout in paths.ts.
 */
export interface HarnessHost {
  /** The bin name used in messages and `Next:` lines. */
  name: string;
  /** What a checkout belongs to, in "could not detect the <product> repo type". */
  product: string;
  /** Prefix of the host's own environment variables: `<envPrefix>_OPERATION_ID`. */
  envPrefix: string;
  /**
   * Prefix of the variables recipe processes and library actions read:
   * `<recipeEnvPrefix>_ADAPTER_INPUT`. Libraries outside the host depend on
   * them, so they are spelled apart from the host's own `envPrefix`.
   */
  recipeEnvPrefix: string;
  /** The npm package that ships the bin. */
  packageName: string;
  /** The installed package root. */
  packageRoot: string;
  /** The host executable, relative to `packageRoot`. */
  bin: string;
  /** Commands the resumability journal records. */
  journaledCommands: readonly string[];
}

const defaultHost: HarnessHost = {
  name: 'farmslot-recipe',
  product: 'project',
  envPrefix: 'FARMSLOT_RECIPE',
  recipeEnvPrefix: 'RECIPE',
  packageName: '@farmslot/recipe-cli',
  packageRoot: fileURLToPath(new URL('../..', import.meta.url)),
  bin: 'bin/farmslot-recipe.mjs',
  // farmslot-recipe journals nothing yet; a host lists the commands it journals.
  journaledCommands: [],
};

let current: HarnessHost = defaultHost;
const executionSignal = new AsyncLocalStorage<AbortSignal | undefined>();

export function withRecipeExecutionSignal<T>(signal: AbortSignal | undefined, invoke: () => T): T {
  return executionSignal.run(signal, invoke);
}

export function recipeExecutionSignal(): AbortSignal | undefined {
  return executionSignal.getStore();
}

/** Cleanup keeps host signal ownership but cannot inherit an already aborted action signal. */
export function withRecipeCleanup<T>(invoke: () => T): T {
  return withRecipeExecutionSignal(new AbortController().signal, invoke);
}

/** Keep process signal ownership until the invocation has finished cleanup. */
export async function withRecipeSignals<T>(
  invoke: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const scoped = signal ?? controller.signal;
  const handlers = (signal ? [] : RECIPE_PROCESS_SIGNALS).map((name) => {
    const handler = (): void => controller.abort(name);
    process.on(name, handler);
    return { name, handler };
  });
  try {
    return await invoke(scoped);
  } finally {
    for (const { name, handler } of handlers) process.removeListener(name, handler);
  }
}

/** A host's identity; it journals nothing unless it lists commands. */
export type HarnessHostConfig = Omit<HarnessHost, 'journaledCommands'> & {
  journaledCommands?: readonly string[];
};

/**
 * Set the host identity. Call once, before any command runs. Every identity
 * field is required, so a host can't silently inherit farmslot-recipe's names.
 */
export function configureHarnessHost(host: HarnessHostConfig): HarnessHost {
  const next: HarnessHost = { ...host, journaledCommands: host.journaledCommands ?? [] };
  for (const field of ['envPrefix', 'recipeEnvPrefix'] as const) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(next[field])) {
      throw new Error(`${field} must be an upper-case identifier: ${next[field]}`);
    }
  }
  current = next;
  return current;
}

export function harnessHost(): HarnessHost {
  return current;
}

/** The host-owned environment variable `<envPrefix>_<suffix>`. */
export function hostEnvName(suffix: string): string {
  return `${current.envPrefix}_${suffix}`;
}

/**
 * How the user invoked the host (`<envPrefix>_INVOKED_AS`, else its
 * executable, else its name), for the commands examples print.
 */
export function invokedHostCommand(): string {
  return (
    process.env[hostEnvName('INVOKED_AS')] ?? process.env[hostEnvName('EXECUTABLE')] ?? current.name
  );
}

/** The recipe-process environment variable `<recipeEnvPrefix>_<suffix>`. */
export function recipeEnvName(suffix: string): string {
  return `${current.recipeEnvPrefix}_${suffix}`;
}

/** Throws unless `value` is a non-empty, safe, checkout-relative path. */
export function validateRelativeRecipePath(name: string, value: string): string {
  if (!value || path.isAbsolute(value)) {
    throw new Error(`${name} must be a non-empty relative path: ${value}`);
  }
  if (!/^[A-Za-z0-9._/-]+$/u.test(value)) {
    throw new Error(`${name} contains unsupported characters: ${value}`);
  }
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..') {
      throw new Error(`${name} contains unsafe path component: ${value}`);
    }
  }
  return value;
}
