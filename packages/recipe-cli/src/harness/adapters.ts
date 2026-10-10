// The host's platform adapters: a product preset registers its adapters here,
// and every generic command resolves platform behaviour through them. No
// command compares adapter ids.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import {
  type AdapterDetect,
  adapterDetectFromSpec,
  type AdapterDetectSpec,
  type AdapterRegistry,
  createAdapterRegistry,
  type PlatformAdapter,
} from '@farmslot/adapter-sdk';

import { AdapterAmbiguousError, type AdapterCandidate, type DetectMatch } from './context-state.js';
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
 * The adapter whose checkout `target` is, or undefined: the unique match among
 * the registered adapters and the `declared` plugins (`detectAdapterMatch`).
 * More than one match throws AdapterAmbiguousError.
 */
export function detectAdapter(
  target: string,
  declared: readonly DeclaredDetect[] = [],
): string | undefined {
  return detectAdapterMatch(target, declared)?.adapter;
}

/** A plugin a library declares, with the `detect` it declares. */
export interface DeclaredDetect {
  id: string;
  library: string;
  extends?: string;
  detect?: AdapterDetectSpec;
}

/**
 * The registered adapters by their `detect` and the declared plugins by their
 * declaration's, ranked by `pickDetected`. A plugin is matched by its
 * declaration whether or not it is loaded; the caller passes plugin
 * declarations only (the resolver drops one that claims a built-in id).
 */
export function detectAdapterMatch(
  target: string,
  declared: readonly DeclaredDetect[] = [],
): AdapterCandidate | undefined {
  // An empty registry would detect nothing for every checkout; that is a host
  // wiring error, not an unknown checkout.
  assertAdaptersRegistered();
  const plugins = new Map(declared.map((declaration) => [declaration.id, declaration]));
  const entries: DetectEntry[] = registered()
    .filter((adapter) => !plugins.has(adapter.id))
    .map((adapter) => ({
      id: adapter.id,
      ...(adapter.extends ? { extends: adapter.extends } : {}),
      ...(adapter.detect ? { detect: adapter.detect } : {}),
    }));
  for (const declaration of plugins.values()) {
    entries.push({
      id: declaration.id,
      library: declaration.library,
      ...(declaration.extends ? { extends: declaration.extends } : {}),
      ...(declaration.detect ? { detect: adapterDetectFromSpec(declaration.detect) } : {}),
    });
  }
  return pickDetected(entries, target);
}

/** An adapter detection can choose: its id, what it extends, and its predicates. */
export interface DetectEntry {
  id: string;
  extends?: string;
  library?: string;
  detect?: AdapterDetect;
}

/**
 * The one entry whose predicates match `target`, or undefined. Any remote match
 * beats any file match; within that pass an adapter beats one it extends.
 * More than one left throws AdapterAmbiguousError listing them.
 */
export function pickDetected(
  entries: readonly DetectEntry[],
  target: string,
): AdapterCandidate | undefined {
  const remote = checkoutRemote(target);
  const matches = entries.flatMap((entry) => {
    const matched: DetectMatch[] = [];
    if (remote && entry.detect?.remote?.(remote)) matched.push('remote');
    if (entry.detect?.files?.(target)) matched.push('files');
    return matched.length > 0 ? [{ entry, matched }] : [];
  });
  const byRemote = matches.filter((match) => match.matched.includes('remote'));
  const pass = byRemote.length > 0 ? byRemote : matches;
  const parents = new Map(entries.map((entry) => [entry.id, entry.extends]));
  const ancestors = (id: string): Set<string> => {
    const seen = new Set<string>();
    for (let parent = parents.get(id); parent && !seen.has(parent); parent = parents.get(parent))
      seen.add(parent);
    return seen;
  };
  const left = pass.filter(
    (match) => !pass.some((other) => ancestors(other.entry.id).has(match.entry.id)),
  );
  const candidates = left.map(({ entry, matched }) => ({
    adapter: entry.id,
    matched,
    ...(entry.library ? { library: entry.library } : {}),
  }));
  if (candidates.length > 1) throw new AdapterAmbiguousError(path.resolve(target), candidates);
  return candidates[0];
}

// The checkout's origin URL, or '' when it is not a Git checkout or has none.
export function checkoutRemote(target: string): string {
  try {
    return execFileSync('git', ['-C', target, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not a Git checkout, or no origin: only the file checks apply.
    return '';
  }
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

export function assertAdaptersRegistered(): void {
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

/** Extra dev-server port environment names every registered adapter reads. */
export function adapterPortEnv(): string[] {
  return [...new Set(registered().flatMap((adapter) => [...(adapter.devServer.portEnv ?? [])]))];
}

/** Boolean flags every registered adapter adds, for `launch` or for the other commands. */
export function adapterFlags(kind: 'launch' | 'commands'): string[] {
  return registered().flatMap((adapter) => [...(adapter.flags?.[kind] ?? [])]);
}
