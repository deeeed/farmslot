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
import os from 'node:os';
import path from 'node:path';

import { findSlotByRepo, resolveSlotPoolDir } from '@farmslot/protocol/node/slot-by-repo';

import { type AdapterLibraryOptions, adapterPlugin, declaredAdapters } from './adapter-plugins.js';
import {
  adapterForPlatform,
  type DeclaredDetect,
  detectAdapterMatch,
  harnessAdapters,
  isPlatformTarget,
} from './adapters.js';
import { optionValues } from './command-contract.js';
import type { ContextPortName, HarnessContext } from './context-state.js';
import { validateRelativeRecipePath } from './host.js';
import { recipeRuntimeDir } from './paths.js';

export interface ResolveHarnessContextOptions {
  /** The command's tokens, after the command name. */
  tokens: readonly string[];
  /**
   * The command's positionals as its grammar reads them (`contractPositionals`);
   * the first may be a platform target (`launch --json ios`). Default: the
   * first token, when it is not an option.
   */
  positionals?: readonly string[];
  /** false: resolve the target and slot only, never an adapter. Default true. */
  adapter?: boolean;
  /** Default: process.cwd(). */
  cwd?: string;
  /** The libraries whose declarations are candidates: the loader's trust set. */
  load?: AdapterLibraryOptions;
  /** The adapter a runtime context's or slot's `platform` names, when it is not an adapter id. */
  slotAdapter?(platform: string): string | undefined;
  /**
   * The pool directory slot-config reads. Default (`resolveSlotPoolDir`):
   * FARMSLOT_POOL_DIR, else $FARMSLOT_ROOT/pool, else ~/farmslot-node/pool when
   * it exists. Without one, a checkout whose runtime context names no slot
   * reports `slot: { value: null, source: 'none', detail: 'no-pool-dir' }`.
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
  const binding = readBinding(root, optionValues(options.tokens, '--runtime-dir').at(-1));
  const runtime = binding.runtime;
  const pool = options.slotPoolDir
    ? { dir: options.slotPoolDir, source: 'option' as const }
    : resolveSlotPoolDir();
  const pooled = pool
    ? await poolSlot(
        root,
        pool.dir,
        pool.source === 'farmslot-node' ? 'slot-config (~/farmslot-node/pool)' : 'slot-config',
      )
    : 'no-pool-dir';
  const pooledSlot = typeof pooled === 'object' ? pooled : undefined;
  const slot: HarnessContext['slot'] =
    pooledSlot?.slot ??
    runtimeSlot(runtime) ??
    (pool === undefined || pooled === 'no-pool-dir'
      ? { value: null, source: 'none', detail: 'no-pool-dir' }
      : { value: null, source: 'none', detail: 'not-in-pool', poolDir: pool.dir });

  const adapter: ContextAdapter | undefined =
    options.adapter === false
      ? undefined
      : (flagAdapter(options.tokens, options.positionals) ??
        sourced(platformAdapter(runtime?.platform), 'binding', 'runtime-context') ??
        sourced(platformAdapter(pooledSlot?.platform), 'slot', 'slot-config') ??
        detectedAdapter(
          root,
          // A declaration that claims a built-in id is no candidate; selecting
          // it reports the conflict.
          declared.filter((entry) => !registry.has(entry.id) || adapterPlugin(entry.id)),
        ) ??
        sourced(options.defaultAdapter, 'default', 'default'));

  return {
    ...(adapter ? { adapter } : {}),
    target,
    ...(slot ? { slot } : {}),
    ...(binding.ignored ? { ignoredBinding: binding.ignored } : {}),
  };
}

// Each generic port option, and the slot ports that fill it, in order.
const PORT_OPTIONS: readonly { name: ContextPortName; option: string; slot: readonly string[] }[] =
  [
    { name: 'cdp', option: '--cdp-port', slot: ['cdp_port', 'cdpPort'] },
    {
      name: 'watcher',
      option: '--watcher-port',
      slot: ['port', 'watcherPort', 'devServerPort', 'metroPort'],
    },
  ];

/**
 * The generic port options `options` (a command's grammar) takes, from the
 * flag when given, else from the context's slot; and the flags to add for the
 * slot-filled ones. A flag always wins; no slot fills nothing.
 */
export function contextPorts(
  context: HarnessContext,
  tokens: readonly string[],
  options: Readonly<Record<string, unknown>>,
): { ports?: NonNullable<HarnessContext['ports']>; fill: string[] } {
  const ports: NonNullable<HarnessContext['ports']> = {};
  const fill: string[] = [];
  const slotPorts = context.slot?.value ? context.slot.ports : {};
  for (const { name, option, slot } of PORT_OPTIONS) {
    if (!(option in options)) continue;
    const given = optionValues(tokens, option);
    if (given.length > 0) {
      // A flag always wins, so the slot never fills it; the command checks it.
      const flagged = Number(given.at(-1));
      if (Number.isInteger(flagged) && flagged > 0)
        ports[name] = { value: flagged, source: 'flag' };
      continue;
    }
    const fromSlot = slot.map((key) => slotPorts[key]).find((port) => port !== undefined);
    if (fromSlot === undefined) continue;
    ports[name] = { value: fromSlot, source: 'slot' };
    fill.push(option, String(fromSlot));
  }
  return { ...(Object.keys(ports).length > 0 ? { ports } : {}), fill };
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
  if (context.slot?.value === null)
    parts.push(
      context.slot.detail === 'not-in-pool'
        ? `slot unknown (not in ${homeRelative(context.slot.poolDir)})`
        : 'slot unknown (no pool dir)',
    );
  else if (context.slot) parts.push(`slot ${context.slot.value} (${context.slot.detail})`);
  const ports = Object.entries(context.ports ?? {}).map(
    ([name, port]) => `${name} ${port.value} (${port.source})`,
  );
  if (ports.length > 0) parts.push(`ports ${ports.join(', ')}`);
  if (context.ignoredBinding)
    parts.push(
      `binding ignored (belongs to ${context.ignoredBinding.repoRoot ?? 'an unnamed checkout'})`,
    );
  return `context: ${parts.join(', ')}`;
}

function sourced(
  value: string | undefined,
  source: ContextAdapter['source'],
  detail: string,
): ContextAdapter | undefined {
  return value === undefined ? undefined : { value, source, detail };
}

// The last --adapter, else the adapter of the last --platform, else a first
// positional that is a platform target (`launch ios`, `launch --json ios`).
function flagAdapter(
  tokens: readonly string[],
  positionals: readonly string[] | undefined,
): ContextAdapter | undefined {
  const adapter = optionValues(tokens, '--adapter').at(-1);
  if (adapter !== undefined) return { value: adapter, source: 'flag', detail: '--adapter' };
  const platform = optionValues(tokens, '--platform').at(-1);
  if (platform !== undefined)
    return {
      value: adapterForPlatform(platform) ?? platform,
      source: 'flag',
      detail: '--platform',
    };
  const first = positionals ? positionals[0] : tokens[0];
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

// The runtime context a run's prepare wrote for this checkout, read where the
// commands read it: RECIPE_RUNTIME_CONTEXT, else <root>/<runtime dir>, where an
// explicit --runtime-dir counts before RECIPE_RUNTIME_DIR. A context whose
// repoRoot is another checkout (an inherited RECIPE_RUNTIME_CONTEXT) binds
// nothing and is reported; one without repoRoot binds only from inside `root`.
function readBinding(
  root: string,
  runtimeDir: string | undefined,
): { runtime?: RuntimeContext; ignored?: NonNullable<HarnessContext['ignoredBinding']> } {
  let file: string;
  let value: unknown;
  try {
    file =
      process.env.RECIPE_RUNTIME_CONTEXT ??
      path.join(
        root,
        runtimeDir === undefined
          ? recipeRuntimeDir()
          : validateRelativeRecipePath('--runtime-dir', runtimeDir),
        'agentic-runtime.json',
      );
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // No context, one mid-write, an unreadable one, or a runtime dir the
    // command will refuse itself: the checkout is unbound.
    return {};
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const runtime = value as RuntimeContext;
  const repoRoot = typeof runtime.repoRoot === 'string' ? runtime.repoRoot : undefined;
  return runtimeContextOwned(root, file, runtime)
    ? { runtime }
    : { ignored: { path: file, repoRoot: repoRoot ?? null } };
}

/**
 * Whether the runtime context read from `file` belongs to the checkout `root`:
 * its `repoRoot` is `root`'s Git top level (real paths), or, without
 * `repoRoot`, the file sits inside `root`. Anything else is another
 * checkout's (an inherited RECIPE_RUNTIME_CONTEXT) and describes nothing here.
 */
export function runtimeContextOwned(
  root: string,
  file: string,
  context: Readonly<Record<string, unknown>>,
): boolean {
  // The checkout itself, not one nested in it: a clone under <checkout>/temp
  // has its own top level and inherits nothing.
  return typeof context.repoRoot === 'string'
    ? samePath(context.repoRoot, gitTopLevel(root) ?? root)
    : within(root, file);
}

function samePath(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    // A path that does not exist is nobody's checkout.
    return false;
  }
}

// `dir` with the home directory spelled `~`, for the human line.
function homeRelative(dir: string): string {
  const home = os.homedir();
  return dir === home || dir.startsWith(`${home}${path.sep}`) ? `~${dir.slice(home.length)}` : dir;
}

// Whether `inner` is `outer` or inside it, comparing real paths.
function within(outer: string, inner: string): boolean {
  try {
    const relative = path.relative(fs.realpathSync(outer), fs.realpathSync(inner));
    return !(
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    );
  } catch {
    // A path that does not exist owns nothing.
    return false;
  }
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
  detail: ContextSlot['detail'],
): Promise<{ slot: ContextSlot; platform?: string } | 'no-pool-dir' | undefined> {
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch (error) {
    // A missing checkout has no slot; any other IO failure is real.
    if (missing(error)) return undefined;
    throw error;
  }
  let match;
  try {
    match = await findSlotByRepo(poolDir, real);
  } catch (error) {
    // A pool directory that does not exist is none; one that does not read
    // (EACCES and the like) is a real failure.
    if (missing(error)) return 'no-pool-dir';
    throw error;
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
      detail,
      ...(match.slot.session ? { session: match.slot.session } : {}),
      poolFile: match.poolFile,
      ports,
    },
    ...(match.slot.platform ? { platform: match.slot.platform } : {}),
  };
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
