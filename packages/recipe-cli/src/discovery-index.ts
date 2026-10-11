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
  findLibraryRecipe,
  type LibraryRecipeMatch,
  loadRecipeLibraries,
  type RecipeLibraryEnv,
  type RecipeLibraryLoadOptions,
  type RecipeLibraryResolution,
  type RecipeLibrarySource,
  type RecipePackageVersions,
  RecipeResolutionError,
  type ResolvedLibraryRecipe,
  resolveRecipeDependencies,
  SHARED_RECIPE_SCOPE,
} from '@farmslot/recipe-runner';

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
  /** Package versions the host provides for checking each library's `requires`. */
  packageVersions?: RecipePackageVersions;
  /** Library loader; defaults to the runner's. Every load an index needs goes through it once. */
  loadLibraries?: typeof loadRecipeLibraries;
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
  /** Load options for this view, shared with `run` resolution. */
  loadOptions: RecipeLibraryLoadOptions;
  /** Memoized loader for one or more of this index's libraries; each set loads once. */
  load: (
    sources: readonly RecipeLibrarySource[],
    adapter: string | null,
  ) => Promise<RecipeLibraryResolution>;
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
  // Vouch only for what the host passes, so a library's `requires` gives discovery and the
  // host's own run the same answer. farmslot-recipe passes @farmslot/recipe-cli itself.
  const packageVersions = options.packageVersions
    ? { packageVersions: options.packageVersions }
    : {};
  const libraries = await resolveDiscoveryLibraries({ ...options, ...packageVersions });
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

  const loadOptions = { ...(platform ? { adapter: platform } : {}), ...packageVersions };
  // Each (libraries, platform) pair loads once per index: the view, the variant scan, id lookups
  // and search all share these.
  const loadLibraries = options.loadLibraries ?? loadRecipeLibraries;
  const loads = new Map<string, Promise<RecipeLibraryResolution>>();
  const load = (selected: readonly RecipeLibrarySource[], adapter: string | null) => {
    const key = `${selected.map((source) => source.name).join('\0')}|${adapter ?? ''}`;
    if (!loads.has(key))
      loads.set(
        key,
        loadLibraries(selected, { ...(adapter ? { adapter } : {}), ...packageVersions }),
      );
    return loads.get(key)!;
  };
  const resolution = await load(sources, platform);
  const documents = new Map([...resolution.recipes].filter(([, recipe]) => !recipe.aliasFor));
  const variants = await recipeVariants(platforms, (adapter) => load(sources, adapter));
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
    loadOptions,
    load,
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
  platforms: readonly string[],
  load: (adapter: string | null) => Promise<RecipeLibraryResolution>,
): Promise<Map<string, RecipeImplementations>> {
  const implementations = new Map<string, RecipeImplementations>();
  const add = (recipe: ResolvedLibraryRecipe, platform: string | null) => {
    const variant = { platform, source: recipe.source, file: recipe.file };
    const existing = implementations.get(recipe.ref);
    if (existing) existing.variants.push(variant);
    else implementations.set(recipe.ref, { variants: [variant], representative: recipe });
  };
  for (const recipe of (await load(null)).recipes.values()) if (!recipe.aliasFor) add(recipe, null);
  for (const platform of platforms) {
    for (const recipe of (await load(platform)).recipes.values()) {
      if (!recipe.aliasFor && recipe.adapter === platform) add(recipe, platform);
    }
  }
  return implementations;
}

export interface IndexedActionDeclaration {
  library: ResolvedDiscoveryLibrary;
  file: string;
}

export async function indexActions(
  libraries: readonly ResolvedDiscoveryLibrary[],
  platform: string | null,
  handlers: ReadonlySet<string>,
): Promise<{
  actions: Map<string, IndexedAction>;
  manifest: RecipeActionManifestDocument;
  declarations: Map<string, IndexedActionDeclaration>;
}> {
  const actions = new Map<string, IndexedAction>();
  const declarations = new Map<string, IndexedActionDeclaration>();
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
          declarations.set(name, { library, file: file.file });
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
    declarations,
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
    id: `${recipe.source}.${recipe.aliasFor ?? recipe.ref}`,
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
 * it calls resolves and validates too. Validity is keyed by resolution entry, so a qualified
 * alias is judged by the document it actually resolves to.
 */
function recipeReadiness(
  documents: ReadonlyMap<string, ResolvedLibraryRecipe>,
  resolution: RecipeLibraryResolution,
  manifest: RecipeActionManifestDocument,
): Map<string, { problems: DiscoveryProblem[] }> {
  const externalRecipeIds = new Set(resolution.recipes.keys());
  const own = new Map<string, DiscoveryProblem[]>();
  for (const [key, recipe] of resolution.recipes) {
    own.set(key, validationProblems(recipe.document, manifest, externalRecipeIds));
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
        if ((own.get(ref) ?? []).length > 0)
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

function validationProblems(
  document: Record<string, unknown>,
  manifest: RecipeActionManifestDocument,
  externalRecipeIds: ReadonlySet<string>,
): DiscoveryProblem[] {
  return validateRecipeWithManifest(document, manifest, { externalRecipeIds })
    .findings.filter((finding) => finding.severity === 'error')
    .map((finding) => ({ code: finding.code, message: finding.message, path: finding.path }));
}

/**
 * What readiness needs: a host can pass a recipe-cli index, or its own single-platform resolution
 * (`loadRecipeLibraries(sources, { adapter })`) with the manifest its runner will execute against.
 */
export interface RecipeReadinessView {
  resolution: RecipeLibraryResolution;
  manifest: RecipeActionManifestDocument;
}

/** Readiness of any one recipe in this view: a precedence winner, a qualified alias, or a shadowed recipe selected by id. */
export function assessRecipe(
  index: RecipeReadinessView,
  recipe: ResolvedLibraryRecipe,
): DiscoveryProblem[] {
  const externalRecipeIds = new Set(index.resolution.recipes.keys());
  const problems = validationProblems(recipe.document, index.manifest, externalRecipeIds);
  try {
    const dependencies = resolveRecipeDependencies({
      rootRef: recipe.ref,
      root: recipe.document,
      rootSource: recipe.provenance,
      recipes: index.resolution.recipes,
    });
    for (const [ref, dependency] of [...dependencies.recipes].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (validationProblems(dependency.document, index.manifest, externalRecipeIds).length > 0)
        problems.push({
          code: 'RECIPE_DEPENDENCY_NOT_RUNNABLE',
          message: `Called recipe ${ref} does not validate in this view.`,
        });
    }
  } catch (error) {
    if (!(error instanceof RecipeResolutionError)) throw error;
    problems.push({ code: error.code, message: error.message });
  }
  return problems;
}

/** Resolve a recipe name exactly as `run` does: ref, platform alias, or `<library>.<ref>` id. */
export function findRecipe(
  index: RecipeDiscoveryIndex,
  name: string,
): Promise<LibraryRecipeMatch | undefined> {
  return findLibraryRecipe(
    name,
    index.libraries.map((library) => library.source),
    index.resolution,
    { ...index.loadOptions, load: (source) => index.load([source], index.platform) },
  );
}

/** Recipes that lower-ranked libraries declare under a ref another library wins. */
export async function shadowedRecipes(
  index: RecipeDiscoveryIndex,
): Promise<ResolvedLibraryRecipe[]> {
  const sources = index.libraries.map((library) => library.source);
  // The all-platform view must also scan each platform, or platform-only shadows are missed.
  const views = index.platform ? [index.platform] : [null, ...index.platforms];
  const records = new Map<string, ResolvedLibraryRecipe>();
  // An id already indexed (for example the generic recipe while a platform variant is shadowed)
  // is searchable through that entry; listing it again would duplicate the result.
  const indexed = new Set([...index.recipes.values()].map((recipe) => recipe.id));
  for (const platform of views) {
    const view = await index.load(sources, platform);
    for (const winner of view.recipes.values()) {
      if (winner.aliasFor) continue;
      for (const shadow of winner.shadows) {
        const id = `${shadow}.${winner.ref}`;
        if (records.has(id) || indexed.has(id)) continue;
        const library = index.libraries.find((entry) => entry.info.name === shadow);
        if (!library) continue;
        const recipe = (await index.load([library.source], platform)).recipes.get(winner.ref);
        if (recipe && !recipe.aliasFor) records.set(id, recipe);
      }
    }
  }
  return [...records.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, recipe]) => recipe);
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
