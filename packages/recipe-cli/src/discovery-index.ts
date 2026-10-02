import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  isRecord,
  OFFICIAL_RECIPE_ACTIONS,
  type OfficialActionName,
  officialRecipeActionCapabilities,
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeActionManifestDocument,
  type RecipeExecutionCapability,
  validateRecipeActionManifestDocument,
  validateRecipeWithManifest,
} from '@farmslot/protocol';
import {
  createStandardCoreAdapters,
  loadRecipeLibraries,
  type RecipeLibraryEnv,
  type RecipeLibraryResolution,
  RecipeResolutionError,
  type ResolvedLibraryRecipe,
  resolveRecipeDependencies,
  SHARED_RECIPE_SCOPE,
} from '@farmslot/recipe-harness';

import { DiscoveryError } from './discovery-error.js';
import { type ResolvedDiscoveryLibrary, resolveDiscoveryLibraries } from './libraries.js';
import type {
  DiscoveryAction,
  DiscoveryActionHandler,
  DiscoveryLibrary,
  DiscoveryParameter,
  DiscoveryProblem,
  DiscoveryRecipe,
  DiscoveryRecipeVariant,
} from './types.js';

const OFFICIAL_ACTIONS = new Set<string>(OFFICIAL_RECIPE_ACTIONS);
const RUNNER_ACTIONS = new Set(['call', 'end']);

export interface DiscoveryOptions {
  /** `--library` entries, `name=path` or `path`. */
  libraries?: readonly string[];
  /** Platform view: selects platform variants and platform action manifests. */
  platform?: string;
  env?: RecipeLibraryEnv;
  /** Actions with a handler registered by the host CLI. Defaults to the standard core handlers. */
  handlers?: readonly string[];
}

/** Internal action record: the public summary plus its schema and examples. */
export interface IndexedAction extends DiscoveryAction {
  schema: unknown;
  examples: unknown[];
}

/** Recipes, actions and libraries visible from one platform view. */
export interface RecipeDiscoveryIndex {
  platform: string | null;
  platforms: string[];
  libraries: ResolvedDiscoveryLibrary[];
  /** Resolution used by `run` for this view: precedence winners, keyed by ref. */
  resolution: RecipeLibraryResolution;
  /** Every declared action for this view, merged by precedence, as a runner manifest. */
  manifest: RecipeActionManifestDocument;
  actions: ReadonlyMap<string, IndexedAction>;
  recipes: ReadonlyMap<string, DiscoveryRecipe>;
  /** Full recipe records for this view, keyed by ref, aliases excluded. */
  documents: ReadonlyMap<string, ResolvedLibraryRecipe>;
}

export async function buildDiscoveryIndex(
  options: DiscoveryOptions = {},
): Promise<RecipeDiscoveryIndex> {
  const libraries = await resolveDiscoveryLibraries(options);
  const sources = libraries.map((library) => library.source);
  const platform = options.platform ?? null;
  const platforms = [
    ...new Set([
      ...libraries.flatMap((library) => library.info.platforms),
      ...libraries.flatMap((library) =>
        library.info.actionManifests
          .map((file) => file.scope)
          .filter((scope) => scope !== SHARED_RECIPE_SCOPE),
      ),
      ...(platform ? [platform] : []),
    ]),
  ].sort();

  const resolution = await loadRecipeLibraries(sources, platform ? { adapter: platform } : {});
  const documents = new Map([...resolution.recipes].filter(([, recipe]) => !recipe.aliasFor));
  const variants = await recipeVariants(sources, platforms);
  const { actions, manifest } = await indexActions(
    libraries,
    platform,
    new Set(options.handlers ?? createStandardCoreAdapters().map((adapter) => adapter.action)),
  );
  const recipes = indexRecipes(documents, resolution, manifest, variants, platform);
  return {
    platform,
    platforms,
    libraries,
    resolution,
    manifest,
    actions,
    recipes,
    documents,
  };
}

export function libraryInfos(index: RecipeDiscoveryIndex): DiscoveryLibrary[] {
  return index.libraries.map((library) => library.info);
}

interface RecipeImplementations {
  variants: DiscoveryRecipeVariant[];
  /** The generic recipe, else the first platform variant; describes variant-only refs. */
  representative: ResolvedLibraryRecipe;
}

/** Every implementation of each ref: the generic recipe and each platform variant. */
async function recipeVariants(
  sources: ResolvedDiscoveryLibrary['source'][],
  platforms: readonly string[],
): Promise<Map<string, RecipeImplementations>> {
  const implementations = new Map<string, RecipeImplementations>();
  const add = (recipe: ResolvedLibraryRecipe, platform: string | null) => {
    const variant = { platform, source: recipe.source, file: recipe.file };
    const existing = implementations.get(recipe.ref);
    if (existing) existing.variants.push(variant);
    else implementations.set(recipe.ref, { variants: [variant], representative: recipe });
  };
  const generic = await loadRecipeLibraries(sources);
  for (const recipe of generic.recipes.values()) if (!recipe.aliasFor) add(recipe, null);
  for (const platform of platforms) {
    const view = await loadRecipeLibraries(sources, { adapter: platform });
    for (const recipe of view.recipes.values()) {
      if (!recipe.aliasFor && recipe.adapter === platform) add(recipe, platform);
    }
  }
  return implementations;
}

async function indexActions(
  libraries: readonly ResolvedDiscoveryLibrary[],
  platform: string | null,
  handlers: ReadonlySet<string>,
): Promise<{ actions: Map<string, IndexedAction>; manifest: RecipeActionManifestDocument }> {
  const actions = new Map<string, IndexedAction>();
  const viewActions: RecipeActionManifestDocument['actions'] = {};
  const observers = new Map<string, unknown>();
  const viewScopes = platform ? [platform, SHARED_RECIPE_SCOPE] : null;

  for (const library of libraries) {
    // Platform manifest before shared, matching platform variants before generic recipes.
    const files = [...library.info.actionManifests].sort(
      (left, right) =>
        Number(left.scope === SHARED_RECIPE_SCOPE) - Number(right.scope === SHARED_RECIPE_SCOPE) ||
        left.scope.localeCompare(right.scope),
    );
    for (const file of files) {
      if (viewScopes && !viewScopes.includes(file.scope)) continue;
      const document = await readActionManifest(library, file.file);
      // The all-platform view can only rely on shared declarations.
      const inView = platform !== null || file.scope === SHARED_RECIPE_SCOPE;
      for (const [name, entry] of Object.entries(document.actions)) {
        const existing = actions.get(name);
        if (existing) {
          if (!existing.platforms.includes(file.scope)) existing.platforms.push(file.scope);
          if (
            existing.source !== library.info.name &&
            !existing.shadows.includes(library.info.name)
          )
            existing.shadows.push(library.info.name);
        } else {
          actions.set(name, describeAction(name, entry, library.info.name, file, handlers));
        }
        if (inView && !Object.hasOwn(viewActions, name)) viewActions[name] = entry;
      }
      if (inView) {
        for (const observer of document.observers ?? []) {
          const ref = isRecord(observer) && typeof observer.ref === 'string' ? observer.ref : null;
          if (ref && !observers.has(ref)) observers.set(ref, observer);
        }
      }
    }
  }

  for (const name of [...handlers, ...RUNNER_ACTIONS]) {
    if (actions.has(name)) continue;
    actions.set(name, {
      name,
      kind: OFFICIAL_ACTIONS.has(name) ? 'official' : 'custom',
      description: '',
      parameters: [],
      capabilities: actionCapabilities(name, undefined),
      handler: actionHandler(name, handlers),
      declared: RUNNER_ACTIONS.has(name),
      source: null,
      manifest: null,
      shadows: [],
      platforms: [],
      resultCases: [],
      schema: null,
      examples: [],
    });
  }
  for (const action of actions.values()) action.platforms.sort();

  const manifest = {
    $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
    actions: viewActions,
    ...(observers.size > 0 ? { observers: [...observers.values()] } : {}),
  } as RecipeActionManifestDocument;
  return {
    actions: new Map([...actions].sort(([left], [right]) => left.localeCompare(right))),
    manifest,
  };
}

async function readActionManifest(
  library: ResolvedDiscoveryLibrary,
  file: string,
): Promise<RecipeActionManifestDocument> {
  const absolute = path.join(library.info.root, file);
  let document: unknown;
  try {
    document = JSON.parse(await readFile(absolute, 'utf8'));
  } catch (error) {
    throw new DiscoveryError(
      'ACTION_MANIFEST_INVALID',
      `Action manifest ${absolute} is unreadable: ${error instanceof Error ? error.message : String(error)}.`,
      `fix ${file} in library ${library.info.name}`,
    );
  }
  const validation = validateRecipeActionManifestDocument(document);
  if (validation.status === 'invalid') {
    throw new DiscoveryError(
      'ACTION_MANIFEST_INVALID',
      `Action manifest ${absolute} is invalid: ${validation.findings
        .filter((finding) => finding.severity === 'error')
        .map((finding) => `${finding.code} ${finding.path}`)
        .join(', ')}.`,
      `fix ${file} in library ${library.info.name} so it validates as an action manifest v1`,
    );
  }
  return document as RecipeActionManifestDocument;
}

function describeAction(
  name: string,
  entry: unknown,
  source: string,
  file: { scope: string; file: string },
  handlers: ReadonlySet<string>,
): IndexedAction {
  const record = isRecord(entry) ? entry : {};
  return {
    name,
    kind: OFFICIAL_ACTIONS.has(name) ? 'official' : 'custom',
    description: typeof record.description === 'string' ? record.description : '',
    parameters: schemaParameters(record.schema, ['action', 'next']),
    capabilities: actionCapabilities(name, record.execution_capabilities),
    handler: actionHandler(name, handlers),
    declared: true,
    source,
    manifest: file.file,
    shadows: [],
    platforms: [file.scope],
    resultCases: Array.isArray(record.result_cases)
      ? record.result_cases.filter((value): value is string => typeof value === 'string')
      : [],
    schema: record.schema ?? null,
    examples: Array.isArray(record.examples) ? record.examples : [],
  };
}

function actionHandler(name: string, handlers: ReadonlySet<string>): DiscoveryActionHandler {
  if (RUNNER_ACTIONS.has(name)) return 'runner';
  return handlers.has(name) ? 'builtin' : 'adapter';
}

function actionCapabilities(name: string, declared: unknown): RecipeExecutionCapability[] {
  return [
    ...new Set([
      ...(Array.isArray(declared)
        ? declared.filter((value): value is RecipeExecutionCapability => typeof value === 'string')
        : []),
      ...(OFFICIAL_ACTIONS.has(name)
        ? officialRecipeActionCapabilities(name as OfficialActionName)
        : []),
    ]),
  ].sort();
}

/** Parameters of a JSON schema object, in declaration order. */
export function schemaParameters(
  schema: unknown,
  exclude: readonly string[] = [],
): DiscoveryParameter[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
  return Object.entries(schema.properties)
    .filter(([name]) => !exclude.includes(name))
    .map(([name, raw]) => {
      const property = isRecord(raw) ? raw : {};
      return {
        name,
        ...(typeof property.type === 'string' ? { type: property.type } : {}),
        required: required.has(name),
        ...(Object.hasOwn(property, 'default') ? { default: property.default } : {}),
        ...(Array.isArray(property.enum) ? { enum: property.enum } : {}),
        ...(typeof property.description === 'string' ? { description: property.description } : {}),
      };
    });
}

function indexRecipes(
  documents: ReadonlyMap<string, ResolvedLibraryRecipe>,
  resolution: RecipeLibraryResolution,
  manifest: RecipeActionManifestDocument,
  variants: ReadonlyMap<string, RecipeImplementations>,
  platform: string | null,
): Map<string, DiscoveryRecipe> {
  const readiness = recipeReadiness(documents, resolution, manifest);
  const recipes = new Map<string, DiscoveryRecipe>();
  for (const recipe of documents.values()) {
    const state = readiness.get(recipe.ref)!;
    recipes.set(recipe.ref, {
      ...recipeSummary(recipe),
      variants: variants.get(recipe.ref)?.variants ?? [],
      runnable: state.problems.length === 0,
      problems: state.problems,
    });
  }
  if (!platform) {
    // Refs that only exist as platform variants are runnable only from a platform view.
    for (const [ref, { variants: implementations, representative }] of variants) {
      if (recipes.has(ref)) continue;
      recipes.set(ref, {
        ...recipeSummary(representative),
        variants: implementations,
        runnable: null,
        problems: [],
      });
    }
  }
  return new Map([...recipes].sort(([left], [right]) => left.localeCompare(right)));
}

export function recipeSummary(
  recipe: ResolvedLibraryRecipe,
): Omit<DiscoveryRecipe, 'variants' | 'runnable' | 'problems'> {
  const document = recipe.document;
  return {
    ref: recipe.ref,
    id: `${recipe.source}.${recipe.ref}`,
    ...(typeof document.title === 'string' && document.title.trim()
      ? { title: document.title.trim() }
      : {}),
    ...(typeof document.description === 'string' && document.description.trim()
      ? { description: document.description.trim() }
      : {}),
    source: recipe.source,
    file: recipe.file,
    variant: recipe.adapter ?? null,
    shadows: [...recipe.shadows],
    parameters: schemaParameters(document.paramsSchema),
  };
}

/**
 * A recipe is runnable when it validates against the view's declared actions and every recipe
 * it calls resolves and validates too (the same rule `mm-harness run --list` applies).
 */
function recipeReadiness(
  documents: ReadonlyMap<string, ResolvedLibraryRecipe>,
  resolution: RecipeLibraryResolution,
  manifest: RecipeActionManifestDocument,
): Map<string, { problems: DiscoveryProblem[] }> {
  const externalRecipeIds = new Set(resolution.recipes.keys());
  const own = new Map<string, DiscoveryProblem[]>();
  for (const recipe of documents.values()) {
    const validation = validateRecipeWithManifest(recipe.document, manifest, {
      externalRecipeIds,
    });
    own.set(
      recipe.ref,
      validation.findings
        .filter((finding) => finding.severity === 'error')
        .map((finding) => ({ code: finding.code, message: finding.message, path: finding.path })),
    );
  }
  const readiness = new Map<string, { problems: DiscoveryProblem[] }>();
  for (const recipe of documents.values()) {
    const problems = [...own.get(recipe.ref)!];
    try {
      const dependencies = resolveRecipeDependencies({
        rootRef: recipe.ref,
        root: recipe.document,
        rootSource: recipe.provenance,
        recipes: resolution.recipes,
      });
      for (const ref of [...dependencies.recipes.keys()].sort()) {
        const dependency = resolution.recipes.get(ref)!;
        const target = dependency.aliasFor ?? ref;
        if ((own.get(target) ?? []).length > 0)
          problems.push({
            code: 'RECIPE_DEPENDENCY_NOT_RUNNABLE',
            message: `Called recipe ${ref} does not validate in this view.`,
          });
      }
    } catch (error) {
      if (!(error instanceof RecipeResolutionError)) throw error;
      problems.push({ code: error.code, message: error.message });
    }
    readiness.set(recipe.ref, { problems });
  }
  return readiness;
}

/** Resolve a recipe by ref (precedence) or by namespaced id `<library>.<ref>`. */
export async function findRecipe(
  index: RecipeDiscoveryIndex,
  name: string,
): Promise<{ recipe: ResolvedLibraryRecipe; resolvedBy: 'ref' | 'id' } | undefined> {
  const byRef = index.documents.get(name);
  if (byRef) return { recipe: byRef, resolvedBy: 'ref' };
  for (const library of index.libraries) {
    const prefix = `${library.info.name}.`;
    if (!name.startsWith(prefix)) continue;
    const ref = name.slice(prefix.length);
    const own = await loadRecipeLibraries(
      [library.source],
      index.platform ? { adapter: index.platform } : {},
    );
    const recipe = own.recipes.get(ref);
    if (recipe && !recipe.aliasFor) return { recipe, resolvedBy: 'id' };
  }
  return undefined;
}

/** Closest known names, for not-found guidance. */
export function suggestNames(name: string, candidates: Iterable<string>, limit = 3): string[] {
  const needle = name.toLowerCase();
  return [...candidates]
    .map((candidate) => {
      const lower = candidate.toLowerCase();
      const segment = lower.split('.').pop() ?? lower;
      const distance = Math.min(levenshtein(needle, lower), levenshtein(needle, segment));
      const contains = lower.includes(needle) || needle.includes(segment);
      return { candidate, score: contains ? distance - 100 : distance };
    })
    .filter(({ score }) => score <= Math.max(1, Math.floor(needle.length / 3)))
    .sort(
      (left, right) => left.score - right.score || left.candidate.localeCompare(right.candidate),
    )
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

export function levenshtein(left: string, right: string): number {
  const prior = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        prior[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        prior[rightIndex]! + 1,
        substitution,
      );
    }
    for (let index = 0; index < current.length; index += 1) prior[index] = current[index]!;
  }
  return prior[right.length]!;
}
