import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Who is running the generic harness commands. A product harness (`mm-harness`)
 * configures this once at startup, so every message and environment variable
 * keeps that product's spelling; `farmslot-recipe` uses the defaults. Runtime
 * paths are not per host: every host shares the checkout layout in paths.ts.
 */
export interface HarnessHost {
  /** The bin name used in messages and `Next:` lines. */
  name: string;
  /** Prefix of the host's own environment variables: `<envPrefix>_OPERATION_ID`. */
  envPrefix: string;
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
  envPrefix: 'FARMSLOT_RECIPE',
  packageName: '@farmslot/recipe-cli',
  packageRoot: fileURLToPath(new URL('../..', import.meta.url)),
  bin: 'bin/farmslot-recipe.mjs',
  // farmslot-recipe journals nothing yet; a host lists the commands it journals.
  journaledCommands: [],
};

let current: HarnessHost = defaultHost;

/** Set the host identity. Call once, before any command runs. */
export function configureHarnessHost(host: Partial<HarnessHost>): HarnessHost {
  const next = { ...defaultHost, ...host };
  if (!/^[A-Z][A-Z0-9_]*$/u.test(next.envPrefix)) {
    throw new Error(`envPrefix must be an upper-case identifier: ${next.envPrefix}`);
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
