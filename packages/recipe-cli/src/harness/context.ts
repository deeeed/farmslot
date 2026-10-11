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
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PlatformAdapter } from '@farmslot/adapter-sdk';
import { portableRepoIdentity } from '@farmslot/agent-runtime';
import {
  DEFAULT_TASK_DIR,
  type ExecutionTemplateSourceRoot,
  type ProjectConfig,
  validateProjectRecipeConfig,
} from '@farmslot/protocol';
import {
  findSlotByRepo,
  resolveSlotPoolDir,
  SlotByRepoError,
} from '@farmslot/protocol/node/slot-by-repo';
import { resolveRecipeLibrarySources } from '@farmslot/recipe-runner';

import {
  type AdapterLibraryOptions,
  adapterPlugin,
  declaredAdapters,
  libraryName,
} from './adapter-plugins.js';
import {
  adapterForPlatform,
  adapterPortEnv,
  checkoutRemote,
  type DeclaredDetect,
  detectAdapterMatch,
  harnessAdapters,
  isPlatformTarget,
} from './adapters.js';
import { optionValues } from './command-contract.js';
import {
  type ContextPortName,
  type ContextSource,
  type HarnessContext,
  ProjectBindingError,
  type ResolvedProjectBinding,
  type ResolvedProjectLibrary,
} from './context-state.js';
import { inputSourceSnapshot, providerSourceSnapshot } from './execution-provenance.js';
import {
  configureHarnessHost,
  type HarnessHostConfig,
  validateRelativeRecipePath,
} from './host.js';
import { gitLibraryProvenance } from './library-provenance.js';
import type { CliOptions } from './parse-args.js';
import {
  DEFAULT_RECIPE_RUNTIME_DIR,
  isPathWithin as within,
  recipeOutputRoots,
  recipeRuntimeDir,
} from './paths.js';
import type { RecipeEngine } from './run-engine.js';

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
  /** false for help/completion, which never execute on the selected slot. */
  strictSlot?: boolean;
  /** Pool selector by default; legacy provision commands use --slot as a new identity. */
  slotSelection?: 'pool' | 'identity';
  /** The adapter when nothing else decides. */
  defaultAdapter?: string;
  /** App runtime target; pool lookup remains rooted at the checkout. */
  runtimeTarget?: string;
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
  const runtimeDir = optionValues(options.tokens, '--runtime-dir').at(-1);
  const binding = readBinding(options.runtimeTarget ?? root, runtimeDir);
  const runtime = binding.runtime;
  const pool = options.slotPoolDir
    ? { dir: options.slotPoolDir, source: 'option' as const }
    : resolveSlotPoolDir();
  const pooled = pool
    ? await poolSlot(
        root,
        pool.dir,
        pool.source === 'farmslot-node' ? 'slot-config (~/farmslot-node/pool)' : 'slot-config',
        options.slotSelection === 'identity'
          ? undefined
          : optionValues(options.tokens, '--slot').at(-1),
        options.strictSlot ?? true,
        options.slotSelection,
      )
    : 'no-pool-dir';
  const pooledSlot = typeof pooled === 'object' ? pooled : undefined;
  // The pool's slot keeps the owned runtime context's ports beside its own
  // (camelCase runtime keys, snake_case pool keys), so they can win the fill.
  const owned = runtimeSlot(runtime);
  const slot: HarnessContext['slot'] =
    (pooledSlot
      ? owned &&
        owned.value !== pooledSlot.slot.value &&
        runtimeDir !== undefined &&
        path.normalize(runtimeDir) !== DEFAULT_RECIPE_RUNTIME_DIR
        ? // An explicit --runtime-dir scratch runtime names its own slot:
          // identity and ports describe that runtime, the pool's ports filling
          // only what it lacks. The default context keeps the pool's identity.
          {
            ...owned,
            poolFile: pooledSlot.slot.poolFile,
            poolSlot: pooledSlot.slot.value,
            ports: { ...pooledSlot.slot.ports, ...owned.ports },
          }
        : {
            ...pooledSlot.slot,
            ports: { ...pooledSlot.slot.ports, ...runtimePorts(runtime) },
          }
      : undefined) ??
    owned ??
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
    ...(binding.path ? { runtimeConfigPath: binding.path } : {}),
  };
}

// Each generic port option, and the slot ports that fill it, in order.
// Per port: the option and its aliases (a typed one is the adapter's to read),
// the environment names the adapters read (`read`: any one set means the user
// chose; the fill never replaces it), and the names the fill sets, which are
// the ones recipe-cli itself sets for a typed flag. The slot's ports: the owned
// runtime context's first (a --runtime-dir scratch runtime names its own),
// then the pool's.
const PORT_OPTIONS: readonly {
  name: ContextPortName;
  option: string;
  aliases: readonly string[];
  read: readonly string[];
  set: readonly string[];
  slot: readonly string[];
}[] = [
  {
    name: 'cdp',
    option: '--cdp-port',
    aliases: [],
    read: ['RECIPE_CDP_PORT', 'CDP_PORT'],
    set: ['RECIPE_CDP_PORT', 'CDP_PORT'],
    slot: ['cdpPort', 'cdp_port'],
  },
  {
    name: 'watcher',
    option: '--watcher-port',
    // `doctor`/`stop --port` and the retired `--metro-port` name the same port.
    aliases: ['--port', '--metro-port'],
    read: ['TERMINAL_APP_PORT', 'RECIPE_WATCHER_PORT', 'WATCHER_PORT', 'METRO_PORT'],
    set: ['RECIPE_WATCHER_PORT', 'WATCHER_PORT', 'METRO_PORT'],
    slot: ['devServerPort', 'watcherPort', 'metroPort', 'port'],
  },
];

/**
 * The generic ports `options` (a command's grammar) takes, and the
 * environment that fills the ones the user left open. The command's argv is
 * never touched: a slot port reaches the adapter through the environment it
 * already reads, which every adapter ranks below a typed flag, an alias and a
 * passthrough port. A port is filled only when no spelling of it was typed and
 * none of its environment names holds a port; a registered adapter's own port
 * names (`devServer.portEnv`) are read and set with the watcher port's.
 */
export function contextPorts(
  context: HarnessContext,
  tokens: readonly string[],
  options: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv = process.env,
): { ports?: NonNullable<HarnessContext['ports']>; env: Record<string, string> } {
  const ports: NonNullable<HarnessContext['ports']> = {};
  const fill: Record<string, string> = {};
  const slotPorts = context.slot?.value ? context.slot.ports : {};
  for (const { name, option, aliases, read, set, slot } of PORT_OPTIONS) {
    if (!(option in options)) continue;
    const extra = name === 'watcher' ? adapterPortEnv() : [];
    const typed = [
      ...[option, ...aliases]
        .filter((spelling) => spelling in options)
        .flatMap((spelling) => optionValues(tokens, spelling)),
      // A leaf's own port after `--` holds too: no fill competes with it.
      ...passthroughValues(tokens, [option, ...aliases]),
    ];
    if (typed.length > 0) {
      // The handler picks among the spellings; report the value only when they agree.
      const values = new Set(typed.map(Number));
      const [value] = [...values];
      ports[name] =
        values.size === 1 && Number.isInteger(value) && value! > 0
          ? { value: value!, source: 'flag' }
          : { source: 'flag' };
      continue;
    }
    let invalidEnv: { name: string; value: string } | undefined;
    const held = [...read, ...extra].find((key) => {
      const raw = env[key];
      if (raw === undefined || raw === '') return false;
      const port = Number(raw);
      if (Number.isInteger(port) && port > 0) return true;
      // Not a port: it holds nothing, and the report shows what was there.
      invalidEnv ??= { name: key, value: raw };
      return false;
    });
    if (held !== undefined) {
      ports[name] = { value: Number(env[held]), source: 'env', filled: false };
      continue;
    }
    const fromSlot = slot.map((key) => slotPorts[key]).find((port) => port !== undefined);
    if (fromSlot === undefined) continue;
    const names = [...new Set([...set, ...extra])];
    for (const key of names) fill[key] = String(fromSlot);
    ports[name] = {
      value: fromSlot,
      source: 'slot',
      filled: true,
      via: 'env',
      names,
      ...(invalidEnv ? { invalidEnv } : {}),
    };
  }
  return { ...(Object.keys(ports).length > 0 ? { ports } : {}), env: fill };
}

// The values `spellings` take after `--` (separate or `=value`), where the
// command's grammar does not apply and a leaf reads its own arguments.
function passthroughValues(tokens: readonly string[], spellings: readonly string[]): string[] {
  const divider = tokens.indexOf('--');
  if (divider === -1) return [];
  const values: string[] = [];
  const rest = tokens.slice(divider + 1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    for (const spelling of spellings) {
      if (token === spelling) values.push(rest[index + 1] ?? '');
      else if (token.startsWith(`${spelling}=`)) values.push(token.slice(spelling.length + 1));
    }
  }
  return values;
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
    ([name, port]) =>
      `${name}${port.value === undefined ? '' : ` ${port.value}`} (${
        port.source === 'env' ? 'env, not filled' : port.source
      })`,
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
): {
  runtime?: RuntimeContext;
  path?: string;
  ignored?: NonNullable<HarnessContext['ignoredBinding']>;
} {
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
    ? { runtime, path: file }
    : { ignored: { path: file, repoRoot: repoRoot ?? null } };
}

/**
 * Whether the runtime context read from `file` belongs to the checkout `root`:
 * its `repoRoot` is the selected target or its Git top level (real paths), or, without
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
    ? samePath(context.repoRoot, root) || samePath(context.repoRoot, gitTopLevel(root) ?? root)
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

const RUNTIME_PORTS = ['watcherPort', 'devServerPort', 'metroPort', 'cdpPort'] as const;

function runtimeSlot(runtime: RuntimeContext | undefined): ContextSlot | undefined {
  if (typeof runtime?.slotId !== 'string' || !runtime.slotId) return undefined;
  return {
    value: runtime.slotId,
    source: 'binding',
    detail: 'runtime-context',
    ports: runtimePorts(runtime),
  };
}

function runtimePorts(runtime: RuntimeContext | undefined): Record<string, number> {
  const ports: Record<string, number> = {};
  for (const field of RUNTIME_PORTS) {
    const port = Number(runtime?.[field]);
    if (runtime?.[field] !== undefined && Number.isInteger(port) && port > 0) ports[field] = port;
  }
  return ports;
}

// The slot slot-config maps this checkout to, with its own platform (never the
// pool's) for the adapter step; 'no-pool-dir' when the directory does not read.
async function poolSlot(
  target: string,
  poolDir: string,
  detail: ContextSlot['detail'],
  slotId?: string,
  strict = true,
  selection?: ResolveHarnessContextOptions['slotSelection'],
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
    match = await findSlotByRepo(poolDir, real, { strict, ...(slotId ? { slotId } : {}) });
  } catch (error) {
    if (error instanceof SlotByRepoError && selection === 'identity')
      throw Object.assign(error, {
        userAction: 'map this checkout to a single pool slot; use --target for a separate checkout',
      });
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

/** Registered pack metadata. `root` is the directory containing project.json. */
export interface ConfiguredRecipeProject {
  config: ProjectConfig;
  root: string;
}

export interface ResolveProjectContextOptions extends ResolveHarnessContextOptions {
  projects?: readonly ConfiguredRecipeProject[];
  /** Explicit operator-owned project registry, with <name>/project.json entries. */
  projectsDir?: string;
  defaultProject?: string;
}

export interface ProjectProvider {
  runtime: PlatformAdapter;
  engine?: RecipeEngine;
  cancel?(): void | Promise<void>;
  finalize?(): void | Promise<void>;
}

export interface LoadProjectProviderOptions {
  /** Exact module paths or declared refs authorized by this invocation's operator. */
  authorizedProviders?: readonly string[];
  host?: HarnessHostConfig;
  command?: string;
  options?: CliOptions;
}

// Authority and the checked source identity cannot be supplied by discovered JSON
// or changed by a caller editing the report data between resolution and loading.
const projectProviders = new WeakMap<HarnessContext, ResolvedProjectBinding['provider']>();
const projectLibraries = new WeakMap<HarnessContext, ResolvedProjectLibrary[]>();
const providerOutputRoots = new WeakMap<HarnessContext, string[]>();
const importedProviderSources = new Map<string, string>();

/** Read project metadata and resolve defaults without importing executable code. */
export async function resolveProjectContext(
  options: ResolveProjectContextOptions,
): Promise<HarnessContext> {
  const cwd = options.cwd ?? process.cwd();
  const requested = optionValues(options.tokens, '--target').at(-1);
  const checkoutRoot =
    gitTopLevel(path.resolve(cwd, requested ?? '.')) ?? path.resolve(cwd, requested ?? '.');
  if (!fs.existsSync(checkoutRoot)) {
    throw new ProjectBindingError(
      'TARGET_INCOMPATIBLE',
      `Checkout ${checkoutRoot} does not exist.`,
      'select an existing checkout with --target',
    );
  }
  const divider = options.tokens.indexOf('--');
  const optionEnd = divider < 0 ? options.tokens.length : divider;
  const contextOptions = {
    ...options,
    tokens: [
      ...options.tokens.slice(0, optionEnd),
      '--target',
      checkoutRoot,
      ...options.tokens.slice(optionEnd),
    ],
    adapter: false,
  };
  let context = await resolveHarnessContext(contextOptions);
  let runtime = readBinding(
    checkoutRoot,
    optionValues(options.tokens, '--runtime-dir').at(-1),
  ).runtime;
  const registered = [...(options.projects ?? [])];
  if (options.projectsDir) {
    for (const name of fs.readdirSync(options.projectsDir).sort()) {
      const root = path.join(options.projectsDir, name);
      const file = path.join(root, 'project.json');
      if (fs.existsSync(file)) registered.push({ root, config: readProject(file) });
    }
  }
  const localFile = path.join(checkoutRoot, 'project.json');
  const discovered = fs.existsSync(localFile)
    ? [{ root: checkoutRoot, config: readProject(localFile) }]
    : [];
  const entries = [
    ...registered,
    ...discovered.filter(
      (entry) => !registered.some((existing) => existing.config.name === entry.config.name),
    ),
  ];
  const pool =
    context.slot?.value && context.slot.poolFile
      ? (JSON.parse(fs.readFileSync(context.slot.poolFile, 'utf8')) as {
          project?: string;
          env?: Record<string, string>;
          slots?: Array<{
            id: string;
            project?: string;
            app?: string;
            platform?: string;
          }>;
        })
      : undefined;
  const poolSlot = context.slot?.value ? (context.slot.poolSlot ?? context.slot.value) : undefined;
  const slot = pool?.slots?.find((entry) => entry.id === poolSlot);
  const projectFlag = optionValues(options.tokens, '--project').at(-1);
  const bindingName = stringField(runtime, 'project');
  const slotName = slot?.project ?? pool?.project;
  const named = projectFlag ?? bindingName ?? slotName;
  const remote = checkoutRemote(checkoutRoot) || undefined;
  let source: ContextSource = projectFlag
    ? 'flag'
    : bindingName
      ? 'binding'
      : slotName
        ? 'slot'
        : 'detect';
  let candidates = named
    ? entries.filter((entry) => entry.config.name === named)
    : entries.filter((entry) => {
        if (samePath(entry.root, checkoutRoot)) return true;
        return (
          remote !== undefined &&
          repositoryIdentity(remote) === repositoryIdentity(entry.config.repoUrl)
        );
      });
  if (!named && candidates.length === 0 && options.defaultProject) {
    candidates = entries.filter((entry) => entry.config.name === options.defaultProject);
    source = 'default';
  }
  if (candidates.length !== 1) {
    throw new ProjectBindingError(
      candidates.length > 1 ? 'PROJECT_AMBIGUOUS' : 'PROJECT_NOT_FOUND',
      candidates.length > 1
        ? 'More than one project matches this checkout.'
        : `No project binding found${named ? ` for ${named}` : ''}.`,
      'select a registered project with --project <name>',
      candidates.map((entry) => entry.config.name),
    );
  }
  const selected = candidates[0]!;
  const config = selected.config;
  const root = fs.realpathSync(selected.root);
  const recipe = config.recipe;
  if (!recipe?.provider?.module) {
    throw new ProjectBindingError(
      'PROVIDER_MISSING',
      `Project ${config.name} has no recipe provider.`,
      'configure recipe.provider in project.json',
    );
  }
  const apps = config.apps ?? (recipe.app ? [recipe.app] : []);
  const appFlag = optionValues(options.tokens, '--app').at(-1);
  const selectedApp = appFlag ?? stringField(runtime, 'app') ?? slot?.app;
  const appDirectory = requested ? path.resolve(cwd, requested) : cwd;
  const detectedApps = apps.filter((entry) => within(path.join(checkoutRoot, entry), appDirectory));
  if (!selectedApp && detectedApps.length > 1) {
    throw new ProjectBindingError(
      'APP_AMBIGUOUS',
      'More than one declared app contains this directory.',
      'select an app with --app <path>',
      detectedApps,
    );
  }
  const app =
    selectedApp ?? detectedApps[0] ?? recipe.app ?? (apps.length === 1 ? apps[0] : undefined);
  if ((app && !apps.includes(app)) || (!app && apps.length > 1)) {
    throw new ProjectBindingError(
      app ? 'APP_INCOMPATIBLE' : 'APP_AMBIGUOUS',
      app
        ? `App ${app} is not declared by project ${config.name}.`
        : `Project ${config.name} needs an app selection.`,
      'select a declared app with --app <path>',
      apps,
    );
  }
  const target = app
    ? path.join(checkoutRoot, validateRelativeRecipePath('--app', app))
    : checkoutRoot;
  if (!fs.existsSync(target) || !within(checkoutRoot, target)) {
    throw new ProjectBindingError(
      'TARGET_INCOMPATIBLE',
      `Target ${target} is outside or missing from this checkout.`,
      'select an existing checkout and app',
    );
  }
  if (target !== checkoutRoot) {
    context = await resolveHarnessContext({ ...contextOptions, runtimeTarget: target });
    runtime = readBinding(target, optionValues(options.tokens, '--runtime-dir').at(-1)).runtime;
    const targetProject = stringField(runtime, 'project');
    if (targetProject && targetProject !== config.name && !projectFlag) {
      throw new ProjectBindingError(
        'PROJECT_INCOMPATIBLE',
        `App runtime names project ${targetProject}, not ${config.name}.`,
        'select the intended project explicitly with --project',
      );
    }
  }
  if (
    remote &&
    config.repoUrl &&
    repositoryIdentity(remote) !== repositoryIdentity(config.repoUrl)
  ) {
    throw new ProjectBindingError(
      'PROJECT_INCOMPATIBLE',
      `Project ${config.name} does not match checkout origin ${remote}.`,
      'select the project registered for this checkout',
    );
  }
  const configured = registered.includes(selected);
  validateProjectRecipeConfig(recipe);
  const runtimeDir = validateRelativeRecipePath(
    'runtime directory',
    optionValues(options.tokens, '--runtime-dir').at(-1) ?? recipeRuntimeDir(),
  );
  const artifactDir = validateRelativeRecipePath(
    'artifact directory',
    optionValues(options.tokens, '--artifacts-dir').at(-1) ?? config.paths.artifactDir,
  );
  const outputPaths = {
    checkoutRoot,
    runtimeDir,
    artifactDir,
    farmRuntimeDir: validateRelativeRecipePath('farm runtime directory', config.paths.runtimeDir),
  };
  const excludedRoots = recipeOutputRoots(target, outputPaths);
  const environment = { ...pool?.env, ...(options.load?.env ?? process.env) };
  const existingSourceRoot = (value: string, label = value): string => {
    try {
      return fs.realpathSync(value);
    } catch (error) {
      if (!missing(error)) throw error;
      throw new ProjectBindingError(
        'SOURCE_ROOT_MISSING',
        `Configured source root ${label} does not exist.`,
        'configure an existing provider or library path in the selected pool or project',
      );
    }
  };
  const sourceRoot = (ref: ExecutionTemplateSourceRoot): string => {
    if (!configured)
      throw new ProjectBindingError(
        'SOURCE_UNAUTHORIZED',
        'Discovered root references cannot read operator environment or checkout paths.',
        'register the project before resolving provider or library root references',
      );
    const value = ref.env ? environment[ref.env] : path.resolve(checkoutRoot, ref.projectPath!);
    if (!value)
      throw new ProjectBindingError(
        'SOURCE_ROOT_MISSING',
        `Missing configured source root ${ref.env ?? ref.projectPath}.`,
        `set ${ref.env ?? 'the project path'} in the operator environment or selected pool.env`,
      );
    return existingSourceRoot(value, ref.env ?? ref.projectPath);
  };
  const provider = resolveProvider(
    recipe.provider,
    root,
    configured,
    recipe.provider.root ? sourceRoot(recipe.provider.root) : undefined,
    excludedRoots,
  );
  const overrides = await resolveRecipeLibrarySources({
    cliEntries: optionValues(options.tokens, '--library'),
    ...(options.load?.env ? { env: options.load.env } : {}),
  });
  const libraries: ResolvedProjectLibrary[] = overrides.map((entry) => {
    const libraryRoot = existingSourceRoot(path.resolve(cwd, entry.root));
    const identity = inputSourceSnapshot(libraryRoot, excludedRoots);
    const name = libraryName({ ...entry, root: libraryRoot });
    return {
      ...entry,
      root: libraryRoot,
      name,
      identity,
    };
  });
  for (const entry of recipe.libraries ?? []) {
    const override = libraries.find((library) => library.name === entry.name);
    if (override) {
      const original =
        typeof entry.source === 'string'
          ? path.resolve(root, entry.source)
          : entry.source.env
            ? `env:${entry.source.env}`
            : path.resolve(checkoutRoot, entry.source.projectPath!);
      override.overrides ??= original;
      override.overriddenSource = {
        root: original,
        owner: entry.owner,
        revision: entry.revision,
      };
      continue;
    }
    const libraryRoot =
      typeof entry.source === 'string'
        ? existingSourceRoot(path.resolve(root, entry.source))
        : sourceRoot(entry.source);
    const identity = inputSourceSnapshot(libraryRoot, excludedRoots);
    if (identity.head && !entry.revision) {
      throw new ProjectBindingError(
        'SOURCE_REVISION_MISSING',
        `Library ${entry.name} is a repository source without a pinned revision.`,
        'pin the library revision in project.json',
      );
    }
    checkRevision(entry.revision, identity.head, `library ${entry.name}`);
    libraries.push({
      name: entry.name,
      root: libraryRoot,
      owner: entry.owner,
      revision: entry.revision,
      identity,
    });
  }
  for (const library of libraries) {
    library.provenance = {
      kind: 'library',
      trust: 'unknown',
      name: library.name,
      path: library.root,
      ...(await gitLibraryProvenance(library.root, library.identity)),
    };
  }
  context.target = {
    value: target,
    source: requested ? 'flag' : 'default',
    detail: requested ? '--target' : 'cwd',
  };
  const platform = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const mapped = options.slotAdapter?.(value);
    if (mapped) return mapped;
    const candidate = adapterForPlatform(value);
    return candidate && (harnessAdapters().has(candidate) || candidate === recipe.adapter)
      ? candidate
      : undefined;
  };
  const adapter =
    flagAdapter(options.tokens, options.positionals) ??
    sourced(
      stringField(runtime, 'adapter') ?? platform(stringField(runtime, 'platform')),
      'binding',
      'runtime-context',
    ) ??
    sourced(platform(slot?.platform), 'slot', 'slot-config') ??
    (harnessAdapters().list().length ? detectedAdapter(target, []) : undefined) ??
    sourced(recipe.adapter ?? options.defaultAdapter, 'default', 'project.json');
  if (adapter) context.adapter = adapter;
  context.project = {
    name: config.name,
    source,
    root,
    configPath: path.join(root, 'project.json'),
    ...outputPaths,
    ...(app ? { app } : {}),
    domain: recipe.domain,
    template: recipe.template,
    ...(recipe.manifest ? { manifest: path.resolve(root, recipe.manifest) } : {}),
    provider,
    libraries,
  };
  projectProviders.set(context, structuredClone(provider));
  projectLibraries.set(context, structuredClone(libraries));
  providerOutputRoots.set(context, excludedRoots);
  return context;
}

/** Executable library authority comes from resolution, never mutable report metadata. */
export function authorizedProjectLibraries(context: HarnessContext): ResolvedProjectLibrary[] {
  const provider = projectProviders.get(context);
  return structuredClone(
    (projectLibraries.get(context) ?? []).filter(
      (library) => provider?.authority === 'configured' || library.origin !== undefined,
    ),
  );
}

/** The shared direct/hosted loader. Source identity is checked before import. */
export async function loadProjectProvider(
  context: HarnessContext,
  options: LoadProjectProviderOptions = {},
): Promise<ProjectProvider> {
  const provider = projectProviders.get(context);
  if (!provider || !context.project) {
    throw new ProjectBindingError(
      'PROVIDER_MISSING',
      'No resolved project provider is available.',
      'resolve a project binding before loading its provider',
    );
  }
  if (
    provider.authority === 'discovered' &&
    !options.authorizedProviders?.some(
      (entry) => entry === provider.ref || entry === provider.module,
    )
  ) {
    throw new ProjectBindingError(
      'PROVIDER_UNAUTHORIZED',
      `Provider ${provider.ref} was discovered but is not authorized.`,
      'install/configure the provider or explicitly authorize its source',
    );
  }
  const current = providerSourceSnapshot(
    provider.root,
    provider.module,
    providerOutputRoots.get(context),
  );
  if (
    current.head !== provider.identity.head ||
    current.sourceFingerprint !== provider.identity.sourceFingerprint
  ) {
    throw new ProjectBindingError(
      'PROVIDER_SOURCE_CHANGED',
      `Provider ${provider.ref} changed after resolution.`,
      'resolve the current provider again',
    );
  }
  const importedIdentity = importedProviderSources.get(provider.module);
  if (importedIdentity !== undefined && importedIdentity !== current.sourceFingerprint) {
    // ESM dependencies are cached for this process. Refuse to label cached code
    // with a new source identity after another invocation changes the provider.
    throw new ProjectBindingError(
      'PROVIDER_SOURCE_CHANGED',
      `Provider ${provider.ref} changed after it was imported.`,
      'restart the host before loading the changed provider',
    );
  }
  const module = (await import(pathToFileURL(provider.module).href)) as Record<string, unknown>;
  importedProviderSources.set(provider.module, current.sourceFingerprint);
  const createProvider = module[provider.export];
  if (typeof createProvider !== 'function') {
    throw new ProjectBindingError(
      'PROVIDER_INVALID',
      `Provider ${provider.ref} has no ${provider.export} factory.`,
      'export createProvider(context) from the configured module',
    );
  }
  const providerHost = module.providerHost as HarnessHostConfig | undefined;
  const host =
    providerHost || options.host
      ? ({
          ...providerHost,
          ...options.host,
          name: options.host?.name ?? 'farmslot recipe',
        } as HarnessHostConfig)
      : undefined;
  if (host) configureHarnessHost(host);
  const result = (await createProvider({
    ...context,
    ...(host ? { host } : {}),
    command: options.command,
    options: options.options,
    libraries: authorizedProjectLibraries(context),
  })) as ProjectProvider;
  if (!result?.runtime || typeof result.runtime.id !== 'string') {
    throw new ProjectBindingError(
      'PROVIDER_INVALID',
      `Provider ${provider.ref} returned no runtime.`,
      'return { runtime } from createProvider',
    );
  }
  const selection = context.adapter?.value;
  if (
    selection &&
    selection !== result.runtime.id &&
    !result.runtime.targets?.includes(selection)
  ) {
    throw new ProjectBindingError(
      'TARGET_INCOMPATIBLE',
      `Provider runtime ${result.runtime.id} does not support ${selection}.`,
      'select a target supported by the project provider',
    );
  }
  const registry = harnessAdapters();
  if (registry.has(result.runtime.id) && registry.get(result.runtime.id) !== result.runtime) {
    throw new ProjectBindingError(
      'PROVIDER_AMBIGUOUS',
      `Runtime ${result.runtime.id} is already registered by another provider.`,
      'use one provider for each runtime id',
    );
  }
  if (!registry.has(result.runtime.id)) registry.register(result.runtime);
  context.adapter = {
    value: result.runtime.id,
    requested: selection ?? result.runtime.id,
    source: context.adapter?.source ?? 'default',
    detail: context.adapter?.detail ?? 'project provider',
  };
  return result;
}

function readProject(file: string): ProjectConfig {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectConfig & {
    repo_url?: string;
    default_branch?: string;
    paths: ProjectConfig['paths'] & { runtime_dir?: string; artifact_dir?: string };
  };
  // project.json uses the existing pack spelling; registered protocol values
  // already use camelCase. Only the binding's fields need normalization here.
  return {
    ...raw,
    repoUrl: raw.repoUrl ?? raw.repo_url ?? '',
    defaultBranch: raw.defaultBranch ?? raw.default_branch ?? '',
    paths: {
      runtimeDir: raw.paths?.runtimeDir || raw.paths?.runtime_dir || '.agent',
      artifactDir: raw.paths?.artifactDir || raw.paths?.artifact_dir || DEFAULT_TASK_DIR,
    },
  };
}

function stringField(value: RuntimeContext | undefined, key: string): string | undefined {
  return typeof value?.[key] === 'string' ? (value[key] as string) : undefined;
}

function repositoryIdentity(value: string): string {
  const repository = portableRepoIdentity(value);
  if (!repository) return value;
  const sshHost = (host: string): string => {
    const config = execFileSync('ssh', ['-G', '--', host], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
    const resolved = /^hostname (.+)$/mu.exec(config)?.[1];
    if (!resolved)
      throw new ProjectBindingError(
        'PROJECT_ORIGIN_INVALID',
        `Cannot resolve SSH repository host ${host}.`,
        'check the operator SSH host configuration',
      );
    return resolved.toLowerCase();
  };
  if (URL.canParse(value)) {
    const url = new URL(value);
    if (['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol))
      return `${url.protocol === 'ssh:' ? sshHost(url.hostname) : url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}/${repository}`;
  }
  const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/u.exec(value);
  return scp ? `${sshHost(scp[1]!)}/${repository}` : repository;
}

/** The package owning a resolved entry, including entries below nested source/dist directories. */
export function recipePackageRoot(file: string): string {
  let root = path.dirname(file);
  while (!fs.existsSync(path.join(root, 'package.json'))) {
    const parent = path.dirname(root);
    if (parent === root)
      throw new ProjectBindingError(
        'PROVIDER_INVALID',
        'Provider package metadata is missing.',
        'install a valid provider package',
      );
    root = parent;
  }
  return root;
}

function resolveProvider(
  declaration: NonNullable<ProjectConfig['recipe']>['provider'],
  root: string,
  configured: boolean,
  declaredRoot?: string,
  excludedRoots: string[] = [],
): ResolvedProjectBinding['provider'] {
  let file: string;
  try {
    file = declaration.package
      ? createRequire(path.join(declaredRoot ?? root, 'package.json')).resolve(declaration.module)
      : fs.realpathSync(path.resolve(declaredRoot ?? root, declaration.module));
  } catch (error) {
    if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND')
      throw error;
    throw new ProjectBindingError(
      'PROVIDER_MISSING',
      `Provider ${declaration.module} is not available.`,
      'install the configured provider or correct recipe.provider.module',
    );
  }
  const packageRoot = declaration.package
    ? recipePackageRoot(file)
    : (declaredRoot ?? (within(root, file) ? root : path.dirname(file)));
  const metadata = declaration.package
    ? (JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      })
    : undefined;
  if (metadata && metadata.name !== declaration.package) {
    throw new ProjectBindingError(
      'PROVIDER_SOURCE_MISMATCH',
      `Module ${declaration.module} belongs to ${metadata.name}, not ${declaration.package}.`,
      'use a module exported by the declared provider package',
    );
  }
  const identity = providerSourceSnapshot(packageRoot, file, excludedRoots);
  checkRevision(declaration.revision, identity.head, 'provider');
  return {
    ref: declaration.module,
    module: fs.realpathSync(file),
    export: declaration.export ?? 'createProvider',
    package: declaration.package,
    version: metadata?.version,
    root: packageRoot,
    revision: declaration.revision,
    identity,
    authority: configured
      ? 'configured'
      : declaration.package && file.includes(`${path.sep}node_modules${path.sep}`)
        ? 'installed'
        : 'discovered',
  };
}

function checkRevision(expected: string | undefined, actual: string | null, label: string): void {
  if (expected && expected !== actual) {
    throw new ProjectBindingError(
      'SOURCE_REVISION_MISMATCH',
      `Configured ${label} revision ${expected} differs from ${actual ?? 'an unversioned source'}.`,
      'use the pinned source revision or update the operator configuration',
    );
  }
}
