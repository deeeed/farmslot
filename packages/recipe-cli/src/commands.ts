import { type Command } from 'commander';

import {
  type LibraryRecipeMatch,
  parseRecipeLibraryPath,
  RecipeResolutionError,
  RecipeTrustError,
} from '@farmslot/recipe-runner';
import { parseRecipeParamAssignments } from '@farmslot/recipe-runner/cli/support';

import { actionCallers, explainRecipe, recipeCallers, recipeComposition } from './composition.js';
import { DiscoveryError } from './discovery-error.js';
import {
  assessRecipe,
  buildDiscoveryIndex,
  findRecipe,
  type IndexedAction,
  libraryInfos,
  type RecipeDiscoveryIndex,
  recipeSummary,
  shadowedRecipes,
  suggestNames,
} from './discovery-index.js';
import { PRECEDENCE_RULES } from './libraries.js';
import {
  renderActions,
  renderDescribeAction,
  renderDescribeRecipe,
  renderExplain,
  renderLibraries,
  renderList,
  renderSearch,
} from './render.js';
import { searchIndex } from './search.js';
import {
  actionTemplateNode,
  recipeSkeleton,
  recipeTemplateNode,
  requiredAssignments,
  shellQuote,
} from './template.js';
import {
  type ActionsEnvelope,
  type CompletionsEnvelope,
  type DescribeEnvelope,
  DISCOVERY_SCHEMA_VERSION,
  type DiscoveryActionDetail,
  type DiscoveryCommand,
  type DiscoveryErrorEnvelope,
  type DiscoveryParameter,
  type DiscoveryRecipeDetail,
  type ExplainEnvelope,
  type ListEnvelope,
  type SearchEnvelope,
  type TemplateEnvelope,
} from './types.js';

interface ViewOptions {
  library: string[];
  platform?: string;
  json?: boolean;
}

export interface DiscoveryCommandContext {
  /** Binary name used in printed commands. */
  commandName: string;
  /** Actions with a handler registered by the host CLI. */
  handlers?: readonly string[];
  /** Package versions the host provides for checking each library's `requires`. */
  packageVersions?: Readonly<Record<string, string>>;
}

export function registerDiscoveryCommands(
  program: Command,
  context: DiscoveryCommandContext,
): void {
  const index = (options: ViewOptions) => {
    for (const entry of options.library) {
      try {
        parseRecipeLibraryPath(entry);
      } catch (error) {
        // A malformed --library value is an argument error, reported before any loading.
        if (!(error instanceof RecipeResolutionError)) throw error;
        throw new DiscoveryError('DISCOVERY_USAGE', error.message, error.userAction);
      }
    }
    return buildDiscoveryIndex({
      libraries: options.library,
      ...(options.platform ? { platform: options.platform } : {}),
      ...(context.handlers ? { handlers: context.handlers } : {}),
      ...(context.packageVersions ? { packageVersions: context.packageVersions } : {}),
    });
  };
  const invocation = (options: ViewOptions): Invocation => ({
    commandName: context.commandName,
    libraries: options.library,
    platform: options.platform ?? null,
  });

  viewOptions(program.command('actions'))
    .description('List every action the resolved libraries declare or this CLI handles')
    .option('--source <library>', 'Only actions owned by this library')
    .action(
      handle('actions', async (options: ViewOptions & { source?: string }) => {
        const view = await index(options);
        const actions = [...view.actions.values()]
          .filter((action) => !options.source || action.source === options.source)
          .map(summarizeAction);
        const envelope: ActionsEnvelope = {
          ...ok('actions'),
          platform: view.platform,
          libraries: libraryInfos(view),
          actions,
        };
        print(options, envelope, () => [
          ...renderLibraries(envelope.libraries),
          ...renderActions(actions, view.platform),
        ]);
      }),
    );

  viewOptions(program.command('list'))
    .description('List recipes from the resolved libraries, namespaced, with their variants')
    .option('--source <library>', 'Only recipes resolved from this library')
    .option('--runnable', 'Only recipes that validate against the declared actions in this view')
    .action(
      handle('list', async (options: ViewOptions & { source?: string; runnable?: boolean }) => {
        const view = await index(options);
        const recipes = [...view.recipes.values()].filter(
          (recipe) =>
            (!options.source || recipe.source === options.source) &&
            (!options.runnable || recipe.runnable === true),
        );
        const envelope: ListEnvelope = {
          ...ok('list'),
          platform: view.platform,
          platforms: view.platforms,
          libraries: libraryInfos(view),
          recipes,
        };
        print(options, envelope, () => [
          ...renderLibraries(envelope.libraries, PRECEDENCE_RULES),
          ...renderList(recipes, view.platform, view.platforms),
        ]);
      }),
    );

  viewOptions(program.command('describe'))
    .description('Describe an action or recipe: parameters, examples, outputs, callers, variants')
    .argument('<name>', 'Action name, recipe ref, or <library>.<ref>')
    .option('--kind <kind>', 'recipe or action, when a name is both')
    .action(
      handle('describe', async (name: string, options: ViewOptions & { kind?: string }) => {
        const view = await index(options);
        const target = await resolveTarget(view, name, options.kind, 'describe', context);
        const envelope: DescribeEnvelope = {
          ...ok('describe'),
          platform: view.platform,
          libraries: libraryInfos(view),
          kind: target.kind,
          ...(target.kind === 'recipe'
            ? { recipe: describeRecipe(view, target, invocation(options)) }
            : { action: describeAction(view, target.action) }),
        };
        print(options, envelope, () =>
          envelope.recipe
            ? renderDescribeRecipe(envelope.recipe)
            : renderDescribeAction(envelope.action!),
        );
      }),
    );

  viewOptions(program.command('explain'))
    .description('Show the resolved composition graph of a recipe without a target')
    .argument('<recipe>', 'Recipe ref, platform alias, or <library>.<ref>')
    .option('--param <key=value>', 'Root recipe parameter (repeatable)', collect, [] as string[])
    .option('--strict', 'Exit 3 when anything is missing (parameters, recipes, actions, problems)')
    .action(
      handle(
        'explain',
        async (name: string, options: ViewOptions & { param: string[]; strict?: boolean }) => {
          const view = await index(options);
          const params = parseParams(options.param, context.commandName);
          const target = await resolveTarget(view, name, 'recipe', 'explain', context);
          if (target.kind !== 'recipe')
            throw new Error('unreachable: explain resolves recipes only');
          const envelope: ExplainEnvelope = {
            ...ok('explain'),
            libraries: libraryInfos(view),
            ...explainRecipe(view, target.match.recipe, params),
          };
          print(options, envelope, () => renderExplain(envelope));
          // Without --strict, explain is a report: callers must read missing.* themselves.
          const { parameters, recipes, actions, problems } = envelope.missing;
          if (
            options.strict &&
            parameters.length + recipes.length + actions.length + problems.length > 0
          )
            process.exitCode = 3;
        },
      ),
    );

  viewOptions(program.command('search'))
    .description('Search action and recipe ids, descriptions and parameters')
    .argument('<text...>', 'Search terms; every term must match')
    .action(
      handle('search', async (text: string[], options: ViewOptions) => {
        const view = await index(options);
        const query = text.join(' ');
        const envelope: SearchEnvelope = {
          ...ok('search'),
          platform: view.platform,
          query,
          results: searchIndex(view, query, await shadowedRecipes(view)),
        };
        print(options, envelope, () => renderSearch(envelope.results, query));
      }),
    );

  viewOptions(program.command('template'))
    .description('Print a ready-to-edit workflow node and recipe skeleton for an action or recipe')
    .argument('<name>', 'Action name, recipe ref, or <library>.<ref>')
    .option('--kind <kind>', 'recipe or action, when a name is both')
    .action(
      handle('template', async (name: string, options: ViewOptions & { kind?: string }) => {
        const view = await index(options);
        const target = await resolveTarget(view, name, options.kind, 'template', context);
        const envelope =
          target.kind === 'recipe'
            ? recipeTemplate(view, target, invocation(options))
            : actionTemplate(view, target.action, invocation(options));
        print(options, envelope, () => [
          'Node:',
          ...indent(JSON.stringify(envelope.node, null, 2)),
          'Recipe:',
          ...indent(JSON.stringify(envelope.recipe, null, 2)),
          `Run: ${envelope.runCommand}`,
        ]);
      }),
    );

  viewOptions(program.command('completions'))
    .description('Print a bash/zsh completion script, or completion candidates from the index')
    .argument('[shell]', 'bash or zsh', 'bash')
    .option('--candidates <kind>', 'Print candidates instead: commands, actions or recipes')
    .action(
      handle(
        'completions',
        async (shell: string, options: ViewOptions & { candidates?: string }) => {
          if (!options.candidates) {
            if (shell !== 'bash' && shell !== 'zsh')
              throw new DiscoveryError(
                'DISCOVERY_USAGE',
                `Unsupported shell ${shell}.`,
                `${context.commandName} completions bash`,
              );
            const script = completionScript(context.commandName, shell);
            const envelope: CompletionsEnvelope = {
              ...ok('completions'),
              kind: 'script',
              shell,
              script,
            };
            print(options, envelope, () => [script]);
            return;
          }
          const kind = options.candidates;
          if (kind !== 'commands' && kind !== 'actions' && kind !== 'recipes')
            throw new DiscoveryError(
              'DISCOVERY_USAGE',
              `Unknown candidate kind ${kind}.`,
              `${context.commandName} completions --candidates recipes`,
            );
          const candidates =
            kind === 'commands'
              ? program.commands.map((command) => command.name()).sort()
              : kind === 'actions'
                ? [...(await index(options)).actions.keys()]
                : recipeCandidates(await index(options));
          const envelope: CompletionsEnvelope = { ...ok('completions'), kind, candidates };
          print(options, envelope, () => candidates);
        },
      ),
    );
}

/** Every name `run`, `describe` and `explain` accept: refs, platform aliases and library ids. */
function recipeCandidates(view: RecipeDiscoveryIndex): string[] {
  const names = new Set(view.resolution.recipes.keys());
  for (const recipe of view.recipes.values()) {
    names.add(recipe.ref);
    names.add(recipe.id);
    for (const shadow of recipe.shadows) names.add(`${shadow}.${recipe.ref}`);
  }
  return [...names].sort();
}

function viewOptions(command: Command): Command {
  return command
    .option(
      '--library <entry>',
      'Recipe library as name=path or path (repeatable; earlier wins; replaces a RECIPE_LIBRARY_PATH entry with the same name)',
      collect,
      [] as string[],
    )
    .option('--platform <id>', 'Platform view: platform variants and platform action manifests')
    .option('--json', 'Print the stable JSON envelope');
}

/** Library context generated commands must carry so they resolve the same recipe. */
interface Invocation {
  commandName: string;
  libraries: readonly string[];
  platform: string | null;
}

type Target =
  | { kind: 'recipe'; name: string; match: LibraryRecipeMatch }
  | { kind: 'action'; action: IndexedAction };

async function resolveTarget(
  view: RecipeDiscoveryIndex,
  name: string,
  kind: string | undefined,
  command: DiscoveryCommand,
  context: DiscoveryCommandContext,
): Promise<Target> {
  if (kind !== undefined && kind !== 'recipe' && kind !== 'action')
    throw new DiscoveryError(
      'DISCOVERY_USAGE',
      `--kind must be recipe or action.`,
      `${context.commandName} ${command} ${name} --kind recipe`,
    );
  const recipe = kind === 'action' ? undefined : await findRecipe(view, name);
  const action = kind === 'recipe' ? undefined : view.actions.get(name);
  if (recipe && action)
    throw new DiscoveryError(
      'DISCOVERY_NAME_AMBIGUOUS',
      `${name} is both a recipe and an action.`,
      `${context.commandName} ${command} ${name} --kind recipe`,
    );
  if (recipe) return { kind: 'recipe', name, match: recipe };
  if (action) return { kind: 'action', action };
  if (kind !== 'action' && view.recipes.get(name)?.runnable === null) {
    const platforms = view.recipes.get(name)!.variants.map((variant) => variant.platform);
    throw new DiscoveryError(
      'RECIPE_PLATFORM_REQUIRED',
      `Recipe ${name} only exists as platform variants: ${platforms.join(', ')}.`,
      `${context.commandName} ${command} ${name} --platform ${platforms[0]}`,
    );
  }
  const candidates = [
    ...(kind === 'action' ? [] : recipeCandidates(view)),
    ...(kind === 'recipe' ? [] : view.actions.keys()),
  ];
  const suggestions = suggestNames(name, candidates);
  throw new DiscoveryError(
    'DISCOVERY_NOT_FOUND',
    `No ${kind ?? 'recipe or action'} named ${name}${view.platform ? ` for platform ${view.platform}` : ''}.`,
    suggestions.length > 0
      ? `did you mean ${suggestions.join(', ')}? Inspect: ${context.commandName} search ${shellQuote(name)}`
      : `${context.commandName} search ${shellQuote(name)}`,
  );
}

/** Whether the matched recipe is what its plain ref resolves to in this view. */
function isPrecedenceWinner(view: RecipeDiscoveryIndex, match: LibraryRecipeMatch): boolean {
  return view.resolution.recipes.get(match.recipe.ref)?.path === match.recipe.path;
}

function recipeTemplate(
  view: RecipeDiscoveryIndex,
  target: Extract<Target, { kind: 'recipe' }>,
  invocation: Invocation,
): TemplateEnvelope {
  const { recipe } = target.match;
  if (!isPrecedenceWinner(view, target.match)) {
    // Call nodes resolve refs by precedence, so a node cannot select a shadowed recipe.
    const winner = view.resolution.recipes.get(recipe.ref)!;
    throw new DiscoveryError(
      'RECIPE_SHADOWED',
      `${target.name} is shadowed by library ${winner.source}; a call node with ref ${recipe.ref} would run that recipe instead.`,
      `rank ${recipe.source} first with --library ${recipe.source}=<path>, or rename the recipe`,
    );
  }
  const summary = recipeSummary(recipe);
  const node = recipeTemplateNode(recipe.ref, summary.parameters);
  return {
    ...ok('template'),
    platform: view.platform,
    kind: 'recipe',
    name: recipe.ref,
    node,
    recipe: recipeSkeleton(`Calls ${recipe.ref}`, node),
    runCommand: runCommand(invocation, target.name, summary.parameters),
  };
}

function actionTemplate(
  view: RecipeDiscoveryIndex,
  action: IndexedAction,
  invocation: Invocation,
): TemplateEnvelope {
  const node = actionTemplateNode(action);
  const file = `./${action.name.replaceAll(/[^A-Za-z0-9_-]+/gu, '-')}.recipe.json`;
  return {
    ...ok('template'),
    platform: view.platform,
    kind: 'action',
    name: action.name,
    node,
    recipe: recipeSkeleton(`Runs ${action.name}`, node),
    runCommand: runCommand(invocation, file, []),
  };
}

function describeRecipe(
  view: RecipeDiscoveryIndex,
  target: Extract<Target, { kind: 'recipe' }>,
  invocation: Invocation,
): DiscoveryRecipeDetail {
  const { recipe, resolvedBy } = target.match;
  const summary = recipeSummary(recipe);
  const indexed = view.recipes.get(recipe.aliasFor ?? recipe.ref);
  const problems = assessRecipe(view, recipe);
  return {
    ...summary,
    variants: indexed?.variants ?? [],
    runnable: problems.length === 0,
    problems,
    path: recipe.path,
    resolvedBy,
    proofTargets: recipe.document.proofTargets ?? null,
    ...recipeComposition(recipe.document, view.resolution.recipes),
    callers: recipeCallers(view, recipe.ref),
    runCommand: runCommand(invocation, target.name, summary.parameters),
  };
}

function describeAction(view: RecipeDiscoveryIndex, action: IndexedAction): DiscoveryActionDetail {
  return { ...action, callers: actionCallers(view, action.name) };
}

function summarizeAction(action: IndexedAction) {
  const { schema: _schema, examples: _examples, ...summary } = action;
  return summary;
}

/**
 * A `run` command that resolves the same recipe: the name as given (ref, alias or id), the same
 * --library entries, and the platform. `run` still selects variants with --adapter and needs an
 * explicit action manifest.
 */
function runCommand(
  invocation: Invocation,
  recipe: string,
  parameters: readonly DiscoveryParameter[],
): string {
  return [
    invocation.commandName,
    'run',
    shellQuote(recipe),
    ...requiredAssignments(parameters),
    ...invocation.libraries.flatMap((entry) => ['--library', shellQuote(entry)]),
    '--action-manifest',
    '<manifest.json>',
    '--artifacts-dir',
    '<dir>',
    ...(invocation.platform ? ['--adapter', invocation.platform] : []),
  ].join(' ');
}

function parseParams(assignments: readonly string[], commandName: string): Record<string, unknown> {
  try {
    return parseRecipeParamAssignments(assignments);
  } catch (error) {
    // The parser reports malformed key=value input; that is a usage error, not a crash.
    if (!(error instanceof Error)) throw error;
    throw new DiscoveryError(
      'DISCOVERY_USAGE',
      error.message,
      `${commandName} explain <recipe> --param key=value`,
    );
  }
}

function ok<C extends DiscoveryCommand>(command: C) {
  return { schemaVersion: DISCOVERY_SCHEMA_VERSION, command, status: 'ok' as const };
}

function print(options: { json?: boolean }, envelope: object, text: () => string[]): void {
  console.log(options.json ? JSON.stringify(envelope, null, 2) : text().join('\n'));
}

function indent(text: string): string[] {
  return text.split('\n').map((line) => `  ${line}`);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const USAGE_CODES = new Set<string>([
  'DISCOVERY_USAGE',
  'DISCOVERY_NOT_FOUND',
  'DISCOVERY_NAME_AMBIGUOUS',
  'RECIPE_PLATFORM_REQUIRED',
  'RECIPE_SHADOWED',
  // A malformed --library or RECIPE_LIBRARY_PATH entry is an argument problem.
  'RECIPE_LIBRARY_PATH_INVALID',
]);

/**
 * Wrap an action so every failure prints the error envelope (`--json`) or one readable error.
 * Exit 2 is a usage or lookup problem; exit 1 is an invalid library or an unexpected failure.
 */
function handle<A extends unknown[]>(
  command: DiscoveryCommand,
  action: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await action(...args);
    } catch (error) {
      const options = args.find(
        (arg): arg is { json?: boolean } =>
          typeof arg === 'object' && arg !== null && !Array.isArray(arg),
      );
      const typed =
        error instanceof DiscoveryError ||
        error instanceof RecipeResolutionError ||
        error instanceof RecipeTrustError;
      const failure = typed
        ? { code: error.code, message: error.message, userAction: error.userAction }
        : {
            code: 'DISCOVERY_FAILED',
            message: error instanceof Error ? error.message : String(error),
            userAction: 'fix the library or file named above, then rerun the command',
          };
      // An untyped failure keeps its stack on stderr so the cause is never hidden.
      if (!typed) console.error(error instanceof Error ? error.stack : error);
      printFailure(command, failure, options?.json === true);
      process.exitCode = USAGE_CODES.has(failure.code) ? 2 : 1;
    }
  };
}

export function printFailure(
  command: string | null,
  error: DiscoveryErrorEnvelope['error'],
  json: boolean,
): void {
  const envelope: DiscoveryErrorEnvelope = {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    command,
    status: 'fail',
    error,
  };
  if (json) console.log(JSON.stringify(envelope, null, 2));
  else console.error(`Error [${error.code}]: ${error.message}\nNext: ${error.userAction}`);
}

function completionScript(commandName: string, shell: 'bash' | 'zsh'): string {
  const fn = `_${commandName.replaceAll(/[^A-Za-z0-9]/gu, '_')}_complete`;
  return [
    ...(shell === 'zsh' ? ['autoload -U +X bashcompinit && bashcompinit'] : []),
    `${fn}() {`,
    '  local cur="${COMP_WORDS[COMP_CWORD]}" words=""',
    '  if [ "$COMP_CWORD" -eq 1 ]; then',
    `    words="$(${commandName} completions --candidates commands 2>/dev/null)"`,
    '  else',
    '    case "${COMP_WORDS[1]}" in',
    `      run|explain) words="$(${commandName} completions --candidates recipes 2>/dev/null)" ;;`,
    `      describe|template) words="$(${commandName} completions --candidates recipes 2>/dev/null) $(${commandName} completions --candidates actions 2>/dev/null)" ;;`,
    '    esac',
    '  fi',
    '  COMPREPLY=($(compgen -W "$words" -- "$cur"))',
    '}',
    `complete -F ${fn} ${commandName}`,
  ].join('\n');
}
