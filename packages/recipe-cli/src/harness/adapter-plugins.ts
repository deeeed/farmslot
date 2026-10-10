// Platform adapters a recipe library declares in recipe-library.json `adapters`
// (ADR L4). A declared adapter loads only when a command selects it: its module
// resolves inside the library root, is imported, checked against the SDK and
// composed on the adapter it `extends`, then registered with the host's
// built-ins. The library digest the run records covers the module.
//
// Trust: plugins load only from the operator's libraries (--library, the
// operator's RECIPE_LIBRARY_PATH or else the personal library, and what the host
// configures), never from a task-local library beside a recipe or a library the
// host discovered on its own, so loading one is trusted like installing it. Each
// plugin's digest binds what the run approves (see `adapterPlugin`), the plugin
// may import from disk only the files that digest covers (plugin-imports.ts),
// and `adapterPluginChecks` names it in the doctor report.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ADAPTER_SDK_VERSION,
  type AdapterDoctorCheck,
  type PlatformAdapter,
} from '@farmslot/adapter-sdk';
import {
  digestLibraryAdapter,
  libraryAdapterFiles,
  parseRecipeLibraryPath,
  personalRecipeLibraryRoot,
  readRecipeLibraryManifest,
  RECIPE_LIBRARY_MANIFEST_FILE,
  type RecipeLibraryAdapterDeclaration,
  type RecipeLibrarySource,
  RecipeTrustError,
  resolveRecipeLibrarySources,
} from '@farmslot/recipe-runner';

import { adapterForPlatform, harnessAdapters } from './adapters.js';
import type { AdapterCandidate } from './context-state.js';
import { harnessHost } from './host.js';
import { CliError, isRecord } from './parse-args.js';
import { canFencePluginImports, fencePluginImports } from './plugin-imports.js';
import { EXIT } from './shared.js';

export type AdapterPluginErrorCode =
  | 'ADAPTER_SDK_UNSUPPORTED'
  | 'ADAPTER_PLUGIN_INVALID'
  | 'ADAPTER_PLUGIN_LOAD_FAILED'
  | 'ADAPTER_ID_CONFLICT'
  | 'ADAPTER_EXTENDS_UNKNOWN';

/** A declared adapter that cannot be selected. */
export class AdapterPluginError extends CliError {
  readonly code: AdapterPluginErrorCode;
  readonly userAction: string;
  constructor(code: AdapterPluginErrorCode, message: string, userAction: string) {
    super(message, EXIT.usage);
    this.name = 'AdapterPluginError';
    this.code = code;
    this.userAction = userAction;
  }
}

/** One `adapters` entry and the library that declares it. */
export interface DeclaredAdapter extends RecipeLibraryAdapterDeclaration {
  id: string;
  library: string;
  root: string;
}

/** A plugin the loader registered: where it came from and the digest of its code. */
export interface LoadedAdapterPlugin {
  id: string;
  library: string;
  root: string;
  module: string;
  extends?: string;
  /**
   * sha256 over the declaring library's name and real root, the plugin's files
   * (`digestLibraryAdapter`: the module's directory) and, with `extends`, the
   * parent plugin's digest. Taken before the module is imported.
   */
  digest: string;
}

export interface AdapterLibraryOptions {
  /** The command's `--library` entries; RECIPE_LIBRARY_PATH and the personal library follow. */
  libraries?: readonly string[];
  /**
   * Libraries the host configures (e.g. a config file), after those. A source
   * whose name or root is already present is skipped, so an earlier one wins.
   */
  configured?: readonly RecipeLibrarySource[];
  /**
   * The environment the operator started the command with (RECIPE_LIBRARY_PATH,
   * the personal library's home), before the host's own library discovery
   * extended it: plugins load only from the operator's libraries. Defaults to
   * process.env; pass the same value to `adapterChoices` and `ensureAdapterLoaded`.
   */
  env?: NodeJS.ProcessEnv;
}

export interface AdapterLoadOptions extends AdapterLibraryOptions {
  /**
   * Turns a loaded adapter into the host's adapter, e.g. defaults for members
   * the host's registry requires beyond the SDK. Called before registration.
   */
  adopt?(adapter: PlatformAdapter): PlatformAdapter;
}

/**
 * Every adapter id `--adapter` accepts: the registered adapters, then the ids
 * the libraries declare (`declaredAdapterIds`). Reads recipe-library.json only;
 * imports nothing. The libraries are resolved as recipes resolve them: `libraries`
 * (--library), then RECIPE_LIBRARY_PATH entries they don't rename, else the
 * personal library; then `configured`.
 */
export function adapterChoices(
  libraries: readonly string[] = [],
  options: Pick<AdapterLibraryOptions, 'configured' | 'env'> = {},
): string[] {
  const sources = withConfigured(librarySourcesSync(libraries, options.env), options.configured);
  return [...new Set([...harnessAdapters().list(), ...declaredAdapterIds(sources)])];
}

/**
 * The adapter ids these libraries declare in recipe-library.json `adapters`,
 * read without importing anything. A library without a readable manifest
 * declares nothing here; selecting one of its adapters reports the error.
 */
export function declaredAdapterIds(sources: readonly RecipeLibrarySource[]): string[] {
  return [...new Set(sources.flatMap((source) => declaredIdsIn(source.root)))];
}

/**
 * The adapter a command's tokens select, the way commands resolve it: the last
 * `--adapter`, else the adapter of the last `--platform`. Tokens after `--` are
 * passthrough and select nothing.
 */
export function selectedAdapterId(tokens: readonly string[]): string | undefined {
  return (
    lastOptionValue(tokens, '--adapter') ??
    adapterForPlatform(lastOptionValue(tokens, '--platform'))
  );
}

/**
 * Every `adapters` entry the operator's libraries declare, read without
 * importing anything: the libraries the loader trusts (`--library`, the
 * operator's RECIPE_LIBRARY_PATH or else the personal library, then
 * `configured`). A library whose manifest does not read declares nothing here.
 */
export function declaredAdapters(options: AdapterLibraryOptions = {}): Promise<DeclaredAdapter[]> {
  return declarations(options, { lenient: true });
}

/** The plugin the loader registered under `id` in the host's registry, if any. */
export function adapterPlugin(id: string): LoadedAdapterPlugin | undefined {
  return loadedInto(harnessAdapters()).get(id);
}

/** Every plugin the loader registered in the host's registry, in load order. */
export function loadedAdapterPlugins(): LoadedAdapterPlugin[] {
  return [...loadedInto(harnessAdapters()).values()];
}

/**
 * One passing, non-required doctor check per loaded plugin, naming its library,
 * module and digest, so the report shows which plugin code this process runs.
 */
export function adapterPluginChecks(): AdapterDoctorCheck[] {
  return loadedAdapterPlugins().map((plugin) => ({
    id: `adapter-plugin:${plugin.id}`,
    status: 'pass',
    required: false,
    message: `adapter ${plugin.id} is loaded from library ${plugin.library} (${plugin.module}), ${plugin.digest}`,
    detail: plugin.root,
  }));
}

/**
 * Make `id` resolvable: a no-op for an absent id or a registered one, else load
 * the one declaration for it (and what it extends) and register it. A built-in
 * id that a library also declares is a conflict.
 */
export async function ensureAdapterLoaded(
  id: string | undefined,
  options: AdapterLoadOptions = {},
): Promise<void> {
  if (id === undefined) return;
  const registry = harnessAdapters();
  if (loadedInto(registry).has(id)) return;
  if (registry.has(id)) {
    // A built-in: refuse a library that claims its id; never block it on a library error.
    const claims = (await declarations(options, { lenient: true })).filter((d) => d.id === id);
    if (claims.length > 0) throw builtinConflict(id, claims);
    return;
  }
  const declared = await declarations(options, { lenient: false });
  // An id nobody declares is left to the command's own adapter validation.
  if (!declared.some((declaration) => declaration.id === id)) return;
  await load(id, declared, options, []);
}

/** The plugins the loader registered, per host registry. */
const loaded = new WeakMap<object, Map<string, LoadedAdapterPlugin>>();

function loadedInto(registry: object): Map<string, LoadedAdapterPlugin> {
  let plugins = loaded.get(registry);
  if (!plugins) loaded.set(registry, (plugins = new Map()));
  return plugins;
}

async function load(
  id: string,
  declared: readonly DeclaredAdapter[],
  options: AdapterLoadOptions,
  chain: readonly string[],
): Promise<PlatformAdapter> {
  const registry = harnessAdapters();
  if (registry.has(id)) {
    const claims = declared.filter((d) => d.id === id);
    if (!loadedInto(registry).has(id) && claims.length > 0) throw builtinConflict(id, claims);
    return registry.get(id);
  }
  const claims = declared.filter((d) => d.id === id);
  if (claims.length === 0) {
    // Only an `extends` reaches here: ensureAdapterLoaded loads declared ids.
    throw new AdapterPluginError(
      'ADAPTER_EXTENDS_UNKNOWN',
      `adapter '${chain.at(-1)}' extends '${id}', which no registered adapter or library declares.`,
      `register '${id}' or put the library that declares it on RECIPE_LIBRARY_PATH`,
    );
  }
  if (claims.length > 1)
    throw new AdapterPluginError(
      'ADAPTER_ID_CONFLICT',
      `adapter '${id}' is declared by more than one library: ${claims.map((d) => d.library).join(', ')}.`,
      `keep '${id}' in one library on RECIPE_LIBRARY_PATH`,
    );
  if (chain.includes(id))
    throw new AdapterPluginError(
      'ADAPTER_EXTENDS_UNKNOWN',
      `adapter '${id}' extends itself through ${[...chain, id].join(' → ')}.`,
      'break the extends cycle in recipe-library.json',
    );
  const declaration = claims[0]!;
  const parent = declaration.extends
    ? await load(declaration.extends, declared, options, [...chain, id])
    : undefined;
  // The digest is taken before the import, so it covers the code that loads.
  const digest = await pluginDigest(
    declaration,
    loadedInto(registry).get(declaration.extends ?? ''),
  );
  const plugin = await importDeclared(declaration);
  const composed = parent ? composeAdapter(parent, plugin) : plugin;
  assertAdapterMembers(composed, declaration);
  const adopted = options.adopt ? options.adopt(composed) : composed;
  registry.register(adopted);
  loadedInto(registry).set(id, {
    id,
    library: declaration.library,
    root: declaration.root,
    module: declaration.module,
    ...(declaration.extends ? { extends: declaration.extends } : {}),
    digest,
  });
  return adopted;
}

async function pluginDigest(
  declaration: DeclaredAdapter,
  parent: LoadedAdapterPlugin | undefined,
): Promise<string> {
  const files = await digestLibraryAdapter(declaration.root, declaration);
  const identity = [
    declaration.library,
    fs.realpathSync(declaration.root),
    declaration.id,
    files,
    parent?.digest ?? '',
  ].join('\0');
  return `sha256:${createHash('sha256').update(identity).digest('hex')}`;
}

async function importDeclared(declaration: DeclaredAdapter): Promise<PlatformAdapter> {
  // recipe-library.json validation already proved the module resolves inside the root.
  const file = fs.realpathSync(path.resolve(declaration.root, declaration.module));
  if (!canFencePluginImports())
    throw new AdapterPluginError(
      'ADAPTER_PLUGIN_LOAD_FAILED',
      `adapter '${declaration.id}' from library ${declaration.library} needs Node.js 22.15 or later (module.registerHooks fences a plugin's imports); this is ${process.version}.`,
      'upgrade Node.js to 22.15 or later',
    );
  // The plugin may import from disk only the files its digest covers.
  const covered = await libraryAdapterFiles(declaration.root, declaration);
  const moduleDir = path.posix.dirname(
    path
      .relative(declaration.root, path.resolve(declaration.root, declaration.module))
      .split(path.sep)
      .join('/'),
  );
  const inModuleDir = (relative: string) =>
    moduleDir === '.' ? !relative.startsWith('actions/') : relative.startsWith(`${moduleDir}/`);
  const real = (relative: string) => fs.realpathSync(path.join(declaration.root, relative));
  fencePluginImports({
    id: declaration.id,
    library: declaration.library,
    root: fs.realpathSync(declaration.root),
    moduleFiles: new Set(covered.filter(inModuleDir).map(real)),
    files: new Set(covered.map(real)),
    hostURL: pathToFileURL(path.join(harnessHost().packageRoot, 'package.json')).href,
    hostRoot: fs.realpathSync(harnessHost().packageRoot),
  });
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (error) {
    // The fence's refusal keeps its code: the plugin imports code its digest misses.
    if (error instanceof RecipeTrustError) throw error;
    throw new AdapterPluginError(
      'ADAPTER_PLUGIN_LOAD_FAILED',
      `adapter '${declaration.id}' from library ${declaration.library} failed to load: ${error instanceof Error ? error.message : String(error)}`,
      `fix ${declaration.module} in ${declaration.root}`,
    );
  }
  const exportName = declaration.export ?? 'default';
  const value = module[exportName];
  const where = `${declaration.module} (library ${declaration.library})`;
  if (!isRecord(value))
    throw new AdapterPluginError(
      'ADAPTER_PLUGIN_INVALID',
      `adapter '${declaration.id}': ${where} has no ${exportName === 'default' ? 'default export' : `export '${exportName}'`} holding an adapter.`,
      `export the adapter from ${declaration.module}, or fix "export" in ${RECIPE_LIBRARY_MANIFEST_FILE}`,
    );
  if (value.id !== declaration.id)
    throw new AdapterPluginError(
      'ADAPTER_PLUGIN_INVALID',
      `adapter '${declaration.id}': ${where} exports an adapter with id '${String(value.id)}'.`,
      `make the adapter's id '${declaration.id}', or declare it under its own id`,
    );
  if (value.sdkVersion !== ADAPTER_SDK_VERSION)
    throw new AdapterPluginError(
      'ADAPTER_SDK_UNSUPPORTED',
      `adapter '${declaration.id}' targets adapter SDK ${String(value.sdkVersion)}; ${harnessHost().name} implements ${ADAPTER_SDK_VERSION}.`,
      `use a version of library ${declaration.library} built for adapter SDK ${ADAPTER_SDK_VERSION}`,
    );
  if (value.extends !== undefined && value.extends !== declaration.extends)
    throw new AdapterPluginError(
      'ADAPTER_PLUGIN_INVALID',
      `adapter '${declaration.id}' extends '${String(value.extends)}' in code but '${declaration.extends ?? 'nothing'}' in ${RECIPE_LIBRARY_MANIFEST_FILE}.`,
      `make "extends" in ${RECIPE_LIBRARY_MANIFEST_FILE} match the adapter`,
    );
  return value as unknown as PlatformAdapter;
}

/**
 * `child` on top of `parent`: the child's members replace the parent's, except
 * three that append, parent first: the action manifests (`actions.manifestPaths`),
 * the action implementations (`actions.adapters`) and the doctor checks (`doctor`).
 * `readiness` merges member by member, so a child that sets one keeps the rest.
 */
export function composeAdapter(parent: PlatformAdapter, child: PlatformAdapter): PlatformAdapter {
  const parentActions = parent.actions;
  const childActions: Partial<PlatformAdapter['actions']> = child.actions ?? {};
  const manifestPaths = (actions: Partial<PlatformAdapter['actions']>): readonly string[] =>
    actions.manifestPaths?.() ?? (actions.manifestPath ? [actions.manifestPath()] : []);
  const readiness =
    parent.readiness || child.readiness ? { ...parent.readiness, ...child.readiness } : undefined;
  return {
    ...parent,
    ...child,
    ...(readiness ? { readiness } : {}),
    extends: parent.id,
    actions: {
      ...parentActions,
      ...childActions,
      manifestPaths: () => [
        ...new Set([...manifestPaths(parentActions), ...manifestPaths(childActions)]),
      ],
      async adapters() {
        return [
          ...((await parentActions.adapters?.()) ?? []),
          ...((await childActions.adapters?.()) ?? []),
        ];
      },
    },
    async doctor(target) {
      return [
        ...((await parent.doctor?.(target)) ?? []),
        ...((await child.doctor?.(target)) ?? []),
      ];
    },
  };
}

// What the commands call on every adapter; the SDK types mark the rest optional.
const REQUIRED_FUNCTIONS = [
  'resolveSlotPorts',
  'runtimeStatus',
  'logSources',
  'appLogSource',
  'launch',
] as const;
const REQUIRED_OBJECTS = ['devServer', 'hints', 'actions', 'harness', 'runtimeContext'] as const;

function assertAdapterMembers(adapter: PlatformAdapter, declaration: DeclaredAdapter): void {
  const record = adapter as unknown as Record<string, unknown>;
  const actions = isRecord(record.actions) ? record.actions : {};
  const missing = [
    ...REQUIRED_FUNCTIONS.filter((member) => typeof record[member] !== 'function'),
    ...REQUIRED_OBJECTS.filter((member) => !isRecord(record[member])),
    ...(typeof actions.manifestPath === 'function' ? [] : ['actions.manifestPath']),
    ...(Array.isArray(actions.semantic) ? [] : ['actions.semantic']),
    ...(isRecord(actions.cdpTarget) ? [] : ['actions.cdpTarget']),
    ...(typeof record.headless === 'boolean' ? [] : ['headless']),
  ];
  if (missing.length > 0)
    throw new AdapterPluginError(
      'ADAPTER_PLUGIN_INVALID',
      `adapter '${declaration.id}' from library ${declaration.library} lacks ${missing.join(', ')}.`,
      declaration.extends
        ? `add the members to ${declaration.module}`
        : `add the members to ${declaration.module}, or extend an adapter that has them`,
    );
}

function builtinConflict(id: string, claims: readonly DeclaredAdapter[]): AdapterPluginError {
  return new AdapterPluginError(
    'ADAPTER_ID_CONFLICT',
    `adapter '${id}' is built into ${harnessHost().name}; library ${claims.map((d) => d.library).join(', ')} may not declare it.`,
    `rename the adapter in ${claims[0]!.root}/${RECIPE_LIBRARY_MANIFEST_FILE}`,
  );
}

async function declarations(
  options: AdapterLoadOptions,
  mode: { lenient: boolean },
): Promise<DeclaredAdapter[]> {
  // No recipePath: a task-local library beside a recipe never declares adapters.
  // Selecting a built-in checks the entries that parse, the set adapterChoices
  // reads, so an entry that doesn't parse never blocks it.
  const sources = withConfigured(
    mode.lenient
      ? librarySourcesSync(options.libraries ?? [], options.env)
      : await resolveRecipeLibrarySources({
          cliEntries: [...(options.libraries ?? [])],
          ...(options.env ? { env: options.env } : {}),
        }),
    options.configured,
  );
  const declared: DeclaredAdapter[] = [];
  for (const source of sources) {
    let manifest;
    try {
      manifest = await readRecipeLibraryManifest(source.root);
    } catch (error) {
      // Selecting a built-in only looks for libraries that claim its id, so a
      // broken library never blocks it; selecting a plugin reports the error.
      if (mode.lenient) continue;
      throw error;
    }
    for (const [id, declaration] of Object.entries(manifest?.adapters ?? {})) {
      declared.push({ ...declaration, id, library: libraryName(source), root: source.root });
    }
  }
  return declared;
}

// An unnamed entry takes its resolved directory's name, as recipe-runner's
// resolver names it, so `--library .` overrides the same-named env library.
export function libraryName(source: RecipeLibrarySource): string {
  return source.name ?? path.basename(path.resolve(source.root));
}

/**
 * `resolveRecipeLibrarySources` without the file system, for the grammar: the
 * `--library` entries, then the RECIPE_LIBRARY_PATH entries they don't rename,
 * else the personal library.
 */
function librarySourcesSync(
  libraries: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): RecipeLibrarySource[] {
  const flagged = libraries.flatMap((entry) => safeParse(entry));
  const renamed = new Set(flagged.map(libraryName));
  const environment = safeParse(env.RECIPE_LIBRARY_PATH ?? '').filter(
    (source) => !renamed.has(libraryName(source)),
  );
  const explicit = [...flagged, ...environment];
  if (explicit.length > 0) return explicit;
  const personal = personalRecipeLibraryRoot(env);
  return fs.existsSync(personal) ? [{ name: 'personal', root: personal }] : [];
}

function withConfigured(
  sources: readonly RecipeLibrarySource[],
  configured: readonly RecipeLibrarySource[] = [],
): RecipeLibrarySource[] {
  const result = [...sources];
  for (const source of configured) {
    const present = result.some(
      (existing) =>
        libraryName(existing) === libraryName(source) ||
        path.resolve(existing.root) === path.resolve(source.root),
    );
    if (!present) result.push(source);
  }
  return result;
}

// Each entry of a colon-joined value on its own, so a malformed entry drops
// only itself and the libraries beside it still count.
function safeParse(value: string): RecipeLibrarySource[] {
  return value.split(':').flatMap((entry) => {
    try {
      return parseRecipeLibraryPath(entry);
    } catch {
      // A malformed entry adds no adapter ids and claims nothing; the command
      // that resolves its libraries reports RECIPE_LIBRARY_PATH_INVALID itself.
      return [];
    }
  });
}

function declaredIdsIn(root: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, RECIPE_LIBRARY_MANIFEST_FILE), 'utf8');
  } catch (error) {
    // A library without recipe-library.json declares no adapters.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) && isRecord(value.adapters) ? Object.keys(value.adapters) : [];
  } catch {
    // Invalid JSON declares nothing for the grammar, so `--adapter core` still
    // validates; selecting a plugin reads the manifest strictly and reports it.
    return [];
  }
}

function lastOptionValue(tokens: readonly string[], name: string): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === '--') break;
    if (token === name && tokens[index + 1] !== undefined) value = tokens[(index += 1)];
    else if (token.startsWith(`${name}=`)) value = token.slice(name.length + 1);
  }
  return value;
}

/**
 * Print a refused adapter selection: the `--json` envelope or the human line.
 * Takes any error with a `code` and `userAction` (the loader's, the library
 * reader's RECIPE_SOURCE_INVALID, and ADAPTER_AMBIGUOUS with its `candidates`);
 * returns the exit code.
 */
export function adapterSelectionFailureOut(
  json: boolean,
  command: string,
  error: {
    code: string;
    message: string;
    userAction: string;
    candidates?: readonly AdapterCandidate[] | readonly string[];
  },
): number {
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command,
          status: 'fail',
          exitCode: EXIT.usage,
          error: {
            code: error.code,
            message: error.message,
            userAction: error.userAction,
            ...(error.candidates ? { candidates: error.candidates } : {}),
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(
      `✗ ${harnessHost().name} ${command}: ${error.message}\n  Next: ${error.userAction}`,
    );
  }
  return EXIT.usage;
}
