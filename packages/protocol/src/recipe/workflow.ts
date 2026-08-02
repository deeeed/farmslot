import {
  addFinding,
  createContext,
  finishResult,
  hasOwn,
  isNonEmptyString,
  isRecord,
  type MutableValidationContext,
  OFFICIAL_ACTION_SET,
  type RecipeValidationResult,
  TERMINAL_STATUSES,
} from './common.js';

const NODE_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface WorkflowGraph {
  entry: string;
  nodes: Record<string, Record<string, unknown>>;
  teardown?: string;
}

export interface WorkflowActionEntry {
  nodeId: string;
  action: string;
  node: Record<string, unknown>;
  path: string;
}

const CORE_NODE_FIELDS = new Set(['action', 'intent', 'next', 'cases', 'default', 'proves']);
const CALL_NODE_FIELDS = new Set(['action', 'intent', 'ref', 'params', 'proves', 'next']);

const GENERIC_INTENTS = new Set([
  'executing recipe step',
  'run',
  'setup',
  'ui',
  'wallet',
  'test',
  'step',
  'execute',
  'click',
  'press',
  'wait',
  'screenshot',
  'capture',
  'assert',
  'command',
]);

const IMPLEMENTATION_INTENTS = new Set([
  'selector',
  'test id',
  'testid',
  'test_id',
  'node id',
  'node_id',
  'action',
  'params',
  'payload',
]);

const GENERIC_INTENT_PATTERN = /^(?:do|execute|perform|run) .+ (?:for|in) (?:the )?recipe[.!]?$/u;

const UI_MECHANIC_INTENTS: Record<string, RegExp> = {
  'ui.navigate': /^(?:navigate|route)\b/u,
  'ui.press': /^(?:click|press|tap)\b/u,
  'ui.key_press': /^(?:press|type)\b/u,
  'ui.set_input': /^(?:fill|set|type)\b/u,
  'ui.scroll': /^(?:bring .* into view|scroll)\b/u,
  'ui.wait_for': /^wait\b/u,
  'ui.screenshot': /^(?:capture|take (?:a )?screenshot)\b/u,
  'ui.capture_surface': /^(?:capture|take) (?:the )?(?:full|entire)\b/u,
};

const UI_IMPLEMENTATION_TERMS =
  /\b(?:css|hash|raw (?:app|extension|platform)|route params?|selector|test[_ -]?id)\b/u;

export function normalizeRecipeRef(value: string): string {
  return value.trim();
}

export function isDynamicRecipeRef(value: string): boolean {
  return /\{\{(?:params|outputs)\.[A-Za-z0-9_.-]+\}\}/u.test(value);
}

export function getRecipeActionParams(node: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(node).filter(
      ([field]) =>
        !CORE_NODE_FIELDS.has(field) &&
        !(node.action === 'call' && (field === 'ref' || field === 'params')) &&
        !(node.action === 'end' && field === 'status'),
    ),
  );
}

export function extractWorkflow(
  ctx: MutableValidationContext,
  recipe: Record<string, unknown>,
): WorkflowGraph | null {
  const workflow = recipe.workflow;
  if (!isRecord(workflow)) {
    addFinding(
      ctx,
      'error',
      'recipe.missing_workflow',
      'workflow',
      'Recipe must include workflow.',
    );
    return null;
  }

  for (const field of Object.keys(workflow)) {
    if (field !== 'entry' && field !== 'nodes' && field !== 'teardown') {
      addFinding(
        ctx,
        'error',
        'workflow.unsupported_field',
        `workflow.${field}`,
        `Recipe Protocol v1 does not support workflow field ${field}.`,
      );
    }
  }

  const entry = workflow.entry;
  if (!isNonEmptyString(entry)) {
    addFinding(
      ctx,
      'error',
      'workflow.invalid_entry',
      'workflow.entry',
      'workflow.entry must be a non-empty string.',
    );
  }

  const teardown = workflow.teardown;
  if (hasOwn(workflow, 'teardown') && !isNonEmptyString(teardown)) {
    addFinding(
      ctx,
      'error',
      'workflow.invalid_teardown',
      'workflow.teardown',
      'workflow.teardown must be a non-empty node id when present.',
    );
  }

  const nodes = workflow.nodes;
  if (!isRecord(nodes) || Object.keys(nodes).length === 0) {
    addFinding(
      ctx,
      'error',
      'workflow.invalid_nodes',
      'workflow.nodes',
      'workflow.nodes must be a non-empty object.',
    );
    return null;
  }

  const typedNodes = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!isNonEmptyString(nodeId) || !NODE_ID_PATTERN.test(nodeId) || !isRecord(node)) {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_node',
        `workflow.nodes.${nodeId}`,
        `Workflow node ${nodeId} must be an object whose id contains only letters, numbers, underscores, or hyphens.`,
      );
      continue;
    }
    typedNodes[nodeId] = node;
  }

  if (!isNonEmptyString(entry)) return null;
  return {
    entry,
    nodes: typedNodes,
    ...(isNonEmptyString(teardown) ? { teardown } : {}),
  };
}

function normalizeIntent(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ');
}

function validateNodeIntent(
  ctx: MutableValidationContext,
  nodeId: string,
  node: Record<string, unknown>,
  path: string,
): void {
  const intent = node.intent;
  if (!isNonEmptyString(intent)) {
    addFinding(
      ctx,
      'error',
      'workflow.invalid_intent',
      `${path}.intent`,
      'Every non-terminal node requires one short human-facing intent sentence for HUD and trace evidence.',
    );
    return;
  }

  const normalized = normalizeIntent(intent);
  const blockedValues = [nodeId, node.action, node.selector, node.test_id, node.testID, node.ref]
    .filter(isNonEmptyString)
    .map(normalizeIntent);
  const uiMechanicPattern = isNonEmptyString(node.action)
    ? UI_MECHANIC_INTENTS[node.action]
    : undefined;
  if (
    GENERIC_INTENTS.has(normalized) ||
    GENERIC_INTENT_PATTERN.test(normalized) ||
    IMPLEMENTATION_INTENTS.has(normalized) ||
    OFFICIAL_ACTION_SET.has(intent.trim()) ||
    blockedValues.includes(normalized) ||
    (uiMechanicPattern?.test(normalized) ?? false) ||
    (isNonEmptyString(node.action) &&
      node.action.startsWith('ui.') &&
      UI_IMPLEMENTATION_TERMS.test(normalized))
  ) {
    addFinding(
      ctx,
      'error',
      'workflow.invalid_intent',
      `${path}.intent`,
      'Intent must explain the human-visible goal, not repeat an action, node id, selector, or generic verb.',
    );
  }
}

function validateProves(
  ctx: MutableValidationContext,
  node: Record<string, unknown>,
  path: string,
): void {
  if (!hasOwn(node, 'proves')) return;
  if (
    !Array.isArray(node.proves) ||
    node.proves.some((target) => !isNonEmptyString(target)) ||
    new Set(node.proves).size !== node.proves.length
  ) {
    addFinding(
      ctx,
      'error',
      'workflow.invalid_proves',
      `${path}.proves`,
      'proves must be an array of unique non-empty proof target ids.',
    );
  }
}

function collectTargets(
  ctx: MutableValidationContext,
  node: Record<string, unknown>,
  path: string,
  emitFindings = true,
): string[] {
  const targets: string[] = [];
  if (hasOwn(node, 'next')) {
    if (isNonEmptyString(node.next)) targets.push(node.next);
    else if (emitFindings)
      addFinding(
        ctx,
        'error',
        'workflow.invalid_next',
        `${path}.next`,
        'next must be a non-empty node id.',
      );
  }

  if (hasOwn(node, 'default')) {
    if (isNonEmptyString(node.default)) targets.push(node.default);
    else if (emitFindings)
      addFinding(
        ctx,
        'error',
        'workflow.invalid_default',
        `${path}.default`,
        'default must be a non-empty node id.',
      );
  }

  if (hasOwn(node, 'cases')) {
    if (!isRecord(node.cases) || Object.keys(node.cases).length === 0) {
      if (emitFindings)
        addFinding(
          ctx,
          'error',
          'workflow.invalid_cases',
          `${path}.cases`,
          'cases must be a non-empty object mapping result cases to node ids.',
        );
    } else {
      for (const [caseName, target] of Object.entries(node.cases)) {
        if (!isNonEmptyString(caseName) || !isNonEmptyString(target)) {
          if (emitFindings)
            addFinding(
              ctx,
              'error',
              'workflow.invalid_case_target',
              `${path}.cases.${caseName}`,
              'Each case must map a non-empty case name to a non-empty node id.',
            );
          continue;
        }
        targets.push(target);
      }
    }
  }
  return targets;
}

function validateNodeShape(
  ctx: MutableValidationContext,
  nodeId: string,
  node: Record<string, unknown>,
): void {
  const path = `workflow.nodes.${nodeId}`;
  const action = node.action;
  if (!isNonEmptyString(action)) {
    addFinding(
      ctx,
      'error',
      'workflow.invalid_action',
      `${path}.action`,
      'Node action must be a non-empty string.',
    );
    return;
  }

  if (action === 'end') {
    for (const field of Object.keys(node)) {
      if (field !== 'action' && field !== 'status') {
        addFinding(
          ctx,
          'error',
          'workflow.invalid_terminal_field',
          `${path}.${field}`,
          `End nodes do not support ${field}.`,
        );
      }
    }
    if (typeof node.status !== 'string' || !TERMINAL_STATUSES.has(node.status)) {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_terminal_status',
        `${path}.status`,
        'end status must be pass, fail, or unknown.',
      );
    }
    return;
  }

  validateNodeIntent(ctx, nodeId, node, path);
  validateProves(ctx, node, path);
  const hasNext = hasOwn(node, 'next');
  const hasCases = hasOwn(node, 'cases');
  const hasDefault = hasOwn(node, 'default');
  if (hasNext === hasCases || hasDefault !== hasCases) {
    addFinding(
      ctx,
      'error',
      'workflow.invalid_transition_shape',
      path,
      'A non-terminal node must declare exactly next, or cases together with default.',
    );
  }
  collectTargets(ctx, node, path);

  if (action === 'call') {
    for (const field of Object.keys(node)) {
      if (!CALL_NODE_FIELDS.has(field)) {
        addFinding(
          ctx,
          'error',
          'workflow.invalid_call_field',
          `${path}.${field}`,
          `Call nodes do not support ${field}.`,
        );
      }
    }
    if (!isNonEmptyString(node.ref)) {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_call_ref',
        `${path}.ref`,
        'call.ref must be a non-empty recipe id.',
      );
    }
    if (hasOwn(node, 'params') && !isRecord(node.params)) {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_call_params',
        `${path}.params`,
        'call.params must be an object.',
      );
    }
  }
}

export function validateRecipeWorkflowNode(nodeId: string, node: unknown): RecipeValidationResult {
  const ctx = createContext();
  if (!isNonEmptyString(nodeId) || !NODE_ID_PATTERN.test(nodeId) || !isRecord(node)) {
    addFinding(
      ctx,
      'error',
      'workflow.invalid_node',
      `workflow.nodes.${String(nodeId)}`,
      `Workflow node ${String(nodeId)} must be an object whose id contains only letters, numbers, underscores, or hyphens.`,
    );
    return finishResult(ctx);
  }
  validateNodeShape(ctx, nodeId, node);
  return finishResult(ctx);
}

export function validateRecipeActionCases(
  node: Record<string, unknown>,
  action: string,
  resultCases: readonly string[] | undefined,
  path: string,
): RecipeValidationResult {
  const ctx = createContext();
  if (!isRecord(node.cases)) return finishResult(ctx);
  if (!resultCases?.length) {
    addFinding(
      ctx,
      'error',
      'recipe.action_cases_not_declared',
      `${path}.cases`,
      `Action ${action} uses result cases but its manifest declares none.`,
    );
    return finishResult(ctx);
  }
  const allowed = new Set(resultCases);
  for (const caseName of Object.keys(node.cases)) {
    if (allowed.has(caseName)) continue;
    addFinding(
      ctx,
      'error',
      'recipe.action_case_not_declared',
      `${path}.cases.${caseName}`,
      `Case ${caseName} is not declared by action ${action}.`,
    );
  }
  return finishResult(ctx);
}

function walkSubgraph(
  ctx: MutableValidationContext,
  graph: WorkflowGraph,
  root: string,
  label: 'entry' | 'teardown',
): Set<string> {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  let terminalReachable = false;

  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      addFinding(
        ctx,
        'error',
        'workflow.cycle',
        `workflow.nodes.${nodeId}`,
        `The ${label} graph contains a cycle at ${nodeId}; bounded repetition belongs inside an action.`,
      );
      return;
    }
    if (visited.has(nodeId)) return;
    const node = graph.nodes[nodeId];
    if (!node) return;
    visiting.add(nodeId);
    visited.add(nodeId);
    if (node.action === 'end') terminalReachable = true;
    else {
      for (const target of collectTargets(ctx, node, `workflow.nodes.${nodeId}`, false))
        visit(target);
    }
    visiting.delete(nodeId);
  };

  visit(root);
  if (!terminalReachable) {
    addFinding(
      ctx,
      'error',
      'workflow.no_reachable_terminal',
      `workflow.${label}`,
      `No action:end node is reachable from workflow.${label}.`,
    );
  }
  return visited;
}

export function validateWorkflowGraph(
  ctx: MutableValidationContext,
  workflow: WorkflowGraph,
): void {
  if (!hasOwn(workflow.nodes, workflow.entry)) {
    addFinding(
      ctx,
      'error',
      'workflow.missing_entry_node',
      'workflow.entry',
      `Entry node ${workflow.entry} does not exist in workflow.nodes.`,
    );
  }
  if (workflow.teardown && !hasOwn(workflow.nodes, workflow.teardown)) {
    addFinding(
      ctx,
      'error',
      'workflow.missing_teardown_node',
      'workflow.teardown',
      `Teardown node ${workflow.teardown} does not exist in workflow.nodes.`,
    );
  }

  for (const [nodeId, node] of Object.entries(workflow.nodes)) {
    validateNodeShape(ctx, nodeId, node);
    for (const target of collectTargets(ctx, node, `workflow.nodes.${nodeId}`, false)) {
      if (!hasOwn(workflow.nodes, target)) {
        addFinding(
          ctx,
          'error',
          'workflow.missing_target',
          `workflow.nodes.${nodeId}`,
          `Node ${nodeId} references missing target ${target}.`,
        );
      }
    }
  }

  const main = hasOwn(workflow.nodes, workflow.entry)
    ? walkSubgraph(ctx, workflow, workflow.entry, 'entry')
    : new Set<string>();
  const teardown =
    workflow.teardown && hasOwn(workflow.nodes, workflow.teardown)
      ? walkSubgraph(ctx, workflow, workflow.teardown, 'teardown')
      : new Set<string>();

  for (const nodeId of teardown) {
    if (main.has(nodeId)) {
      addFinding(
        ctx,
        'error',
        'workflow.overlapping_teardown',
        `workflow.nodes.${nodeId}`,
        'Entry and teardown subgraphs must be disjoint so cleanup runs exactly once.',
      );
    }
  }
  for (const nodeId of Object.keys(workflow.nodes)) {
    if (!main.has(nodeId) && !teardown.has(nodeId)) {
      addFinding(
        ctx,
        'error',
        'workflow.unreachable_node',
        `workflow.nodes.${nodeId}`,
        `Node ${nodeId} is unreachable from workflow.entry or workflow.teardown.`,
      );
    }
  }
}

export function getRecipeWorkflowNodeIds(recipe: unknown): string[] {
  if (!isRecord(recipe) || !isRecord(recipe.workflow) || !isRecord(recipe.workflow.nodes))
    return [];
  return Object.keys(recipe.workflow.nodes);
}

export function getRecipeCallRefs(recipe: unknown): string[] {
  return getRecipeWorkflowActionEntries(recipe).flatMap(({ node }) =>
    node.action === 'call' && isNonEmptyString(node.ref) ? [normalizeRecipeRef(node.ref)] : [],
  );
}

export function getRecipeWorkflowActions(recipe: unknown): string[] {
  return getRecipeWorkflowActionEntries(recipe).map(({ action }) => action);
}

export function getRecipeWorkflowActionEntries(recipe: unknown): WorkflowActionEntry[] {
  if (!isRecord(recipe) || !isRecord(recipe.workflow) || !isRecord(recipe.workflow.nodes))
    return [];
  return Object.entries(recipe.workflow.nodes).flatMap(([nodeId, node]): WorkflowActionEntry[] => {
    if (!isRecord(node) || !isNonEmptyString(node.action)) return [];
    return [{ nodeId, action: node.action, node, path: `workflow.nodes.${nodeId}` }];
  });
}

export function validateRecipeCalls(
  ctx: MutableValidationContext,
  workflow: WorkflowGraph,
  options?: {
    externalRecipeIds?: ReadonlySet<string>;
    skipResolution?: boolean;
  },
): void {
  for (const [nodeId, node] of Object.entries(workflow.nodes)) {
    if (node.action !== 'call' || !isNonEmptyString(node.ref)) continue;
    const path = `workflow.nodes.${nodeId}.ref`;
    if (isDynamicRecipeRef(node.ref)) {
      addFinding(
        ctx,
        'error',
        'workflow.dynamic_call_ref',
        path,
        'call.ref must be static so dependencies can be resolved and trusted before execution.',
      );
      continue;
    }
    const ref = normalizeRecipeRef(node.ref);
    if (options?.skipResolution !== true && !options?.externalRecipeIds?.has(ref)) {
      addFinding(
        ctx,
        'error',
        'workflow.unresolved_call_ref',
        path,
        `Recipe ${ref} is not available from the resolved recipe library.`,
      );
    }
  }
}
