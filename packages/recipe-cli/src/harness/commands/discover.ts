// Discovery: `actions` (the action catalog, search, categories and the
// cross-adapter matrix), `call --list` (the actions `call` accepts), `run --list`
// (the complete recipes `run` accepts) and `run <recipe> --describe`. Every view
// reads the host's catalog over the same library sources and renders actions
// with one catalog renderer and one detail renderer.

import fs from 'node:fs';
import path from 'node:path';

import { getRecipeActionManifestActionNames } from '@farmslot/protocol';
import type { RecipeLibrarySource } from '@farmslot/recipe-runner';

import {
  type ActionMatrixRow,
  findRelatedActions,
  fuzzyResolveActions,
  resolveActionCapabilityRefusal,
  searchActions,
  shortActionNames,
  summarizeActionCategories,
} from '../../action-catalog.js';
import { harnessAdapters } from '../adapters.js';
import {
  actionLibraryContextArgs,
  type DescribedAction,
  describeManifestActions,
  type RecipeCatalog,
  renderActionDetail,
  resolveActionCapabilityMatrix,
} from '../catalog.js';
import { color } from '../cli-color.js';
import { harnessContextField } from '../context-state.js';
import { harnessHost, invokedHostCommand } from '../host.js';
import {
  type CliOptions,
  isRecord,
  optionFlag,
  optionString,
  optionStrings,
  type ParsedArgs,
  resolveAdapter,
  shellQuoteArg,
} from '../parse-args.js';
import {
  describeRunnableRecipe,
  listRunnableRecipes,
  resolveCommandManifest,
  resolveLibrarySources,
} from '../recipe-library.js';
import { EXIT } from '../shared.js';

/** `actions`: the adapter's action catalog, one action, a search, its categories, or the matrix. */
export async function handleActions(
  { options, positional }: ParsedArgs,
  commandOptions: { catalog: RecipeCatalog; librarySources?: RecipeLibrarySource[] },
): Promise<number> {
  const { catalog } = commandOptions;
  const host = harnessHost().name;
  const librarySources =
    commandOptions.librarySources ??
    (await resolveLibrarySources(catalog, optionStrings(options, 'library')));
  const json = optionFlag(options, 'json');
  const action = optionString(options, 'action');
  const query = positional[0]?.trim();
  const category = optionString(options, 'category')?.toLowerCase();
  if (optionFlag(options, 'matrix')) {
    return handleActionMatrix(catalog, options, { json, action, query, category, librarySources });
  }

  const { adapter, target } = resolveAdapter(options);
  const actionManifestOverride = optionString(options, 'actionManifest');
  const { manifest, actions: all } = await adapterActions(
    catalog,
    adapter,
    options,
    librarySources,
  );
  if (optionFlag(options, 'raw')) {
    console.log(JSON.stringify(manifest, null, 2));
    return EXIT.ok;
  }
  const categoriesOnly = optionFlag(options, 'categories');
  const categories = summarizeActionCategories(all);
  if (categoriesOnly && (action || category)) {
    return actionsError(
      json,
      { adapter },
      {
        code: 'ACTION_FILTER_CONFLICT',
        message: '--categories cannot be combined with --action or --category.',
        userAction: `${host} actions --adapter ${adapter} --categories`,
      },
    );
  }
  if (categoriesOnly) {
    if (json)
      console.log(
        JSON.stringify(
          { schemaVersion: 1, command: 'actions', ...harnessContextField(), adapter, categories },
          null,
          2,
        ),
      );
    else for (const entry of categories) console.log(`${entry.name} (${entry.count})`);
    return EXIT.ok;
  }
  const categoryActions = category ? all.filter((entry) => entry.category === category) : all;
  if (category && categoryActions.length === 0) {
    return actionsError(
      json,
      { adapter, category, availableCategories: categories },
      {
        code: 'ACTION_CATEGORY_UNKNOWN',
        message: `no action category matches "${category}" for the ${adapter} adapter.`,
        userAction: `${host} actions --adapter ${adapter} --categories`,
      },
    );
  }
  // --action fuzzy-resolves like `call`: exact full name → exact final segment →
  // final-segment substring. An unknown name teaches the vocabulary instead of
  // throwing a bare "not found".
  const actions = action
    ? fuzzyResolveActions(categoryActions, action)
    : query
      ? searchActions(categoryActions, query)
      : categoryActions;
  if (action && actions.length === 0) {
    const refusal = actionManifestOverride
      ? undefined
      : resolveActionCapabilityRefusal(
          action,
          adapter,
          await resolveActionCapabilityMatrix(catalog, librarySources),
        );
    if (refusal) {
      return actionsError(
        json,
        { adapter, action, category },
        {
          code: 'ACTION_CAPABILITY_UNAVAILABLE',
          message: `missing action capability "${refusal.capability}" for the ${adapter} adapter.`,
          capability: refusal.capability,
          satisfyingAdapters: refusal.satisfyingAdapters,
          userAction:
            `Satisfying adapters for "${refusal.capability}": ${refusal.satisfyingAdapters.join(', ')}. ` +
            `Inspect: ${host} actions --matrix --action ${shellQuoteArg(refusal.capability)}` +
            `${actionLibraryContextArgs(catalog, librarySources)} --json`,
        },
      );
    }
    return actionsError(
      json,
      { adapter, action, category },
      {
        code: 'ACTION_UNKNOWN',
        message: `no action matches "${action}" for the ${adapter} adapter.`,
        userAction: `${host} actions --adapter ${adapter}`,
      },
    );
  }
  if (query && actions.length === 0) {
    return actionsError(
      json,
      { adapter, query, category },
      {
        code: 'ACTION_SEARCH_EMPTY',
        message: `no action matches search "${query}" for the ${adapter} adapter.`,
        userAction: `${host} actions --adapter ${adapter} --categories`,
      },
    );
  }
  const detailed = action && actions.length === 1 ? actions[0] : undefined;
  const relatedActions = detailed ? findRelatedActions(all, detailed) : undefined;
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'actions',
          ...harnessContextField(),
          adapter,
          ...(query ? { query } : {}),
          category,
          detail: detailed ? 'full' : 'summary',
          actions: detailed ? actions : actions.map(summarizeDescribedAction),
          ...(relatedActions?.length ? { relatedActions } : {}),
        },
        null,
        2,
      ),
    );
    return EXIT.ok;
  }
  if (detailed) {
    console.log(
      renderActionDetail(
        detailed,
        adapter,
        target,
        invokedHostCommand(),
        all.map(({ name }) => name),
      ),
    );
  } else {
    console.log(
      renderHumanActionCatalog(catalog, actions, {
        title: `actions (${adapter})`,
        guidance: `Inspect: ${host} actions --action <name>  ·  Run: ${host} call <name>`,
      }),
    );
  }
  if (relatedActions?.length)
    console.log(
      `\n${color('label', 'Related:', { stream: process.stdout })} ${relatedActions.join(', ')}`,
    );
  return EXIT.ok;
}

/** The adapter's resolved action manifest and its actions, described. */
async function adapterActions(
  catalog: RecipeCatalog,
  adapter: string,
  options: CliOptions,
  librarySources: RecipeLibrarySource[],
): Promise<{ manifest: unknown; actions: DescribedAction[] }> {
  const { manifest, actionSources } = await resolveCommandManifest(
    catalog,
    adapter,
    options,
    librarySources,
  );
  return { manifest, actions: describeManifestActions(catalog, manifest, actionSources) };
}

/**
 * An `actions` refusal: the JSON envelope (the context keys, then `error` with
 * code, message, any details, and the next step), or the human line. Exit 2.
 */
function actionsError(
  json: boolean,
  context: Record<string, unknown>,
  error: { code: string; message: string; userAction: string } & Record<string, unknown>,
): number {
  const { code, message, userAction, ...details } = error;
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'actions',
          ...harnessContextField(),
          ...context,
          error: { code, message, ...details, userAction },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`✗ ${harnessHost().name} actions: ${message}\n  Next: ${userAction}`);
  }
  return EXIT.usage;
}

async function handleActionMatrix(
  catalog: RecipeCatalog,
  options: CliOptions,
  input: {
    json: boolean;
    action?: string;
    query?: string;
    category?: string;
    librarySources?: RecipeLibrarySource[];
  },
): Promise<number> {
  const inspectCommand = `${harnessHost().name} actions --matrix${actionLibraryContextArgs(catalog, input.librarySources)} --json`;
  const conflicts = [
    optionFlag(options, 'raw') ? '--raw' : undefined,
    optionFlag(options, 'categories') ? '--categories' : undefined,
    optionString(options, 'adapter') ? '--adapter' : undefined,
    optionString(options, 'platform') ? '--platform' : undefined,
    optionString(options, 'actionManifest') ? '--action-manifest' : undefined,
  ].filter((value): value is string => Boolean(value));
  if (conflicts.length > 0) {
    return actionsError(
      input.json,
      { view: 'matrix' },
      {
        code: 'ACTION_MATRIX_CONFLICT',
        message: `--matrix cannot be combined with ${conflicts.join(', ')}.`,
        userAction: inspectCommand,
      },
    );
  }

  const adapters = harnessAdapters().list();
  const matrix = await resolveActionCapabilityMatrix(catalog, input.librarySources);
  const categories = summarizeActionCategories(matrix);
  const categoryActions = input.category
    ? matrix.filter((entry) => entry.category === input.category)
    : matrix;
  if (input.category && categoryActions.length === 0) {
    return actionsError(
      input.json,
      { view: 'matrix', category: input.category, availableCategories: categories },
      {
        code: 'ACTION_CATEGORY_UNKNOWN',
        message: `no action category matches "${input.category}" across the adapter matrix.`,
        userAction: inspectCommand,
      },
    );
  }
  const actions = input.action
    ? fuzzyResolveActions(categoryActions, input.action)
    : input.query
      ? searchActions(categoryActions, input.query)
      : categoryActions;
  if (input.action && actions.length === 0) {
    return actionsError(
      input.json,
      { view: 'matrix', action: input.action, category: input.category },
      {
        code: 'ACTION_UNKNOWN',
        message: `no action capability matches "${input.action}" across ${adapterNames(adapters)}.`,
        userAction: inspectCommand,
      },
    );
  }
  if (input.query && actions.length === 0) {
    return actionsError(
      input.json,
      { view: 'matrix', query: input.query, category: input.category },
      {
        code: 'ACTION_SEARCH_EMPTY',
        message: `no action capability matches search "${input.query}" across ${adapterNames(adapters)}.`,
        userAction: inspectCommand,
      },
    );
  }

  if (input.json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'actions',
          ...harnessContextField(),
          view: 'matrix',
          adapters,
          ...(input.query ? { query: input.query } : {}),
          ...(input.category ? { category: input.category } : {}),
          actions,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderHumanActionMatrix(actions, adapters));
  }
  return EXIT.ok;
}

/** "Mobile, Extension, or Core": the registered adapters, capitalized. */
function adapterNames(adapters: readonly string[]): string {
  const names = adapters.map((id) => `${id.charAt(0).toUpperCase()}${id.slice(1)}`);
  return names.length > 2
    ? `${names.slice(0, -1).join(', ')}, or ${names.at(-1)}`
    : names.join(' or ');
}

/** One row per action, one column per registered adapter, in registration order. */
function renderHumanActionMatrix(actions: ActionMatrixRow[], adapters: readonly string[]): string {
  const out = (style: string, text: string) => color(style, text, { stream: process.stdout });
  const width = Math.max(
    'action capability'.length,
    ...actions.map((action) => action.name.length),
  );
  const cell = (status: string | undefined, width: number) =>
    status === 'available' ? out('accent', 'yes'.padEnd(width)) : out('dim', '—'.padEnd(width));
  return [
    out('bold', 'action capability matrix'),
    out('comment', `Inspect one: ${harnessHost().name} actions --matrix --action <name> --json`),
    `${'action capability'.padEnd(width)}  ${adapters.join('  ')}`,
    ...actions.map(
      (action) =>
        `${action.name.padEnd(width)}  ${adapters.map((id) => cell(action.support[id], id.length)).join('  ')}`,
    ),
  ].join('\n');
}

function summarizeDescribedAction(
  entry: DescribedAction,
): Omit<DescribedAction, 'schema' | 'examples'> {
  const { schema: _schema, examples: _examples, ...summary } = entry;
  return summary;
}

interface HumanActionCatalogOptions {
  title: string;
  guidance: string;
  displayName?: (entry: DescribedAction) => string;
  sort?: 'domain' | 'name' | 'library';
  domainStyles?: ReadonlyMap<string, string>;
  contextLines?: string[];
}

function actionDomain(entry: DescribedAction): string {
  return entry.category.replaceAll('_', '-');
}

/** Actions grouped by origin (or domain, name or library), one line each. */
export function renderHumanActionCatalog(
  catalog: RecipeCatalog,
  actions: DescribedAction[],
  options: HumanActionCatalogOptions,
): string {
  const out = (style: string, text: string) => color(style, text, { stream: process.stdout });
  const groups = new Map<string, DescribedAction[]>();
  for (const entry of actions) {
    const group =
      options.sort === 'name'
        ? ''
        : options.sort === 'library'
          ? `Library: ${entry.source}`
          : options.sort === 'domain'
            ? actionDomain(entry)
            : actionDomainGroup(catalog, entry);
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  const lines = [
    out('bold', options.title),
    ...(options.contextLines ?? []),
    out('comment', options.guidance),
  ];
  if (actions.length === 0) lines.push('No callable actions match.');
  for (const [group, entries] of groups) {
    const groupStyle =
      options.sort === 'domain'
        ? (options.domainStyles?.get(group) ?? 'accent')
        : group === 'official'
          ? 'label'
          : 'accent';
    if (group) lines.push('', `${out(groupStyle, group)} ${out('dim', `(${entries.length})`)}`);
    for (const entry of entries) {
      const fieldNames = humanFieldNames(entry);
      const fields = fieldNames.length ? ` ${out('dim', `fields=${fieldNames.join(',')}`)}` : '';
      const cases = entry.result_cases?.length
        ? ` ${out('dim', `cases=${entry.result_cases.join(',')}`)}`
        : '';
      const description = entry.description ? ` ${out('comment', `— ${entry.description}`)}` : '';
      const source = ` ${out('dim', `[${entry.source}]`)}`;
      const risk = entry.capabilities.length
        ? ` ${out('dim', `risk=${entry.capabilities.join(',')}`)}`
        : '';
      const nameStyle = options.domainStyles?.get(actionDomain(entry)) ?? 'cmd';
      lines.push(
        `  ${out(nameStyle, options.displayName?.(entry) ?? entry.name)}${source}${fields}${cases}${risk}${description}`,
      );
    }
  }
  return lines.join('\n');
}

function humanFieldNames(entry: DescribedAction): string[] {
  const schema = isRecord(entry.schema) ? entry.schema : undefined;
  const properties = schema && isRecord(schema.properties) ? schema.properties : undefined;
  if (!properties) return entry.fields;
  return entry.fields.map((field) => {
    const property = properties[field];
    if (!isRecord(property) || !Array.isArray(property.enum)) return field;
    const values = property.enum.filter(
      (value): value is string | number | boolean =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
    );
    return values.length > 0 ? `${field}=${values.join('|')}` : field;
  });
}

function actionDomainGroup(catalog: RecipeCatalog, entry: DescribedAction): string {
  if (entry.kind === 'official') return 'official';
  const namespace = catalog.bundledLibrary.actionNamespace;
  const domain = entry.name.startsWith(`${namespace}.`)
    ? /^([^.]+)[.]/u.exec(entry.name.slice(namespace.length + 1))?.[1]
    : undefined;
  return domain ? `${namespace} · ${domain}` : 'custom';
}

const recipeDomain = (name: string): string =>
  name.includes('.') ? name.split('.')[0]!.replaceAll('_', '-') : 'general';

function catalogDescription(description: string | undefined): string {
  if (!description) return '';
  const firstSentence = description.match(/^.*?[.!?](?:\s|$)/u)?.[0]?.trim() ?? description;
  return firstSentence.length <= 180 ? firstSentence : `${firstSentence.slice(0, 177).trimEnd()}…`;
}

/**
 * `run --list` (complete recipes `run` accepts) and `call --list` (actions
 * `call` accepts), filtered by `--domain`/`--source` and grouped by `--sort`.
 */
export async function handleListExecutables(
  command: 'call' | 'run',
  options: CliOptions,
  commandOptions: { catalog: RecipeCatalog; librarySources?: RecipeLibrarySource[] },
): Promise<number> {
  const { catalog } = commandOptions;
  const host = harnessHost().name;
  const json = optionFlag(options, 'json');
  const { adapter } = resolveAdapter(options);
  const domainFilter = optionString(options, 'domain')?.replaceAll('_', '-');
  const sourceFilter = optionString(options, 'source');
  const sort = (optionString(options, 'sort') ?? (json ? 'name' : 'domain')) as
    | 'domain'
    | 'name'
    | 'library';
  const groupKey = (entry: { source: string }, domain: string): string =>
    sort === 'library' ? entry.source : sort === 'domain' ? domain : '';
  const select = <T extends { name: string; source: string }>(
    available: T[],
    domainOf: (entry: T) => string,
  ): T[] =>
    available
      .filter(
        (entry) =>
          (!domainFilter || domainOf(entry) === domainFilter) &&
          (!sourceFilter || entry.source === sourceFilter),
      )
      .sort(
        (left, right) =>
          groupKey(left, domainOf(left)).localeCompare(groupKey(right, domainOf(right))) ||
          left.name.localeCompare(right.name),
      );
  const out = (style: string, text: string) => color(style, text, { stream: process.stdout });
  const stylesFor = (domains: string[]): Map<string, string> => {
    const palette = ['label', 'accent', 'ok', 'warn'];
    return new Map(
      [...new Set(domains)]
        .sort()
        .map((domain, index) => [domain, palette[index % palette.length]!]),
    );
  };

  const librarySources =
    commandOptions.librarySources ??
    (await resolveLibrarySources(catalog, optionStrings(options, 'library')));
  const libraryLines = (): string[] => {
    const lines = ['Libraries loaded:'];
    for (const source of librarySources) {
      const name = source.name ?? path.basename(source.root);
      const kind = source.provenance?.kind === 'bundled' ? 'bundled' : 'linked';
      lines.push(`  ${out('bold', name)} ${kind} · ${source.root}`);
    }
    if (domainFilter || sourceFilter) {
      lines.push(
        `Filter: ${[domainFilter && `domain=${domainFilter}`, sourceFilter && `source=${sourceFilter}`].filter(Boolean).join(' ')}`,
      );
    }
    return lines;
  };
  if (command === 'run') {
    const available = await listRunnableRecipes(catalog, adapter, librarySources);
    const recipes = select(available, (recipe) => recipeDomain(recipe.name));
    if (json) {
      console.log(
        JSON.stringify(
          { schemaVersion: 1, command, ...harnessContextField(), action: 'list', adapter, recipes },
          null,
          2,
        ),
      );
      return EXIT.ok;
    }
    const domainStyles = stylesFor(available.map((recipe) => recipeDomain(recipe.name)));
    console.log(out('bold', `runnable recipes (${adapter})`));
    for (const line of libraryLines()) console.log(line);
    console.log(out('comment', `Inspect: ${host} run <recipe> --describe`));
    if (recipes.length === 0) {
      console.log('No runnable recipes match.');
      console.log(`Available domains: ${[...domainStyles.keys()].join(', ') || 'none'}`);
      console.log(
        `Available sources: ${[...new Set(available.map((recipe) => recipe.source))].join(', ') || 'none'}`,
      );
    }
    const groups = new Map<string, typeof recipes>();
    for (const recipe of recipes) {
      const group = groupKey(recipe, recipeDomain(recipe.name));
      groups.set(group, [...(groups.get(group) ?? []), recipe]);
    }
    for (const [group, entries] of groups) {
      if (group) {
        const label = sort === 'library' ? `Library: ${group}` : group;
        console.log(
          `\n${out(sort === 'domain' ? domainStyles.get(group)! : 'bold', label)} ${out('dim', `(${entries.length})`)}`,
        );
      }
      for (const recipe of entries) {
        const style = domainStyles.get(recipeDomain(recipe.name))!;
        const shadowed = recipe.shadows.length > 0 ? ` shadows=${recipe.shadows.join(',')}` : '';
        const variant = recipe.variant ? ` variant=${recipe.variant}` : ' variant=all';
        const summary = catalogDescription(recipe.description);
        console.log(
          `  ${out(style, recipe.name)} ${out('dim', `library=${recipe.source}${variant}${shadowed}`)}`,
        );
        if (summary) console.log(`    ${summary}`);
      }
    }
    return EXIT.ok;
  }

  const { manifest, actions: described } = await adapterActions(
    catalog,
    adapter,
    options,
    librarySources,
  );
  const protocolNames = new Set(getRecipeActionManifestActionNames(manifest));
  const available = described
    .filter((entry) => protocolNames.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const selected = select(available, actionDomain);

  // A final segment is a usable short name only when it names exactly one action, the same rule
  // `call` resolves names with.
  const shortByName = shortActionNames(available.map((entry) => entry.name));
  const actions = selected.map((entry) => ({
    name: entry.name,
    short: shortByName.get(entry.name) ?? null,
    description: entry.description,
    fields: entry.fields,
    source: entry.source,
    sourceTier: entry.sourceTier,
    sourceManifest: entry.sourceManifest,
    shadows: entry.shadows,
  }));

  if (json) {
    console.log(
      JSON.stringify(
        { schemaVersion: 1, command, ...harnessContextField(), action: 'list', adapter, actions },
        null,
        2,
      ),
    );
    return EXIT.ok;
  }

  const contextLines = libraryLines();
  if (selected.length === 0) {
    contextLines.push(
      `Available domains: ${[...new Set(available.map(actionDomain))].sort().join(', ') || 'none'}`,
    );
    contextLines.push(
      `Available sources: ${[...new Set(available.map((entry) => entry.source))].sort().join(', ') || 'none'}`,
    );
  }
  console.log(
    renderHumanActionCatalog(catalog, selected, {
      title: `invocable actions (${adapter})`,
      guidance: `Use: ${host} call <name>  ·  short names shown first where unambiguous`,
      sort,
      domainStyles: stylesFor(available.map(actionDomain)),
      contextLines,
      displayName: (entry) => {
        const short = shortByName.get(entry.name);
        return short
          ? `${short} (${entry.name})`
          : `${entry.name} (full name only — ambiguous short)`;
      },
    }),
  );
  return EXIT.ok;
}

/** `run <recipe> --describe`: the recipe's parameters, composition and the command that runs it. */
export async function handleDescribeRecipe(
  recipeArg: string,
  options: CliOptions,
  commandOptions: { catalog: RecipeCatalog; librarySources?: RecipeLibrarySource[] },
): Promise<number> {
  const { catalog } = commandOptions;
  const host = harnessHost().name;
  const json = optionFlag(options, 'json');
  const { adapter } = resolveAdapter(options);
  const libraryEntries = optionStrings(options, 'library');
  const directRecipePath = path.resolve(recipeArg);
  const librarySources = await resolveLibrarySources(
    catalog,
    libraryEntries,
    fs.existsSync(directRecipePath) ? directRecipePath : undefined,
    commandOptions.librarySources,
  );
  const result = await describeRunnableRecipe(catalog, recipeArg, adapter, librarySources);
  const targetEntry = optionString(options, 'target');
  const replayTarget = targetEntry ? path.resolve(targetEntry) : undefined;
  const contextFlags = [
    `--adapter ${adapter}`,
    ...(libraryEntries?.map((entry) => `--library ${shellQuoteArg(entry)}`) ?? []),
    ...(replayTarget ? [`--target ${shellQuoteArg(replayTarget)}`] : []),
  ].join(' ');
  const discoveryCommand = `${host} run --list ${contextFlags}`;

  if ('notFound' in result || 'unreadable' in result) {
    const code = 'notFound' in result ? 'RECIPE_NOT_FOUND' : 'RECIPE_UNPARSEABLE';
    const message = 'notFound' in result ? result.notFound : result.unreadable;
    const userAction =
      'notFound' in result
        ? discoveryCommand
        : `fix ${shellQuoteArg(recipeArg)}, then retry: ${host} run ${shellQuoteArg(recipeArg)} --describe ${contextFlags}`;
    if (json) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'run',
            ...harnessContextField(),
            action: 'describe',
            status: 'fail',
            error: { code, message, userAction },
            exitCode: EXIT.usage,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`✗ run: ${message}\n  Next: ${userAction}`);
    }
    return EXIT.usage;
  }

  const recipe = result.recipe;
  const parameterArgs = recipe.parameters
    .filter((parameter) => parameter.required && !Object.hasOwn(parameter, 'default'))
    .map((parameter) => `${parameter.name}=${shellQuoteArg(exampleParameterValue(parameter))}`);
  const runCommand = [`${host} run`, shellQuoteArg(recipeArg), ...parameterArgs, contextFlags]
    .filter(Boolean)
    .join(' ');
  const nextCommand = `${runCommand} --plan`;
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'run',
          ...harnessContextField(),
          action: 'describe',
          status: 'pass',
          recipe,
          runCommand,
          nextCommand,
        },
        null,
        2,
      ),
    );
    return EXIT.ok;
  }

  const out = (style: string, text: string) => color(style, text, { stream: process.stdout });
  console.log(out('bold', `recipe ${recipe.name}`));
  if (recipe.title) console.log(`  ${out('label', 'title:')} ${recipe.title}`);
  if (recipe.description) console.log(`  ${out('label', 'description:')} ${recipe.description}`);
  console.log(`  ${out('label', 'adapter:')} ${recipe.adapter}`);
  console.log(`  ${out('label', 'source:')} ${recipe.source} · ${recipe.file}`);
  console.log(`  ${out('label', 'path:')} ${out('path', recipe.path)}`);
  if (recipe.$schema) console.log(`  ${out('label', 'schema:')} ${recipe.$schema}`);
  console.log(`  ${out('label', 'variant:')} ${recipe.variant ?? 'all adapters'}`);
  if (recipe.shadows.length > 0) {
    console.log(`  ${out('label', 'shadows:')} ${recipe.shadows.join(', ')}`);
  }
  if (recipe.parameters.length === 0) {
    console.log(`  ${out('label', 'parameters:')} none`);
  } else {
    console.log(`  ${out('label', `parameters (${recipe.parameters.length})`)}`);
    for (const parameter of recipe.parameters) {
      const required = parameter.required ? ' required' : '';
      const defaultValue = Object.hasOwn(parameter, 'default')
        ? ` default=${compactValue(parameter.default)}`
        : '';
      const choices = parameter.enum ? ` choices=${compactValue(parameter.enum)}` : '';
      const description = parameter.description ? ` — ${parameter.description}` : '';
      console.log(
        `    ${out('cmd', parameter.name)}${parameter.type ? ` (${parameter.type})` : ''}${required}${defaultValue}${choices}${description}`,
      );
    }
  }
  renderComposition('actions', recipe.actions, out);
  renderComposition('called recipes', recipe.nestedRecipes, out);
  if (recipe.unresolvedRecipes.length > 0) {
    renderComposition('unresolved recipes', recipe.unresolvedRecipes, out);
  }
  console.log(`  ${out('comment', `Run: ${runCommand}`)}`);
  console.log(`  ${out('comment', `Next: ${nextCommand}`)}`);
  return EXIT.ok;
}

function exampleParameterValue(parameter: { type?: string; enum?: unknown[] }): string {
  if (parameter.enum && parameter.enum.length > 0)
    return stringifyAssignmentValue(parameter.enum[0]);
  if (parameter.type === 'boolean') return 'false';
  if (parameter.type === 'number' || parameter.type === 'integer') return '0';
  if (parameter.type === 'array') return '[]';
  if (parameter.type === 'object') return '{}';
  return 'value';
}

function stringifyAssignmentValue(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
}

function compactValue(value: unknown): string {
  const rendered = JSON.stringify(value);
  if (rendered === undefined) return String(value);
  return rendered.length <= 180 ? rendered : `${rendered.slice(0, 177)}…`;
}

function renderComposition(
  label: string,
  values: string[],
  out: (style: string, text: string) => string,
): void {
  if (values.length === 0) {
    console.log(`  ${out('label', `${label}:`)} none`);
    return;
  }
  console.log(`  ${out('label', `${label} (${values.length})`)}`);
  for (const value of values) console.log(`    ${out('cmd', value)}`);
}
