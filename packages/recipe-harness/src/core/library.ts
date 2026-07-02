import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { type InlineFlow, readCatalogFlows } from './flows.js';
import { isRecord, readJsonFile } from './json.js';
import type { LoadedRecipeLibrarySource, RecipeLibrarySource, RecipeLogger } from './types.js';

const LIBRARY_MANIFEST_FILE = 'library.json';
const LIBRARY_FLOWS_DIR = 'flows';
const LIBRARY_FLOW_CATALOG_SUFFIX = '.flows.json';
const LAST_VERIFIED_WARN_AFTER_DAYS = 30;

export interface ResolvedLibraryFlow {
  ref: string;
  flow: InlineFlow;
  raw: Record<string, unknown>;
  source: string;
  /** Catalog file path relative to the library root. */
  file: string;
  /** Source names that also declare this ref at lower precedence. */
  shadows: string[];
  lastVerified?: string;
}

export interface RecipeLibraryResolution {
  sources: LoadedRecipeLibrarySource[];
  flows: ReadonlyMap<string, ResolvedLibraryFlow>;
}

/**
 * Parse a `RECIPE_LIBRARY_PATH`-style value: ordered, colon-separated
 * `name=path` or bare-path entries. Order is precedence (first wins).
 */
export function parseRecipeLibraryPath(value: string): RecipeLibrarySource[] {
  return value
    .split(':')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('=');
      if (separator < 0) return { root: expandTilde(entry) };
      const name = entry.slice(0, separator).trim();
      const root = entry.slice(separator + 1).trim();
      if (!name || !root) {
        throw new Error(`Recipe library entry ${JSON.stringify(entry)} must be name=path or path.`);
      }
      return { name, root: expandTilde(root) };
    });
}

/**
 * The personal library location: `<farmslot home>/recipe-library`
 * (FARMSLOT_HOME env, default ~/.farmslot). The directory may not exist yet.
 */
export function personalRecipeLibraryRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(farmslotHome(env), 'recipe-library');
}

/**
 * Default sources when nothing is configured: the personal library when it
 * exists.
 */
export async function defaultRecipeLibrarySources(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RecipeLibrarySource[]> {
  const personalRoot = personalRecipeLibraryRoot(env);
  try {
    await readFile(path.join(personalRoot, LIBRARY_MANIFEST_FILE), 'utf-8');
  } catch {
    return [];
  }
  return [{ name: 'personal', root: personalRoot }];
}

/**
 * Resolve the ordered library sources for a run: explicit entries (CLI flags
 * first, then RECIPE_LIBRARY_PATH) replace the defaults entirely so a run's
 * precedence is always fully spelled out by whoever configured it.
 */
export async function resolveRecipeLibrarySources(options?: {
  cliEntries?: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<RecipeLibrarySource[]> {
  const env = options?.env ?? process.env;
  const explicit = [
    ...(options?.cliEntries ?? []).flatMap((entry) => parseRecipeLibraryPath(entry)),
    ...(env.RECIPE_LIBRARY_PATH ? parseRecipeLibraryPath(env.RECIPE_LIBRARY_PATH) : []),
  ];
  if (explicit.length > 0) return explicit;
  return defaultRecipeLibrarySources(env);
}

/**
 * Load and merge ordered library sources into one flow resolution. Shadowing
 * across sources is recorded and logged; duplicate refs within one source are
 * an error, matching recipe-local catalog behavior.
 */
export async function loadRecipeLibraries(
  sources: readonly RecipeLibrarySource[],
  logger?: RecipeLogger,
): Promise<RecipeLibraryResolution> {
  const loadedSources: LoadedRecipeLibrarySource[] = [];
  const flows = new Map<string, ResolvedLibraryFlow>();
  const seenNames = new Set<string>();

  for (const source of sources) {
    const root = path.resolve(expandTilde(source.root));
    const manifest = await readLibraryManifest(root);
    const name = source.name ?? manifest.name ?? path.basename(root);
    if (seenNames.has(name)) {
      throw new Error(`Recipe library source ${name} is configured more than once.`);
    }
    seenNames.add(name);

    const sourceFlows = new Map<string, ResolvedLibraryFlow>();
    for (const file of await listFlowCatalogFiles(root)) {
      const catalogPath = path.join(root, LIBRARY_FLOWS_DIR, file);
      const catalog = await readJsonFile(catalogPath);
      assertFlowCatalogKind(catalog, catalogPath);
      for (const entry of readCatalogFlows(catalog, catalogPath)) {
        if (sourceFlows.has(entry.ref)) {
          throw new Error(`Flow ${entry.ref} is declared more than once in library ${name}.`);
        }
        sourceFlows.set(entry.ref, {
          ref: entry.ref,
          flow: entry.flow,
          raw: entry.raw,
          source: name,
          file: path.join(LIBRARY_FLOWS_DIR, file),
          shadows: [],
          ...(lastVerifiedDate(entry.raw) ? { lastVerified: lastVerifiedDate(entry.raw) } : {}),
        });
      }
    }
    loadedSources.push({ name, root, flowCount: sourceFlows.size });

    for (const [ref, resolved] of sourceFlows) {
      const winner = flows.get(ref);
      if (winner) {
        winner.shadows.push(name);
      } else {
        flows.set(ref, resolved);
      }
    }
  }

  if (logger) logResolution(logger, { sources: loadedSources, flows });
  return { sources: loadedSources, flows };
}

export interface EffectiveFlowCatalog {
  catalog: ReadonlyMap<string, InlineFlow>;
  /** Recipe-local declarations that overrode a library-provided ref. */
  overrides: Array<{ ref: string; source: string }>;
}

/**
 * Merge recipe-local flows over library flows. Recipe-local declarations
 * (inline `flows` and explicit `uses` catalogs) always win — the recipe author
 * spelled them out — and any library refs they override are returned (and
 * logged) so runs can report them even for programmatic consumers without a
 * logger. Library flow lookups are recorded into `usedLibraryFlows` so runs
 * can report exactly which library flows produced the proof.
 */
export function createEffectiveFlowCatalog(
  recipeFlows: ReadonlyMap<string, InlineFlow>,
  resolution: RecipeLibraryResolution | undefined,
  usedLibraryFlows: Map<string, ResolvedLibraryFlow>,
  logger?: RecipeLogger,
): EffectiveFlowCatalog {
  if (!resolution || resolution.flows.size === 0) {
    return { catalog: recipeFlows, overrides: [] };
  }
  const fromLibrary = new Map<string, ResolvedLibraryFlow>();
  const merged = new TrackingFlowCatalog(fromLibrary, usedLibraryFlows);
  const overrides: Array<{ ref: string; source: string }> = [];
  for (const [ref, resolved] of resolution.flows) {
    merged.set(ref, resolved.flow);
    fromLibrary.set(ref, resolved);
  }
  for (const [ref, flow] of recipeFlows) {
    const overridden = fromLibrary.get(ref);
    if (overridden) {
      fromLibrary.delete(ref);
      overrides.push({ ref, source: overridden.source });
      logger?.warn(
        `Flow ${ref} is declared by the recipe and overrides the ${overridden.source} library declaration.`,
      );
    }
    merged.set(ref, flow);
  }
  return { catalog: merged, overrides };
}

class TrackingFlowCatalog extends Map<string, InlineFlow> {
  readonly #fromLibrary: ReadonlyMap<string, ResolvedLibraryFlow>;
  readonly #used: Map<string, ResolvedLibraryFlow>;

  constructor(
    fromLibrary: ReadonlyMap<string, ResolvedLibraryFlow>,
    used: Map<string, ResolvedLibraryFlow>,
  ) {
    super();
    this.#fromLibrary = fromLibrary;
    this.#used = used;
  }

  override get(ref: string): InlineFlow | undefined {
    const flow = super.get(ref);
    if (flow) {
      const resolved = this.#fromLibrary.get(ref);
      if (resolved) this.#used.set(ref, resolved);
    }
    return flow;
  }
}

function logResolution(logger: RecipeLogger, resolution: RecipeLibraryResolution): void {
  const summary = resolution.sources
    .map((source) => `${source.name}=${source.root} (${source.flowCount} flows)`)
    .join(', ');
  logger.info(`Recipe libraries: ${summary || 'none'}`);
  for (const flow of resolution.flows.values()) {
    if (flow.shadows.length > 0) {
      logger.warn(
        `Flow ${flow.ref} resolves from ${flow.source} and shadows ${flow.shadows.join(', ')}.`,
      );
    }
    const staleDays = daysSince(flow.lastVerified);
    if (staleDays != null && staleDays > LAST_VERIFIED_WARN_AFTER_DAYS) {
      logger.warn(
        `Flow ${flow.ref} (${flow.source}) was last verified ${staleDays} days ago; re-verify before trusting it as proof setup.`,
      );
    }
  }
}

async function readLibraryManifest(root: string): Promise<{ name?: string }> {
  const manifestPath = path.join(root, LIBRARY_MANIFEST_FILE);
  let manifest: unknown;
  try {
    manifest = await readJsonFile(manifestPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${root} is not a recipe library: ${message}. A library needs a ${LIBRARY_MANIFEST_FILE} with kind "recipe-library".`,
    );
  }
  if (!isRecord(manifest) || manifest.kind !== 'recipe-library') {
    throw new Error(`${manifestPath} must declare kind "recipe-library".`);
  }
  return { ...(typeof manifest.name === 'string' && manifest.name ? { name: manifest.name } : {}) };
}

/** Catalog file names (relative to `<root>/flows/`) of a library, sorted. */
export async function listFlowCatalogFiles(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(root, LIBRARY_FLOWS_DIR), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name.endsWith(LIBRARY_FLOW_CATALOG_SUFFIX),
    )
    .map((entry) => entry.name)
    .sort();
}

function assertFlowCatalogKind(catalog: unknown, catalogPath: string): void {
  if (!isRecord(catalog) || catalog.kind !== 'recipe-flow-catalog') {
    throw new Error(`${catalogPath} must declare kind "recipe-flow-catalog".`);
  }
}

function lastVerifiedDate(raw: Record<string, unknown>): string | undefined {
  const provenance = raw.provenance;
  if (!isRecord(provenance)) return undefined;
  const lastVerified = provenance.lastVerified;
  if (isRecord(lastVerified) && typeof lastVerified.date === 'string') return lastVerified.date;
  return undefined;
}

function daysSince(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const timestamp = Date.parse(date);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1000));
}

function expandTilde(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p;
}
