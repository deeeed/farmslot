import { type Command } from 'commander';

import {
  RecipeResolutionError,
  RecipeTrustError,
  type ResolvedLibraryRecipe,
} from '@farmslot/recipe-harness';
import { parseRecipeParamAssignments } from '@farmslot/recipe-harness/cli/support';

import { actionCallers, explainRecipe, recipeCallers, recipeComposition } from './composition.js';
import { DiscoveryError } from './discovery-error.js';
import {
  buildDiscoveryIndex,
  findRecipe,
  type IndexedAction,
  libraryInfos,
  type RecipeDiscoveryIndex,
  recipeSummary,
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
}

export function registerDiscoveryCommands(
  program: Command,
  context: DiscoveryCommandContext,
): void {
  const index = (options: ViewOptions) =>
    buildDiscoveryIndex({
      libraries: options.library,
      ...(options.platform ? { platform: options.platform } : {}),
      ...(context.handlers ? { handlers: context.handlers } : {}),
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
        const target = await resolveTarget(view, name, options.kind, context.commandName);
        const envelope: DescribeEnvelope = {
          ...ok('describe'),
          platform: view.platform,
          libraries: libraryInfos(view),
          kind: target.kind,
          ...(target.kind === 'recipe'
            ? { recipe: describeRecipe(view, target, context.commandName) }
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
    .argument('<recipe>', 'Recipe ref or <library>.<ref>')
    .option('--param <key=value>', 'Root recipe parameter (repeatable)', collect, [] as string[])
    .action(
      handle('explain', async (name: string, options: ViewOptions & { param: string[] }) => {
        const view = await index(options);
        const target = await resolveTarget(view, name, 'recipe', context.commandName);
        if (target.kind !== 'recipe') throw new Error('unreachable: explain resolves recipes only');
        const envelope: ExplainEnvelope = {
          ...ok('explain'),
          libraries: libraryInfos(view),
          ...explainRecipe(view, target.recipe, parseRecipeParamAssignments(options.param)),
        };
        print(options, envelope, () => renderExplain(envelope));
      }),
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
          results: searchIndex(view, query),
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
        const target = await resolveTarget(view, name, options.kind, context.commandName);
        const envelope =
          target.kind === 'recipe'
            ? recipeTemplate(view, target.recipe, context.commandName)
            : actionTemplate(view, target.action, context.commandName);
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
            console.log(completionScript(context.commandName, shell));
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
                : [...(await index(options)).recipes.keys()];
          const envelope: CompletionsEnvelope = { ...ok('completions'), kind, candidates };
          print(options, envelope, () => candidates);
        },
      ),
    );
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

type Target =
  | { kind: 'recipe'; recipe: ResolvedLibraryRecipe; resolvedBy: 'ref' | 'id' }
  | { kind: 'action'; action: IndexedAction };

async function resolveTarget(
  view: RecipeDiscoveryIndex,
  name: string,
  kind: string | undefined,
  commandName: string,
): Promise<Target> {
  if (kind !== undefined && kind !== 'recipe' && kind !== 'action')
    throw new DiscoveryError(
      'DISCOVERY_USAGE',
      `--kind must be recipe or action.`,
      `--kind recipe`,
    );
  const recipe = kind === 'action' ? undefined : await findRecipe(view, name);
  const action = kind === 'recipe' ? undefined : view.actions.get(name);
  if (recipe && action)
    throw new DiscoveryError(
      'DISCOVERY_NAME_AMBIGUOUS',
      `${name} is both a recipe and an action.`,
      `add --kind recipe or --kind action`,
    );
  if (recipe) return { kind: 'recipe', recipe: recipe.recipe, resolvedBy: recipe.resolvedBy };
  if (action) return { kind: 'action', action };
  if (kind !== 'action' && view.recipes.get(name)?.runnable === null) {
    const platforms = view.recipes.get(name)!.variants.map((variant) => variant.platform);
    throw new DiscoveryError(
      'RECIPE_PLATFORM_REQUIRED',
      `Recipe ${name} only exists as platform variants: ${platforms.join(', ')}.`,
      `${commandName} explain ${name} --platform ${platforms[0]}`,
    );
  }
  const candidates = [
    ...(kind === 'action' ? [] : view.recipes.keys()),
    ...(kind === 'recipe' ? [] : view.actions.keys()),
  ];
  const suggestions = suggestNames(name, candidates);
  throw new DiscoveryError(
    'DISCOVERY_NOT_FOUND',
    `No ${kind ?? 'recipe or action'} named ${name}${view.platform ? ` for platform ${view.platform}` : ''}.`,
    suggestions.length > 0
      ? `did you mean ${suggestions.join(', ')}? Inspect: ${commandName} search ${shellQuote(name)}`
      : `${commandName} search ${shellQuote(name)}`,
  );
}

function recipeTemplate(
  view: RecipeDiscoveryIndex,
  recipe: ResolvedLibraryRecipe,
  commandName: string,
): TemplateEnvelope {
  const summary = recipeSummary(recipe);
  const node = recipeTemplateNode(summary.ref, summary.parameters);
  return {
    ...ok('template'),
    platform: view.platform,
    kind: 'recipe',
    name: recipe.ref,
    node,
    recipe: recipeSkeleton(`Calls ${recipe.ref}`, node),
    runCommand: runCommand(commandName, recipe.ref, summary.parameters, view.platform),
  };
}

function actionTemplate(
  view: RecipeDiscoveryIndex,
  action: IndexedAction,
  commandName: string,
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
    runCommand: runCommand(commandName, file, [], view.platform),
  };
}

function describeRecipe(
  view: RecipeDiscoveryIndex,
  target: Extract<Target, { kind: 'recipe' }>,
  commandName: string,
): DiscoveryRecipeDetail {
  const recipe = target.recipe;
  // An id that names the precedence winner describes the same entry as its ref.
  const winner = view.recipes.get(recipe.ref);
  const indexed =
    winner?.source === recipe.source && winner.file === recipe.file ? winner : undefined;
  const summary = recipeSummary(recipe);
  const composition = recipeComposition(recipe.document, view.resolution.recipes);
  return {
    ...summary,
    variants: indexed?.variants ?? [],
    runnable: indexed?.runnable ?? null,
    problems: indexed?.problems ?? [],
    path: recipe.path,
    resolvedBy: target.resolvedBy,
    proofTargets: recipe.document.proofTargets ?? null,
    ...composition,
    callers: recipeCallers(view, recipe.ref),
    runCommand: runCommand(commandName, recipe.ref, summary.parameters, view.platform),
  };
}

function describeAction(view: RecipeDiscoveryIndex, action: IndexedAction): DiscoveryActionDetail {
  return { ...action, callers: actionCallers(view, action.name) };
}

function summarizeAction(action: IndexedAction) {
  const { schema: _schema, examples: _examples, ...summary } = action;
  return summary;
}

/** `run` still selects platform variants with --adapter and needs an explicit action manifest. */
function runCommand(
  commandName: string,
  recipe: string,
  parameters: readonly DiscoveryParameter[],
  platform: string | null,
): string {
  return [
    commandName,
    'run',
    shellQuote(recipe),
    ...requiredAssignments(parameters),
    '--action-manifest',
    '<manifest.json>',
    '--artifacts-dir',
    '<dir>',
    ...(platform ? ['--adapter', platform] : []),
  ].join(' ');
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

/** Wrap an action so known failures print a stable error envelope instead of a stack. */
function handle<A extends unknown[]>(
  command: DiscoveryCommand,
  action: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await action(...args);
    } catch (error) {
      if (
        !(error instanceof DiscoveryError) &&
        !(error instanceof RecipeResolutionError) &&
        !(error instanceof RecipeTrustError)
      )
        throw error;
      const options = args.find(
        (arg): arg is { json?: boolean } =>
          typeof arg === 'object' && arg !== null && !Array.isArray(arg),
      );
      const envelope: DiscoveryErrorEnvelope = {
        schemaVersion: DISCOVERY_SCHEMA_VERSION,
        command,
        status: 'fail',
        error: { code: error.code, message: error.message, userAction: error.userAction },
      };
      if (options?.json) console.log(JSON.stringify(envelope, null, 2));
      else console.error(`Error [${error.code}]: ${error.message}\nNext: ${error.userAction}`);
      process.exitCode =
        error instanceof DiscoveryError && error.code !== 'ACTION_MANIFEST_INVALID' ? 2 : 1;
    }
  };
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
