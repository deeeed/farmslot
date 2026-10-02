import type {
  DiscoveryAction,
  DiscoveryActionDetail,
  DiscoveryLibrary,
  DiscoveryParameter,
  DiscoveryRecipe,
  DiscoveryRecipeDetail,
  ExplainEnvelope,
  ExplainRecipeNode,
  SearchResult,
} from './types.js';

export function renderLibraries(
  libraries: DiscoveryLibrary[],
  rules?: readonly string[],
): string[] {
  const lines = ['Libraries (precedence order):'];
  if (libraries.length === 0)
    lines.push('  none. Set RECIPE_LIBRARY_PATH=name=path or pass --library.');
  for (const library of libraries) {
    const override = library.overrides ? ` overrides env ${library.overrides}` : '';
    lines.push(
      `  ${library.rank}. ${library.name} (${library.origin}${override}) ${library.root}`,
      `     digest ${library.digest}${library.platforms.length ? ` · platforms ${library.platforms.join(',')}` : ''}`,
    );
    for (const [id, adapter] of Object.entries(library.adapters))
      lines.push(`     adapter ${id} → ${adapter.module} (declared, not loaded)`);
    for (const requirement of library.requires)
      lines.push(
        `     requires ${requirement.package} ${requirement.range}: ${
          requirement.satisfied === null ? 'unchecked' : `ok (${requirement.installed})`
        }`,
      );
  }
  if (rules) lines.push('Precedence:', ...rules.map((rule) => `  - ${rule}`));
  return lines;
}

export function renderList(
  recipes: DiscoveryRecipe[],
  platform: string | null,
  platforms: string[],
): string[] {
  const lines = [
    '',
    `Recipes (${platform ? `platform ${platform}` : `all platforms: ${platforms.join(', ') || 'none'}`}) (${recipes.length})`,
  ];
  for (const recipe of recipes) {
    const state =
      recipe.runnable === null ? 'needs --platform' : recipe.runnable ? 'runnable' : 'incomplete';
    const shadows = recipe.shadows.length ? ` shadows=${recipe.shadows.join(',')}` : '';
    lines.push(`  ${recipe.ref}  [${recipe.source} · ${recipe.file}] ${state}${shadows}`);
    if (recipe.description) lines.push(`    ${firstSentence(recipe.description)}`);
    if (recipe.variants.length > 1 || recipe.variants[0]?.platform)
      lines.push(
        `    variants: ${recipe.variants.map((variant) => variant.platform ?? 'generic').join(', ')}`,
      );
  }
  return lines;
}

export function renderActions(actions: DiscoveryAction[], platform: string | null): string[] {
  const lines = [
    '',
    `Actions (${platform ? `platform ${platform}` : 'all platforms'}) (${actions.length})`,
  ];
  for (const action of actions) {
    const owner = action.source ?? (action.declared ? 'runner' : 'undeclared');
    const fields = action.parameters.map((parameter) => parameter.name);
    const scopes = action.platforms.length ? ` · ${action.platforms.join(',')}` : '';
    lines.push(
      `  ${action.name}  [${owner}${scopes}] handler=${action.handler}${
        fields.length ? ` fields=${fields.join(',')}` : ''
      }${action.capabilities.length ? ` risk=${action.capabilities.join(',')}` : ''}`,
    );
    if (action.description) lines.push(`    ${firstSentence(action.description)}`);
  }
  if (actions.some((action) => !action.declared))
    lines.push(
      'undeclared: this CLI has a handler, but no library manifest declares the action yet.',
    );
  return lines;
}

export function renderDescribeRecipe(recipe: DiscoveryRecipeDetail): string[] {
  return [
    `recipe ${recipe.ref}${recipe.title ? ` — ${recipe.title}` : ''}`,
    ...(recipe.description ? [`  ${recipe.description}`] : []),
    `  id: ${recipe.id} (resolved by ${recipe.resolvedBy})`,
    `  source: ${recipe.source} · ${recipe.file}${recipe.variant ? ` · variant ${recipe.variant}` : ''}`,
    ...(recipe.shadows.length ? [`  shadows: ${recipe.shadows.join(', ')}`] : []),
    `  variants: ${recipe.variants.map((variant) => `${variant.platform ?? 'generic'} (${variant.source})`).join(', ') || 'none'}`,
    `  runnable: ${recipe.runnable === null ? 'pick a --platform' : recipe.runnable ? 'yes' : 'no'}`,
    ...recipe.problems.map((problem) => `    ${problem.code}: ${problem.message}`),
    ...renderParameters(recipe.parameters),
    ...renderNames('actions', recipe.actions),
    ...renderNames('called recipes', recipe.nestedRecipes),
    ...(recipe.unresolvedRecipes.length
      ? renderNames('unresolved recipes', recipe.unresolvedRecipes)
      : []),
    ...renderNames('callers', recipe.callers),
    `  Run: ${recipe.runCommand}`,
  ];
}

export function renderDescribeAction(action: DiscoveryActionDetail): string[] {
  return [
    `action ${action.name} (${action.kind})`,
    ...(action.description ? [`  ${action.description}`] : []),
    `  source: ${action.source ?? 'not declared by any library'}${action.manifest ? ` · ${action.manifest}` : ''}`,
    ...(action.shadows.length ? [`  shadows: ${action.shadows.join(', ')}`] : []),
    `  platforms: ${action.platforms.join(', ') || 'none'}`,
    `  handler: ${action.handler}`,
    `  capabilities: ${action.capabilities.join(', ') || 'none'}`,
    ...renderParameters(action.parameters),
    ...renderNames('result cases', action.resultCases),
    ...(action.examples.length
      ? [
          '  example:',
          ...JSON.stringify(action.examples[0], null, 2)
            .split('\n')
            .map((line) => `    ${line}`),
        ]
      : []),
    ...renderNames('callers', action.callers),
  ];
}

export function renderExplain(envelope: ExplainEnvelope): string[] {
  const lines = [
    `explain ${envelope.recipe.ref}${envelope.platform ? ` (platform ${envelope.platform})` : ''}`,
  ];
  const visit = (recipe: ExplainRecipeNode, depth: number): void => {
    const pad = '  '.repeat(depth);
    lines.push(
      `${pad}${recipe.ref} [${recipe.source} · ${recipe.file}${recipe.variant ? ` · ${recipe.variant}` : ''}]`,
    );
    for (const parameter of recipe.parameters) {
      const value =
        parameter.from === 'missing' ? 'MISSING' : (JSON.stringify(parameter.value) ?? 'undefined');
      const template = parameter.template ? ` ← ${parameter.template}` : '';
      lines.push(`${pad}  param ${parameter.name} = ${value} (${parameter.from}${template})`);
    }
    for (const node of recipe.nodes) {
      const phase = node.phase === 'main' ? '' : ` (${node.phase})`;
      if (node.kind === 'action') {
        if (node.action !== 'end') lines.push(`${pad}  #${node.nodeId} ${node.action}${phase}`);
        continue;
      }
      lines.push(
        `${pad}  #${node.nodeId} call ${node.ref}${phase}${node.recipe ? '' : ' UNRESOLVED'}`,
      );
      if (node.recipe) visit(node.recipe, depth + 2);
    }
  };
  visit(envelope.recipe, 1);
  lines.push(`Required actions (${envelope.requiredActions.length}):`);
  for (const action of envelope.requiredActions) {
    lines.push(
      `  ${action.name} ${action.declared ? `[${action.source ?? 'runner'}] handler=${action.handler}` : 'NOT DECLARED'}${
        action.capabilities.length ? ` risk=${action.capabilities.join(',')}` : ''
      }`,
    );
  }
  lines.push(`Capabilities: ${envelope.capabilities.join(', ') || 'none'}`);
  const missing = envelope.missing;
  const gaps = [
    ...missing.parameters.map((entry) => `parameter ${entry.recipe}.${entry.name}`),
    ...missing.recipes.map((entry) => `recipe ${entry.ref} (from ${entry.from})`),
    ...missing.actions.map((entry) => `action ${entry.name}`),
    ...missing.problems.map((problem) => `${problem.code}: ${problem.message}`),
  ];
  lines.push(`Missing: ${gaps.length ? '' : 'none'}`, ...gaps.map((gap) => `  ${gap}`));
  if (missing.handlers.length)
    lines.push(`Handled by a platform adapter (not loaded here): ${missing.handlers.join(', ')}`);
  return lines;
}

export function renderSearch(results: SearchResult[], query: string): string[] {
  if (results.length === 0) return [`No action or recipe matches "${query}".`];
  return results.map(
    (result) =>
      `${result.kind.padEnd(6)} ${result.name}  [${result.source ?? 'not declared'}]${
        result.description ? ` — ${firstSentence(result.description)}` : ''
      }`,
  );
}

function renderParameters(parameters: DiscoveryParameter[]): string[] {
  if (parameters.length === 0) return ['  parameters: none'];
  return [
    `  parameters (${parameters.length}):`,
    ...parameters.map((parameter) => {
      const type = parameter.type ? ` (${parameter.type})` : '';
      const required = parameter.required ? ' required' : '';
      const defaultValue = Object.hasOwn(parameter, 'default')
        ? ` default=${JSON.stringify(parameter.default)}`
        : '';
      const choices = parameter.enum ? ` choices=${JSON.stringify(parameter.enum)}` : '';
      const description = parameter.description ? ` — ${parameter.description}` : '';
      return `    ${parameter.name}${type}${required}${defaultValue}${choices}${description}`;
    }),
  ];
}

function renderNames(label: string, names: string[]): string[] {
  if (names.length === 0) return [`  ${label}: none`];
  return [`  ${label} (${names.length}):`, ...names.map((name) => `    ${name}`)];
}

function firstSentence(text: string): string {
  const sentence = /^.*?[.!?](?:\s|$)/u.exec(text)?.[0]?.trim() ?? text;
  return sentence.length <= 160 ? sentence : `${sentence.slice(0, 157).trimEnd()}…`;
}
