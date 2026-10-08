// One context per invocation: the adapter, target and slot a command acts on,
// and where each came from. The adapter resolves in this order: an explicit
// flag, the checkout's binding (the runtime context a run's prepare wrote), the
// slot whose checkout this is (slot-config), a unique detect match among the
// built-ins and the plugins the operator's libraries declare, then the host's
// default. Plugins are matched by their declaration's `detect`, never imported
// to detect; the host loads only the winner. Approvals (--approve-plan, mainnet
// and funding flags) are never part of the context: they stay explicit.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { findSlotByRepo, slotPoolDir } from '@farmslot/protocol/node/slot-by-repo';

import { type AdapterLibraryOptions, adapterPlugin, declaredAdapters } from './adapter-plugins.js';
import {
  adapterForPlatform,
  type DeclaredDetect,
  detectAdapterMatch,
  harnessAdapters,
  isPlatformTarget,
} from './adapters.js';
import { optionValues } from './command-contract.js';
import type { HarnessContext } from './context-state.js';
import { resolveRuntimeContextPath } from './overlay.js';

export interface ResolveHarnessContextOptions {
  /** The command's tokens, after the command name. */
  tokens: readonly string[];
  /** Default: process.cwd(). */
  cwd?: string;
  /** The libraries whose declarations are candidates: the loader's trust set. */
  load?: AdapterLibraryOptions;
  /** The adapter a runtime context's or slot's `platform` names, when it is not an adapter id. */
  slotAdapter?(platform: string): string | undefined;
  /**
   * The pool directory slot-config reads. Default: FARMSLOT_POOL_DIR, else
   * $FARMSLOT_ROOT/pool. Without one, a checkout whose runtime context names no
   * slot reports `slot: { value: null, source: 'none', detail: 'no-pool-dir' }`.
   */
  slotPoolDir?: string;
  /** The adapter when nothing else decides. */
  defaultAdapter?: string;
}

type ContextAdapter = NonNullable<HarnessContext['adapter']>;
type ContextSlot = Extract<NonNullable<HarnessContext['slot']>, { value: string }>;

/**
 * Resolve the invocation's context. Throws AdapterAmbiguousError when detection
 * is reached and more than one adapter matches the target.
 */
export async function resolveHarnessContext(
  options: ResolveHarnessContextOptions,
): Promise<HarnessContext> {
  const cwd = options.cwd ?? process.cwd();
  const targetFlag = optionValues(options.tokens, '--target').at(-1);
  const target: HarnessContext['target'] = targetFlag
    ? { value: path.resolve(cwd, targetFlag), source: 'flag', detail: '--target' }
    : { value: path.resolve(cwd), source: 'default', detail: 'cwd' };

  const registry = harnessAdapters();
  const declared = await declaredAdapters(options.load);
  const known = (id: string | undefined): string | undefined =>
    id !== undefined && (registry.has(id) || declared.some((entry) => entry.id === id))
      ? id
      : undefined;
  const platformAdapter = (platform: unknown): string | undefined =>
    typeof platform === 'string' && platform
      ? known(options.slotAdapter?.(platform) ?? adapterForPlatform(platform))
      : undefined;

  // Without --target, a subdirectory answers for its checkout: the binding, the
  // slot and detection read the Git top level.
  const root = targetFlag ? target.value : (gitTopLevel(target.value) ?? target.value);
  const runtime = readRuntimeContext(root);
  const poolDir = options.slotPoolDir ?? slotPoolDir();
  const pooled = poolDir ? await poolSlot(root, poolDir) : 'no-pool-dir';
  const pooledSlot = typeof pooled === 'object' ? pooled : undefined;
  const slot: HarnessContext['slot'] =
    pooledSlot?.slot ??
    runtimeSlot(runtime) ??
    (pooled === 'no-pool-dir' ? { value: null, source: 'none', detail: 'no-pool-dir' } : undefined);

  const adapter: ContextAdapter | undefined =
    flagAdapter(options.tokens) ??
    sourced(platformAdapter(runtime?.platform), 'binding', 'runtime-context') ??
    sourced(platformAdapter(pooledSlot?.platform), 'slot', 'slot-config') ??
    detectedAdapter(
      root,
      // A declaration that claims a built-in id is no candidate; selecting it
      // reports the conflict.
      declared.filter((entry) => !registry.has(entry.id) || adapterPlugin(entry.id)),
    ) ??
    sourced(options.defaultAdapter, 'default', 'default');

  return { ...(adapter ? { adapter } : {}), target, ...(slot ? { slot } : {}) };
}

/** The one human line: `context: adapter <id> (<source>), target <path> (<source>), slot <id> (<source>)`. */
export function formatHarnessContext(context: HarnessContext): string {
  const adapter = context.adapter
    ? `adapter ${context.adapter.value} (${
        context.adapter.source === 'detect'
          ? `detected: ${context.adapter.detail}`
          : context.adapter.detail
      })`
    : 'adapter none';
  const parts = [adapter, `target ${context.target.value} (${context.target.detail})`];
  if (context.slot?.value === null) parts.push('slot unknown (no pool dir)');
  else if (context.slot) parts.push(`slot ${context.slot.value} (${context.slot.detail})`);
  return `context: ${parts.join(', ')}`;
}

function sourced(
  value: string | undefined,
  source: ContextAdapter['source'],
  detail: string,
): ContextAdapter | undefined {
  return value === undefined ? undefined : { value, source, detail };
}

// The last --adapter, else the adapter of the last --platform, else a leading
// positional platform target (`launch ios`).
function flagAdapter(tokens: readonly string[]): ContextAdapter | undefined {
  const adapter = optionValues(tokens, '--adapter').at(-1);
  if (adapter !== undefined) return { value: adapter, source: 'flag', detail: '--adapter' };
  const platform = optionValues(tokens, '--platform').at(-1);
  if (platform !== undefined)
    return {
      value: adapterForPlatform(platform) ?? platform,
      source: 'flag',
      detail: '--platform',
    };
  const first = tokens[0];
  if (first !== undefined && !first.startsWith('-') && isPlatformTarget(first))
    return { value: adapterForPlatform(first) ?? first, source: 'flag', detail: 'positional' };
  return undefined;
}

// Built-ins by their `detect`, plugins by their declaration's: a plugin is
// never imported to detect it.
function detectedAdapter(
  target: string,
  declared: readonly DeclaredDetect[],
): ContextAdapter | undefined {
  const winner = detectAdapterMatch(target, declared);
  return winner
    ? {
        value: winner.adapter,
        source: 'detect',
        detail: winner.matched.join('+'),
        matched: winner.matched,
        ...(winner.library ? { library: winner.library } : {}),
      }
    : undefined;
}

// The Git work tree `dir` is in, or undefined outside one.
function gitTopLevel(dir: string): string | undefined {
  try {
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return top ? fs.realpathSync(top) : undefined;
  } catch {
    // Not inside a Git work tree, or no git: the directory answers for itself.
    return undefined;
  }
}

type RuntimeContext = Record<string, unknown>;

// The runtime context a run's prepare wrote into the checkout, or undefined.
function readRuntimeContext(target: string): RuntimeContext | undefined {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(resolveRuntimeContextPath(target), 'utf8'));
  } catch {
    // No context, one mid-write, or an unreadable one: the checkout is unbound.
    return undefined;
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RuntimeContext)
    : undefined;
}

const RUNTIME_PORTS = ['watcherPort', 'devServerPort', 'metroPort', 'cdpPort'] as const;

function runtimeSlot(runtime: RuntimeContext | undefined): ContextSlot | undefined {
  if (typeof runtime?.slotId !== 'string' || !runtime.slotId) return undefined;
  const ports: Record<string, number> = {};
  for (const field of RUNTIME_PORTS) {
    const port = Number(runtime[field]);
    if (runtime[field] !== undefined && Number.isInteger(port) && port > 0) ports[field] = port;
  }
  return { value: runtime.slotId, source: 'binding', detail: 'runtime-context', ports };
}

// The slot slot-config maps this checkout to, with its own platform (never the
// pool's) for the adapter step; 'no-pool-dir' when the directory does not read.
async function poolSlot(
  target: string,
  poolDir: string,
): Promise<{ slot: ContextSlot; platform?: string } | 'no-pool-dir' | undefined> {
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    // A missing checkout has no slot.
    return undefined;
  }
  let match;
  try {
    match = await findSlotByRepo(poolDir, real);
  } catch {
    // An unreadable pool directory is as good as none.
    return 'no-pool-dir';
  }
  if (!match) return undefined;
  const ports: Record<string, number> = {};
  for (const resource of Object.values(match.slot.resources ?? {})) {
    for (const [field, value] of Object.entries(resource)) {
      const port = Number(value);
      if (/port$/u.test(field) && Number.isInteger(port) && port > 0) ports[field] = port;
    }
  }
  return {
    slot: {
      value: match.slot.id,
      source: 'slot',
      detail: 'slot-config',
      ...(match.slot.session ? { session: match.slot.session } : {}),
      poolFile: match.poolFile,
      ports,
    },
    ...(match.slot.platform ? { platform: match.slot.platform } : {}),
  };
}
