import {
  applyRecipeParamDefaults,
  isRecord,
  normalizeRecipeRef,
  type RecipeExecutionCapability,
  validateRecipeParams,
} from '@farmslot/protocol';
import {
  extractWorkflowGraph,
  RecipeResolutionError,
  type ResolvedLibraryRecipe,
  resolveRecipeDependencies,
  resolveRecipeValue,
} from '@farmslot/recipe-harness';

import type { RecipeDiscoveryIndex } from './discovery-index.js';
import type {
  DiscoveryProblem,
  ExplainCallNode,
  ExplainEnvelope,
  ExplainParameter,
  ExplainRecipeNode,
  ExplainRequiredAction,
} from './types.js';

const MAX_EXPLAIN_DEPTH = 16;

export interface RecipeComposition {
  actions: string[];
  nestedRecipes: string[];
  unresolvedRecipes: string[];
}

/** Actions and recipe calls reachable from a recipe's workflow nodes, following resolved calls. */
export function recipeComposition(
  document: Record<string, unknown>,
  recipes: ReadonlyMap<string, { document: Record<string, unknown> }>,
): RecipeComposition {
  const actions = new Set<string>();
  const nested = new Set<string>();
  const unresolved = new Set<string>();
  const visited = new Set<string>();
  const visit = (recipe: Record<string, unknown>): void => {
    for (const node of workflowNodes(recipe)) {
      if (typeof node.action !== 'string') continue;
      if (node.action !== 'call') {
        actions.add(node.action);
        continue;
      }
      if (typeof node.ref !== 'string') continue;
      nested.add(node.ref);
      const dependency = recipes.get(node.ref);
      if (!dependency) {
        unresolved.add(node.ref);
        continue;
      }
      if (visited.has(node.ref)) continue;
      visited.add(node.ref);
      visit(dependency.document);
    }
  };
  visit(document);
  return {
    actions: [...actions].sort(),
    nestedRecipes: [...nested].sort(),
    unresolvedRecipes: [...unresolved].sort(),
  };
}

function workflowNodes(document: Record<string, unknown>): Record<string, unknown>[] {
  const workflow = isRecord(document.workflow) ? document.workflow : {};
  const nodes = isRecord(workflow.nodes) ? workflow.nodes : {};
  return Object.values(nodes).filter(isRecord);
}

/** Recipes in the view whose workflow calls `ref` directly. */
export function recipeCallers(index: RecipeDiscoveryIndex, ref: string): string[] {
  return [...index.documents.values()]
    .filter((recipe) =>
      workflowNodes(recipe.document).some(
        (node) => node.action === 'call' && typeof node.ref === 'string' && node.ref === ref,
      ),
    )
    .map((recipe) => recipe.ref)
    .sort();
}

/** Recipes in the view whose workflow uses `action` directly. */
export function actionCallers(index: RecipeDiscoveryIndex, action: string): string[] {
  return [...index.documents.values()]
    .filter((recipe) => workflowNodes(recipe.document).some((node) => node.action === action))
    .map((recipe) => recipe.ref)
    .sort();
}

type ExplainResult = Omit<ExplainEnvelope, 'schemaVersion' | 'command' | 'status' | 'libraries'>;

/** Resolve the static composition graph of a recipe for the given root parameters. */
export function explainRecipe(
  index: RecipeDiscoveryIndex,
  root: ResolvedLibraryRecipe,
  input: Record<string, unknown>,
): ExplainResult {
  const usage = new Map<string, string[]>();
  const missingParameters: Array<{ recipe: string; name: string }> = [];
  const missingRecipes: Array<{ from: string; ref: string }> = [];
  const problems: DiscoveryProblem[] = [];

  const visit = (
    recipe: ResolvedLibraryRecipe,
    callerParams: Record<string, unknown>,
    templates: Record<string, string>,
    stack: string[],
  ): ExplainRecipeNode => {
    const { parameters, values } = explainParameters(recipe, callerParams, templates);
    // The same parameter check `run` applies; nested values may still hold caller templates.
    const validation = validateRecipeParams(values, recipe.document.paramsSchema, {
      allowTemplates: stack.length > 1,
    });
    for (const finding of validation.findings) {
      if (finding.severity !== 'error' || finding.code === 'recipe.missing_param') continue;
      problems.push({
        code: 'RECIPE_PARAMS_INVALID',
        message: `Recipe ${recipe.ref}: ${finding.message}`,
        path: finding.path,
      });
    }
    for (const parameter of parameters) {
      if (parameter.from === 'missing')
        missingParameters.push({ recipe: recipe.ref, name: parameter.name });
    }
    const graph = extractWorkflowGraph(recipe.document);
    const teardown = graph.teardownEntry
      ? reachable(graph.nodes, graph.teardownEntry)
      : new Set<string>();
    const nodes: ExplainRecipeNode['nodes'] = [];
    for (const [nodeId, node] of Object.entries(graph.nodes)) {
      const phase = graph.mainNodeIds.has(nodeId)
        ? 'main'
        : teardown.has(nodeId)
          ? 'teardown'
          : 'unreachable';
      if (typeof node.action !== 'string') continue;
      if (node.action !== 'call') {
        usage.set(node.action, [...(usage.get(node.action) ?? []), `${recipe.ref}#${nodeId}`]);
        nodes.push({ nodeId, kind: 'action', action: node.action, phase });
        continue;
      }
      const rawRef = typeof node.ref === 'string' ? node.ref : '';
      const ref = normalizeRecipeRef(String(safeResolve(rawRef, values)));
      const call: ExplainCallNode = { nodeId, kind: 'call', ref, phase, recipe: null };
      nodes.push(call);
      const dependency = index.resolution.recipes.get(ref);
      if (!dependency) {
        missingRecipes.push({ from: `${recipe.ref}#${nodeId}`, ref });
        continue;
      }
      if (stack.includes(ref) || stack.length >= MAX_EXPLAIN_DEPTH) {
        problems.push({
          code: stack.includes(ref) ? 'RECIPE_CALL_CYCLE' : 'RECIPE_CALL_DEPTH_EXCEEDED',
          message: `Call ${recipe.ref}#${nodeId} -> ${ref} is not expanded: ${[...stack, ref].join(' -> ')}.`,
        });
        continue;
      }
      const rawParams = isRecord(node.params) ? node.params : {};
      const childTemplates = Object.fromEntries(
        Object.entries(rawParams).flatMap(([key, value]) =>
          typeof value === 'string' && value.includes('{{') ? [[key, value]] : [],
        ),
      );
      const childParams = Object.fromEntries(
        Object.entries(rawParams).map(([key, value]) => [key, safeResolve(value, values)]),
      );
      call.recipe = visit(dependency, childParams, childTemplates, [...stack, ref]);
    }
    return {
      ref: recipe.ref,
      source: recipe.source,
      file: recipe.file,
      variant: recipe.adapter ?? null,
      parameters,
      nodes,
    };
  };

  const tree = visit(root, input, {}, [root.ref]);
  const requiredActions: ExplainRequiredAction[] = [...usage.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, usedBy]) => {
      const action = index.actions.get(name);
      const declared = Object.hasOwn(index.manifest.actions, name) || action?.handler === 'runner';
      return {
        name,
        declared,
        source: declared ? (action?.source ?? null) : null,
        handler: action?.handler ?? null,
        capabilities: action?.capabilities ?? [],
        usedBy,
      };
    });
  const capabilities = [
    ...new Set(requiredActions.flatMap((action) => action.capabilities)),
  ].sort() as RecipeExecutionCapability[];

  let resolution: ExplainResult['resolution'] = null;
  try {
    resolution = resolveRecipeDependencies({
      rootRef: root.ref,
      root: root.document,
      rootSource: root.provenance,
      recipes: index.resolution.recipes,
    }).document;
  } catch (error) {
    if (!(error instanceof RecipeResolutionError)) throw error;
    problems.push({ code: error.code, message: error.message });
  }

  return {
    platform: index.platform,
    recipe: tree,
    requiredActions,
    capabilities,
    missing: {
      parameters: missingParameters,
      recipes: missingRecipes,
      actions: requiredActions
        .filter((action) => !action.declared)
        .map((action) => ({ name: action.name, usedBy: action.usedBy })),
      handlers: requiredActions
        .filter((action) => action.declared && action.handler === 'adapter')
        .map((action) => action.name),
      problems,
    },
    resolution,
  };
}

function explainParameters(
  recipe: ResolvedLibraryRecipe,
  input: Record<string, unknown>,
  templates: Record<string, string>,
): { parameters: ExplainParameter[]; values: Record<string, unknown> } {
  const schema = recipe.document.paramsSchema;
  const values = applyRecipeParamDefaults(input, schema);
  const properties =
    isRecord(schema) && isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  const required = new Set(
    isRecord(schema) && Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );
  const names = [...new Set([...properties, ...Object.keys(input)])];
  const parameters = names.map((name): ExplainParameter => {
    const template = templates[name] ? { template: templates[name] } : {};
    if (Object.hasOwn(input, name)) return { name, value: input[name], from: 'input', ...template };
    if (Object.hasOwn(values, name)) return { name, value: values[name], from: 'default' };
    return required.has(name) ? { name, from: 'missing' } : { name, from: 'default' };
  });
  return { parameters, values };
}

/** Substitute `{{params.*}}` where the value is known; keep the template otherwise. */
function safeResolve(value: unknown, params: Record<string, unknown>): unknown {
  try {
    return resolveRecipeValue(value, params);
  } catch (error) {
    // A parameter the caller did not supply stays a visible template; explain reports it as missing.
    if (error instanceof RecipeResolutionError) return value;
    throw error;
  }
}

function reachable(nodes: Record<string, Record<string, unknown>>, entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const node = nodes[nodeId];
    if (seen.has(nodeId) || !node) continue;
    seen.add(nodeId);
    for (const next of [
      node.next,
      node.default,
      ...(isRecord(node.cases) ? Object.values(node.cases) : []),
    ]) {
      if (typeof next === 'string') queue.push(next);
    }
  }
  return seen;
}
