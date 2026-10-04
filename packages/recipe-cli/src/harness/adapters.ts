// The host's platform adapters: a product preset registers its adapters here,
// and every generic command resolves platform behaviour through them. No
// command compares adapter ids.
import { execFileSync } from 'node:child_process';

import {
  type AdapterRegistry,
  createAdapterRegistry,
  type PlatformAdapter,
} from '@farmslot/adapter-sdk';

import { harnessHost } from './host.js';

let registry: AdapterRegistry = createAdapterRegistry();

/** Set the registry the generic commands use. Call once, before any command runs. */
export function configureHarnessAdapters(next: AdapterRegistry): void {
  registry = next;
}

export function harnessAdapters(): AdapterRegistry {
  return registry;
}

export function harnessAdapter(id: string): PlatformAdapter {
  return registry.get(id);
}

function registered(): PlatformAdapter[] {
  return registry.list().map((id) => registry.get(id));
}

/**
 * The adapter whose checkout `target` is, or undefined. Any adapter's remote
 * match beats any adapter's file match; within a pass, registration order decides.
 */
export function detectAdapter(target: string): string | undefined {
  // An empty registry would detect nothing for every checkout; that is a host
  // wiring error, not an unknown checkout.
  assertAdaptersRegistered();
  let remote = '';
  try {
    remote = execFileSync('git', ['-C', target, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not a Git checkout, or no origin: only the file checks apply.
    remote = '';
  }
  const adapters = registered();
  if (remote) {
    const byRemote = adapters.find((adapter) => adapter.detect?.remote?.(remote));
    if (byRemote) return byRemote.id;
  }
  return adapters.find((adapter) => adapter.detect?.files?.(target))?.id;
}

/** The adapter a `--platform` value or positional target names: its own id, or one of its `targets`. */
export function adapterForPlatform(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return registered().find((adapter) => adapter.targets?.includes(value))?.id ?? value;
}

/** Whether `value` is one of an adapter's positional platform targets. */
export function isPlatformTarget(value: string | undefined): value is string {
  return value !== undefined && registered().some((adapter) => adapter.targets?.includes(value));
}

/** Both escapes from a failed detection: where to run, and how to force it. */
export function adapterDetectNext(): string {
  return `cd into a ${harnessHost().product} checkout or pass --target <path>, or force it with --adapter <${registry.list().join('|')}>`;
}

export function undetectedAdapterMessage(target: string): string {
  return `could not detect the ${harnessHost().product} repo type for ${target}`;
}

function assertAdaptersRegistered(): void {
  if (registry.list().length === 0) {
    throw new Error(
      'internal: no adapters are registered yet; the host registers its adapters before resolving one',
    );
  }
}

/** Throws unless `adapter` is a registered id. An empty registry is an internal error. */
export function assertAdapter(adapter: unknown): asserts adapter is string {
  assertAdaptersRegistered();
  const ids = registry.list();
  if (typeof adapter !== 'string' || !registry.has(adapter)) {
    const choices =
      ids.length > 1 ? `${ids.slice(0, -1).join(', ')}, or ${ids.at(-1)}` : ids.join('');
    throw new Error(`Adapter must be ${choices}.`);
  }
}

/** Boolean flags every registered adapter adds, for `launch` or for the other commands. */
export function adapterFlags(kind: 'launch' | 'commands'): string[] {
  return registered().flatMap((adapter) => [...(adapter.flags?.[kind] ?? [])]);
}
