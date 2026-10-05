// Platform adapters a recipe library declares in recipe-library.json `adapters`
// (ADR L4). A declared adapter loads only when a command selects it: its module
// resolves inside the library root, is imported, checked against the SDK and
// composed on the adapter it `extends`, then registered with the host's
// built-ins. The library digest the run records covers the module.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ADAPTER_SDK_VERSION, type PlatformAdapter } from '@farmslot/adapter-sdk';
import {
  parseRecipeLibraryPath,
  personalRecipeLibraryRoot,
  readRecipeLibraryManifest,
  RECIPE_LIBRARY_MANIFEST_FILE,
  type RecipeLibraryAdapterDeclaration,
  type RecipeLibrarySource,
  resolveRecipeLibrarySources,
} from '@farmslot/recipe-runner';

import { harnessAdapters } from './adapters.js';
import { harnessHost } from './host.js';
import { CliError, isRecord } from './parse-args.js';
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

export interface AdapterLoadOptions {
  /** The command's `--library` entries; RECIPE_LIBRARY_PATH and the personal library follow. */
  libraries?: readonly string[];
  /**
   * Turns a loaded adapter into the host's adapter, e.g. defaults for members
   * the host's registry requires beyond the SDK. Called before registration.
   */
  adopt?(adapter: PlatformAdapter): PlatformAdapter;
}

/**
 * Every adapter id `--adapter` accepts: the registered adapters, then the ids
 * the configured libraries declare. Reads recipe-library.json only; imports nothing.
 * The libraries are RECIPE_LIBRARY_PATH (else the personal library) plus `libraries`.
 */
export function adapterChoices(libraries: readonly string[] = []): string[] {
  const ids = new Set(harnessAdapters().list());
  for (const root of configuredLibraryRoots(libraries)) {
    for (const id of declaredIdsIn(root)) ids.add(id);
  }
  return [...ids];
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
  if (registry.has(id) && loadedInto(registry).has(id)) return;
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

/** Adapter ids the loader registered, per host registry. */
const loaded = new WeakMap<object, Set<string>>();

function loadedInto(registry: object): Set<string> {
  let ids = loaded.get(registry);
  if (!ids) loaded.set(registry, (ids = new Set()));
  return ids;
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
  const plugin = await importDeclared(declaration);
  const composed = parent ? composeAdapter(parent, plugin) : plugin;
  assertAdapterMembers(composed, declaration);
  const adopted = options.adopt ? options.adopt(composed) : composed;
  registry.register(adopted);
  loadedInto(registry).add(id);
  return adopted;
}

async function importDeclared(declaration: DeclaredAdapter): Promise<PlatformAdapter> {
  // recipe-library.json validation already proved the module resolves inside the root.
  const file = fs.realpathSync(path.resolve(declaration.root, declaration.module));
  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (error) {
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
 */
export function composeAdapter(parent: PlatformAdapter, child: PlatformAdapter): PlatformAdapter {
  const parentActions = parent.actions;
  const childActions: Partial<PlatformAdapter['actions']> = child.actions ?? {};
  const manifestPaths = (actions: Partial<PlatformAdapter['actions']>): readonly string[] =>
    actions.manifestPaths?.() ?? (actions.manifestPath ? [actions.manifestPath()] : []);
  return {
    ...parent,
    ...child,
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
  const sources = await resolveRecipeLibrarySources({ cliEntries: [...(options.libraries ?? [])] });
  const declared: DeclaredAdapter[] = [];
  for (const source of sources) {
    let manifest;
    try {
      manifest = await readRecipeLibraryManifest(source.root);
    } catch (error) {
      if (mode.lenient) continue;
      throw error;
    }
    for (const [id, declaration] of Object.entries(manifest?.adapters ?? {})) {
      declared.push({ ...declaration, id, library: libraryName(source), root: source.root });
    }
  }
  return declared;
}

function libraryName(source: RecipeLibrarySource): string {
  return source.name ?? path.basename(source.root);
}

function configuredLibraryRoots(libraries: readonly string[]): string[] {
  const entries = [...libraries.flatMap((entry) => safeParse(entry))];
  const environment = process.env.RECIPE_LIBRARY_PATH;
  if (environment) entries.push(...safeParse(environment));
  if (entries.length === 0) {
    const personal = personalRecipeLibraryRoot(process.env);
    if (fs.existsSync(personal)) entries.push({ root: personal });
  }
  return entries.map((entry) => entry.root);
}

function safeParse(value: string): RecipeLibrarySource[] {
  try {
    return parseRecipeLibraryPath(value);
  } catch {
    return [];
  }
}

function declaredIdsIn(root: string): string[] {
  try {
    const value: unknown = JSON.parse(
      fs.readFileSync(path.join(root, RECIPE_LIBRARY_MANIFEST_FILE), 'utf8'),
    );
    return isRecord(value) && isRecord(value.adapters) ? Object.keys(value.adapters) : [];
  } catch {
    return [];
  }
}

/**
 * Print a refused adapter selection: the `--json` envelope or the human line.
 * Takes any error with a `code` and `userAction` (the loader's, and the library
 * reader's RECIPE_SOURCE_INVALID); returns the exit code.
 */
export function adapterSelectionFailureOut(
  json: boolean,
  command: string,
  error: { code: string; message: string; userAction: string },
): number {
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command,
          status: 'fail',
          exitCode: EXIT.usage,
          error: { code: error.code, message: error.message, userAction: error.userAction },
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
