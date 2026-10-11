// The recipes `run` accepts: library sources (the host's bundled library
// always among them), recipe-argument resolution, runnable listing and
// descriptions with declared parameters.
import fs from 'node:fs';
import path from 'node:path';

import {
  loadRecipeLibraries,
  type RecipeLibrarySource,
  type ResolvedLibraryRecipe,
  resolveRecipeLibrarySources,
} from '@farmslot/recipe-runner';

import { recipeComposition } from '../composition.js';
import { assessRecipe } from '../discovery-index.js';

import type { RecipeCatalog, ResolvedActionManifest } from './catalog.js';
import { harnessHost } from './host.js';
import { gitLibraryProvenance } from './library-provenance.js';
import {
  type CliOptions,
  isRecord,
  optionString,
  optionStrings,
  usageError,
} from './parse-args.js';

export interface RecipeParameterSummary {
  name: string;
  type?: string;
  required: boolean;
  default?: unknown;
  description?: string;
  enum?: unknown[];
}

export interface RunnableRecipe {
  name: string;
  source: string;
  file: string;
  shadows: string[];
  adapter: string;
  variant: string | null;
  parameters: RecipeParameterSummary[];
  title?: string;
  description?: string;
}

export interface RunnableRecipeDetail extends RunnableRecipe {
  path: string;
  $schema?: string;
  actions: string[];
  nestedRecipes: string[];
  unresolvedRecipes: string[];
}

/**
 * The configured library sources (`--library`, the recipe's own library, the
 * environment) plus the bundled library, each with its provenance. The bundled
 * source name may only point at the bundled root.
 */
export async function resolveLibrarySources(
  catalog: RecipeCatalog,
  libraryEntry: string | readonly string[] | undefined,
  recipePath?: string,
  resolvedSources?: RecipeLibrarySource[],
): Promise<RecipeLibrarySource[]> {
  const bundled = catalog.bundledLibrary;
  const cliEntries =
    typeof libraryEntry === 'string' ? [libraryEntry] : libraryEntry ? [...libraryEntry] : [];
  let sources = resolvedSources
    ? [...resolvedSources]
    : await resolveRecipeLibrarySources({
        ...(cliEntries.length > 0 ? { cliEntries } : {}),
        ...(recipePath ? { recipePath } : {}),
      });
  const canonicalRoot = path.resolve(bundled.root);
  const configuredCanonical = sources.find((source) => source.name === bundled.name);
  if (configuredCanonical && path.resolve(configuredCanonical.root) !== canonicalRoot) {
    throw usageError(
      `Recipe library source ${bundled.name} must resolve to ${canonicalRoot}; got ${path.resolve(configuredCanonical.root)}.`,
    );
  }
  if (!sources.some((source) => path.resolve(source.root) === canonicalRoot)) {
    sources.push({ name: bundled.name, root: canonicalRoot });
  }
  if (resolvedSources && recipePath) {
    const bound = sources;
    sources = (
      await resolveRecipeLibrarySources({
        cliEntries: bound.map((source) =>
          source.name ? `${source.name}=${source.root}` : source.root,
        ),
        env: {},
        recipePath,
      })
    ).map(
      (source) =>
        bound.find(
          (entry) =>
            entry.name === source.name && path.resolve(entry.root) === path.resolve(source.root),
        ) ?? source,
    );
  }
  return Promise.all(
    sources.map(async (source): Promise<RecipeLibrarySource> => {
      const isBundled = source.name === bundled.name;
      const detected =
        isBundled || source.provenance ? {} : await gitLibraryProvenance(source.root);
      return {
        ...source,
        provenance: {
          kind: isBundled ? 'bundled' : 'library',
          trust: isBundled ? 'trusted' : 'unknown',
          name: source.name ?? path.basename(source.root),
          ...detected,
          ...source.provenance,
        },
      };
    }),
  );
}

/**
 * The library sources a command's `--library` names (unless the caller already
 * resolved them), and the adapter's action manifest over them (or its
 * `--action-manifest`).
 */
export async function resolveCommandManifest(
  catalog: RecipeCatalog,
  adapter: string,
  options: CliOptions,
  resolvedSources?: RecipeLibrarySource[],
): Promise<ResolvedActionManifest & { librarySources: RecipeLibrarySource[] }> {
  const librarySources =
    resolvedSources ?? (await resolveLibrarySources(catalog, optionStrings(options, 'library')));
  const resolution = await catalog.resolveActionManifest(
    adapter,
    optionString(options, 'actionManifest'),
    librarySources,
  );
  return { ...resolution, librarySources };
}

function isRecipeFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    // ENOENT/EACCES alike mean "not a usable file"; the caller's fall-through
    // to the library probe / RECIPE_NOT_FOUND teaching IS the recovery.
    return false;
  }
}

/** A recipe file path, or a library recipe name the sources resolve for the adapter. */
export async function resolveRunRecipeArg(
  catalog: RecipeCatalog,
  recipeArg: string,
  adapter: string,
  librarySources?: RecipeLibrarySource[],
): Promise<{ recipeFile: string; ref?: string } | { notFound: string }> {
  const direct = path.resolve(recipeArg);
  if (isRecipeFile(direct)) return { recipeFile: direct };
  const sources = effectiveLibrarySources(catalog, librarySources);
  const resolution = await loadRecipeLibraries(sources, { adapter });
  if (!recipeArg.includes('/') && !recipeArg.includes(path.sep)) {
    const selected = resolution.recipes.get(recipeArg);
    if (selected) return { recipeFile: selected.path, ref: selected.ref };
  }
  const available = [...resolution.recipes.keys()].sort();
  const nonCanonical = sources.filter((source) => source.name !== catalog.bundledLibrary.name);
  const notFoundCore =
    nonCanonical.length > 0
      ? `recipe not found: ${recipeArg} — not a file, and no recipe matched in library sources [${sources.map((source) => source.name ?? path.basename(source.root)).join(', ')}].`
      : `recipe not found: ${recipeArg} — not a file, and no packaged library recipe matched.`;
  const suffix =
    available.length > 0
      ? ` Library recipes for ${adapter}: ${available.join(', ')} (${harnessHost().name} run <name>).`
      : ` The packaged library has no recipes for ${adapter}.`;
  return { notFound: notFoundCore + suffix };
}

function effectiveLibrarySources(
  catalog: RecipeCatalog,
  librarySources?: RecipeLibrarySource[],
): RecipeLibrarySource[] {
  return librarySources && librarySources.length > 0
    ? librarySources
    : [{ name: catalog.bundledLibrary.name, root: path.resolve(catalog.bundledLibrary.root) }];
}

/**
 * Library recipes `run` accepts for this adapter: every precedence winner and
 * qualified alias whose document, and every recipe it calls, validates against
 * the adapter's resolved manifest, so discovery and execution agree.
 */
export async function runnableLibraryRecipes(
  catalog: RecipeCatalog,
  adapter: string,
  sources: RecipeLibrarySource[],
): Promise<ResolvedLibraryRecipe[]> {
  const resolution = await loadRecipeLibraries(sources, { adapter });
  const { manifest } = await catalog.resolveActionManifest(adapter, undefined, sources);
  return [...resolution.recipes.values()].filter(
    (recipe) => assessRecipe({ resolution, manifest }, recipe).length === 0,
  );
}

export async function listRunnableRecipes(
  catalog: RecipeCatalog,
  adapter: string,
  librarySources?: RecipeLibrarySource[],
): Promise<RunnableRecipe[]> {
  return (
    await runnableLibraryRecipes(catalog, adapter, effectiveLibrarySources(catalog, librarySources))
  )
    .map((recipe) => recipeSummary(recipe.ref, adapter, recipe.document, recipe))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function describeRunnableRecipe(
  catalog: RecipeCatalog,
  recipeArg: string,
  adapter: string,
  librarySources?: RecipeLibrarySource[],
): Promise<{ recipe: RunnableRecipeDetail } | { notFound: string } | { unreadable: string }> {
  const resolved = await resolveRunRecipeArg(catalog, recipeArg, adapter, librarySources);
  if ('notFound' in resolved) return resolved;

  let document: unknown;
  try {
    document = JSON.parse(fs.readFileSync(resolved.recipeFile, 'utf8'));
  } catch (error) {
    return {
      unreadable: `could not read recipe ${resolved.recipeFile}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(document)) {
    return {
      unreadable: `recipe ${resolved.recipeFile} must contain a JSON object.`,
    };
  }

  const libraryResolution = await loadRecipeLibraries(
    effectiveLibrarySources(catalog, librarySources),
    { adapter },
  );
  const selected = resolved.ref ? libraryResolution.recipes.get(resolved.ref) : undefined;
  const composition = recipeComposition(document, libraryResolution.recipes);
  const summary = recipeSummary(resolved.ref ?? recipeArg, adapter, document, selected);
  return {
    recipe: {
      ...summary,
      source: selected?.source ?? 'file',
      file: selected?.file ?? resolved.recipeFile,
      path: resolved.recipeFile,
      ...(typeof document.$schema === 'string' ? { $schema: document.$schema } : {}),
      actions: composition.actions,
      nestedRecipes: composition.nestedRecipes,
      unresolvedRecipes: composition.unresolvedRecipes,
    },
  };
}

function recipeSummary(
  ref: string,
  adapter: string,
  document: Record<string, unknown>,
  selected?: {
    source: string;
    file: string;
    adapter?: string;
    shadows: string[];
  },
): RunnableRecipe {
  return {
    name: ref,
    source: selected?.source ?? 'file',
    file: selected?.file ?? '',
    shadows: selected?.shadows ?? [],
    adapter,
    variant: selected?.adapter ?? null,
    parameters: recipeParameters(document),
    ...(typeof document.title === 'string' && document.title.trim()
      ? { title: document.title.trim() }
      : {}),
    ...(typeof document.description === 'string' && document.description.trim()
      ? { description: document.description.trim() }
      : {}),
  };
}

function recipeParameters(document: Record<string, unknown>): RecipeParameterSummary[] {
  if (!isRecord(document.paramsSchema)) return [];
  const schema = document.paramsSchema;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
  if (!isRecord(schema.properties)) return [];
  return Object.entries(schema.properties).map(([name, raw]) => {
    const property = isRecord(raw) ? raw : {};
    return {
      name,
      ...(typeof property.type === 'string' ? { type: property.type } : {}),
      required: required.has(name),
      ...(Object.hasOwn(property, 'default') ? { default: property.default } : {}),
      ...(typeof property.description === 'string' ? { description: property.description } : {}),
      ...(Array.isArray(property.enum) ? { enum: property.enum } : {}),
    };
  });
}
