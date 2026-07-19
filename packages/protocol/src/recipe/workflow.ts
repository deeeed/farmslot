import {
  addFinding,
  hasOwn,
  isNonEmptyString,
  isRecord,
  type MutableValidationContext,
  OFFICIAL_ACTION_SET,
  PLAYBACK_MODES,
  RECIPE_PLAYBACK_SLOW_MS_MAX,
  RECIPE_PLAYBACK_SLOW_MS_MIN,
  TERMINAL_STATUSES,
} from './common.js';

interface WorkflowGraph {
  entry: string;
  nodes: Record<string, Record<string, unknown>>;
  lifecycleNodes: Record<string, LifecycleWorkflowNode>;
}

interface LifecycleWorkflowNode {
  node: Record<string, unknown>;
  path: string;
}

interface RecipePreconditionGate {
  id: string;
  path: string;
}

const GENERIC_INTENTS = new Set([
  'executing recipe step',
  'run',
  'setup',
  'ui',
  'wallet',
  'perps',
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

/** Canonical flow identifier used by validation, planning, and execution. */
export function normalizeRecipeFlowRef(value: string): string {
  return value.trim();
}

function normalizeIntent(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function addInvalidIntentFinding(
  ctx: MutableValidationContext,
  codePrefix: 'workflow' | 'flow',
  path: string,
  message: string,
): void {
  addFinding(ctx, 'error', `${codePrefix}.invalid_intent`, path, message);
}

function validateNodeIntent(
  ctx: MutableValidationContext,
  codePrefix: 'workflow' | 'flow',
  nodeId: string,
  node: Record<string, unknown>,
  path: string,
): void {
  const intent = node.intent;
  if (!isNonEmptyString(intent)) {
    addInvalidIntentFinding(
      ctx,
      codePrefix,
      `${path}.intent`,
      'Missing required node intent. Add intent as one short HUD/trace sentence describing what the agent is doing now, for example: "Open the Perps market screen".',
    );
    return;
  }

  const normalized = normalizeIntent(intent);
  const action = isNonEmptyString(node.action) ? node.action : '';
  const blockedValues = [
    nodeId,
    action,
    node.selector,
    node.test_id,
    node.testID,
    node.id,
    node.ref,
  ].filter(isNonEmptyString);
  const normalizedBlockedValues = new Set(blockedValues.map(normalizeIntent));

  if (
    GENERIC_INTENTS.has(normalized) ||
    IMPLEMENTATION_INTENTS.has(normalized) ||
    OFFICIAL_ACTION_SET.has(intent.trim()) ||
    normalizedBlockedValues.has(normalized)
  ) {
    addInvalidIntentFinding(
      ctx,
      codePrefix,
      `${path}.intent`,
      'Invalid node intent. Expected one short HUD/trace sentence for what the agent is doing now; do not use generic text, action names, node ids, selectors, test ids, or implementation primitives.',
    );
  }
}

export function extractWorkflow(
  ctx: MutableValidationContext,
  recipe: Record<string, unknown>,
): WorkflowGraph | null {
  const validate = recipe.validate;
  if (!isRecord(validate)) {
    addFinding(
      ctx,
      'error',
      'recipe.missing_validate',
      'validate',
      'Recipe must include validate.',
    );
    return null;
  }

  const workflow = validate.workflow;
  if (!isRecord(workflow)) {
    addFinding(
      ctx,
      'error',
      'recipe.missing_workflow',
      'validate.workflow',
      'Recipe must include validate.workflow.',
    );
    return null;
  }

  const entry = workflow.entry;
  if (!isNonEmptyString(entry)) {
    addFinding(
      ctx,
      'error',
      'workflow.invalid_entry',
      'validate.workflow.entry',
      'validate.workflow.entry must be a non-empty string.',
    );
  }

  const nodes = workflow.nodes;
  if (!isRecord(nodes) || Object.keys(nodes).length === 0) {
    addFinding(
      ctx,
      'error',
      'workflow.invalid_nodes',
      'validate.workflow.nodes',
      'validate.workflow.nodes must be a non-empty object.',
    );
    return null;
  }

  const typedNodes = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!isRecord(node)) {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_node',
        `validate.workflow.nodes.${nodeId}`,
        `Workflow node ${nodeId} must be an object.`,
      );
      continue;
    }
    typedNodes[nodeId] = node;
  }

  const lifecycleNodes = collectLifecycleNodes(ctx, recipe, workflow);
  if (!isNonEmptyString(entry)) return null;
  return { entry, nodes: typedNodes, lifecycleNodes };
}

function collectLifecycleNodes(
  ctx: MutableValidationContext,
  recipe: Record<string, unknown>,
  workflow: Record<string, unknown>,
): Record<string, LifecycleWorkflowNode> {
  const lifecycleNodes: Record<string, LifecycleWorkflowNode> = Object.create(null) as Record<
    string,
    LifecycleWorkflowNode
  >;
  collectLifecycleArray(ctx, workflow.setup, 'validate.workflow.setup', lifecycleNodes);
  if (recipe.startState != null) {
    if (isRecord(recipe.startState)) {
      lifecycleNodes.startState = { node: recipe.startState, path: 'startState' };
    } else {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_start_state',
        'startState',
        'startState must be an action node object when present.',
      );
    }
  }
  collectLifecycleArray(ctx, workflow.teardown, 'validate.workflow.teardown', lifecycleNodes);
  return lifecycleNodes;
}

function collectLifecycleArray(
  ctx: MutableValidationContext,
  value: unknown,
  path: string,
  lifecycleNodes: Record<string, LifecycleWorkflowNode>,
): void {
  if (value == null) return;
  if (!Array.isArray(value)) {
    addFinding(ctx, 'error', 'workflow.invalid_lifecycle', path, `${path} must be an array.`);
    return;
  }
  value.forEach((entry, index) => {
    const nodePath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_lifecycle_node',
        nodePath,
        `${nodePath} must be an action node object.`,
      );
      return;
    }
    lifecycleNodes[isNonEmptyString(entry.id) ? entry.id : `${path}:${index}`] = {
      node: entry,
      path: nodePath,
    };
    if (entry.next != null) {
      addFinding(
        ctx,
        'error',
        'workflow.lifecycle_has_transition',
        `${nodePath}.next`,
        'setup and teardown entries are ordered arrays and must not declare next.',
      );
    }
  });
}

function collectCaseTargets(
  node: Record<string, unknown>,
  path: string,
  ctx: MutableValidationContext,
  emitFindings = true,
): string[] {
  const cases = node.cases;
  if (cases == null) return [];
  if (Array.isArray(cases)) {
    const targets: string[] = [];
    cases.forEach((entry, index) => {
      if (!isRecord(entry)) {
        if (emitFindings) {
          addFinding(
            ctx,
            'error',
            'workflow.invalid_case',
            `${path}.cases[${index}]`,
            'cases entries must be objects.',
          );
        }
        return;
      }
      const target = entry.next;
      if (target == null) return;
      if (isNonEmptyString(target)) {
        targets.push(target);
      } else {
        if (emitFindings) {
          addFinding(
            ctx,
            'error',
            'workflow.invalid_case_target',
            `${path}.cases[${index}].next`,
            'cases[].next must be a non-empty string when present.',
          );
        }
      }
    });
    return targets;
  }

  if (isRecord(cases)) {
    const targets: string[] = [];
    for (const [caseName, target] of Object.entries(cases)) {
      if (isNonEmptyString(target)) {
        targets.push(target);
      } else {
        if (emitFindings) {
          addFinding(
            ctx,
            'error',
            'workflow.invalid_case_target',
            `${path}.cases.${caseName}`,
            'case targets must be non-empty strings.',
          );
        }
      }
    }
    return targets;
  }

  if (emitFindings) {
    addFinding(
      ctx,
      'error',
      'workflow.invalid_cases',
      `${path}.cases`,
      'cases must be an array or object.',
    );
  }
  return [];
}

function collectTargets(
  node: Record<string, unknown>,
  path: string,
  ctx: MutableValidationContext,
  emitFindings = true,
): string[] {
  const targets: string[] = [];
  const next = node.next;
  const defaultTarget = node.default;

  if (next != null) {
    if (isNonEmptyString(next)) {
      targets.push(next);
    } else {
      if (emitFindings) {
        addFinding(
          ctx,
          'error',
          'workflow.invalid_next',
          `${path}.next`,
          'next must be a non-empty string.',
        );
      }
    }
  }

  if (defaultTarget != null) {
    if (isNonEmptyString(defaultTarget)) {
      targets.push(defaultTarget);
    } else {
      if (emitFindings) {
        addFinding(
          ctx,
          'error',
          'workflow.invalid_default',
          `${path}.default`,
          'default must be a non-empty string.',
        );
      }
    }
  }

  targets.push(...collectCaseTargets(node, path, ctx, emitFindings));
  return targets;
}

function validatePlayback(ctx: MutableValidationContext, workflow: Record<string, unknown>): void {
  if (workflow.playback == null) return;
  if (!isRecord(workflow.playback)) {
    addFinding(
      ctx,
      'error',
      'workflow.invalid_playback',
      'validate.workflow.playback',
      'playback must be an object when present.',
    );
    return;
  }

  const playback = workflow.playback;
  if (
    playback.mode != null &&
    (typeof playback.mode !== 'string' || !PLAYBACK_MODES.has(playback.mode))
  ) {
    addFinding(
      ctx,
      'error',
      'workflow.invalid_playback_mode',
      'validate.workflow.playback.mode',
      'playback.mode must be one of off, auto, or step.',
    );
  }

  if (playback.slow_ms != null) {
    if (
      typeof playback.slow_ms !== 'number' ||
      !Number.isInteger(playback.slow_ms) ||
      playback.slow_ms < RECIPE_PLAYBACK_SLOW_MS_MIN ||
      playback.slow_ms > RECIPE_PLAYBACK_SLOW_MS_MAX
    ) {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_playback_slow_ms',
        'validate.workflow.playback.slow_ms',
        `playback.slow_ms must be an integer from ${RECIPE_PLAYBACK_SLOW_MS_MIN} through ${RECIPE_PLAYBACK_SLOW_MS_MAX}.`,
      );
    }
  }
}

export function validateWorkflowGraph(
  ctx: MutableValidationContext,
  workflow: WorkflowGraph,
  rawWorkflow: Record<string, unknown>,
): void {
  if (!hasOwn(workflow.nodes, workflow.entry)) {
    addFinding(
      ctx,
      'error',
      'workflow.missing_entry_node',
      'validate.workflow.entry',
      `Entry node ${workflow.entry} does not exist in validate.workflow.nodes.`,
    );
  }

  validatePlayback(ctx, rawWorkflow);

  const reachable = new Set<string>();
  const queue = hasOwn(workflow.nodes, workflow.entry) ? [workflow.entry] : [];
  let terminalCount = 0;
  let reachableTerminalCount = 0;

  const graphNodes = Object.entries(workflow.nodes).map(
    ([nodeId, node]) => [nodeId, { node, path: `validate.workflow.nodes.${nodeId}` }] as const,
  );
  const lifecycleNodes = Object.entries(workflow.lifecycleNodes);

  for (const [nodeId, entry] of [...graphNodes, ...lifecycleNodes]) {
    const { node, path } = entry;
    const action = node.action;
    if (!isNonEmptyString(action)) {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_action',
        `${path}.action`,
        'Node action must be a non-empty string.',
      );
      continue;
    }

    const isLifecycleNode = hasOwn(workflow.lifecycleNodes, nodeId);
    const targets = isLifecycleNode ? [] : collectTargets(node, path, ctx);
    if (action === 'end') {
      terminalCount += 1;
      if (node.status == null) {
        addFinding(
          ctx,
          'error',
          'workflow.missing_terminal_status',
          `${path}.status`,
          'end nodes must include status.',
        );
      } else if (typeof node.status !== 'string' || !TERMINAL_STATUSES.has(node.status)) {
        addFinding(
          ctx,
          'error',
          'workflow.invalid_terminal_status',
          `${path}.status`,
          'end node status must be pass, fail, or unknown.',
        );
      }
      if (targets.length > 0) {
        addFinding(
          ctx,
          'warning',
          'workflow.terminal_has_targets',
          path,
          'end nodes should not define transitions.',
        );
      }
      continue;
    }

    validateNodeIntent(ctx, 'workflow', nodeId, node, path);

    if (!isLifecycleNode && targets.length === 0) {
      addFinding(
        ctx,
        'error',
        'workflow.missing_transition',
        path,
        'Non-terminal nodes must transition via next, cases, or default.',
      );
    }

    for (const target of targets) {
      if (!hasOwn(workflow.nodes, target)) {
        addFinding(
          ctx,
          'error',
          'workflow.missing_target',
          path,
          `Node ${nodeId} references missing target node ${target}.`,
        );
      }
    }
  }

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || reachable.has(nodeId)) continue;
    if (!hasOwn(workflow.nodes, nodeId)) continue;
    const node = workflow.nodes[nodeId];
    reachable.add(nodeId);
    if (node.action === 'end') reachableTerminalCount += 1;
    for (const target of collectTargets(node, `validate.workflow.nodes.${nodeId}`, ctx, false)) {
      if (hasOwn(workflow.nodes, target) && !reachable.has(target)) queue.push(target);
    }
  }

  if (terminalCount === 0) {
    addFinding(
      ctx,
      'error',
      'workflow.missing_terminal',
      'validate.workflow.nodes',
      'Workflow must include at least one action:end terminal node.',
    );
  } else if (hasOwn(workflow.nodes, workflow.entry) && reachableTerminalCount === 0) {
    addFinding(
      ctx,
      'error',
      'workflow.no_reachable_terminal',
      'validate.workflow.nodes',
      'No terminal end node is reachable from the entry node.',
    );
  }

  for (const nodeId of Object.keys(workflow.nodes)) {
    if (!reachable.has(nodeId)) {
      addFinding(
        ctx,
        'warning',
        'workflow.unreachable_node',
        `validate.workflow.nodes.${nodeId}`,
        `Node ${nodeId} is not reachable from the entry node.`,
      );
    }
  }
}

export function getRecipeWorkflowNodeIds(recipe: unknown): string[] {
  if (!isRecord(recipe) || !isRecord(recipe.validate) || !isRecord(recipe.validate.workflow))
    return [];
  const nodes = recipe.validate.workflow.nodes;
  if (!isRecord(nodes)) return [];
  const ids = Object.keys(nodes);
  if (isRecord(recipe.startState)) ids.push('startState');
  for (const key of ['setup', 'teardown']) {
    const lifecycle = recipe.validate.workflow[key];
    if (!Array.isArray(lifecycle)) continue;
    lifecycle.forEach((node, index) => {
      if (isRecord(node)) ids.push(isNonEmptyString(node.id) ? node.id : `${key}:${index}`);
    });
  }
  return ids;
}

export function getRecipeWorkflowActions(recipe: unknown): string[] {
  return getRecipeWorkflowActionEntries(recipe).map((entry) => entry.action);
}

export function getRecipeWorkflowActionEntries(
  recipe: unknown,
): Array<{ nodeId: string; action: string; path: string }> {
  if (!isRecord(recipe) || !isRecord(recipe.validate) || !isRecord(recipe.validate.workflow)) {
    return [];
  }
  const nodes = recipe.validate.workflow.nodes;
  if (!isRecord(nodes)) return [];
  const actions: Array<{ nodeId: string; action: string; path: string }> = [];
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!isRecord(node)) continue;
    if (isNonEmptyString(node.action)) {
      actions.push({
        nodeId,
        action: node.action,
        path: `validate.workflow.nodes.${nodeId}.action`,
      });
    }
  }
  if (isRecord(recipe.startState) && isNonEmptyString(recipe.startState.action)) {
    actions.push({
      nodeId: 'startState',
      action: recipe.startState.action,
      path: 'startState.action',
    });
  }
  for (const key of ['setup', 'teardown']) {
    const lifecycle = recipe.validate.workflow[key];
    if (!Array.isArray(lifecycle)) continue;
    lifecycle.forEach((node, index) => {
      if (!isRecord(node) || !isNonEmptyString(node.action)) return;
      actions.push({
        nodeId: isNonEmptyString(node.id) ? node.id : `${key}:${index}`,
        action: node.action,
        path: `validate.workflow.${key}[${index}].action`,
      });
    });
  }
  if (isRecord(recipe.flows)) {
    for (const [flowId, flow] of Object.entries(recipe.flows)) {
      if (!isRecord(flow)) continue;
      const workflow = isRecord(flow.workflow) ? flow.workflow : flow;
      if (!isRecord(workflow.nodes)) continue;
      for (const [nodeId, node] of Object.entries(workflow.nodes)) {
        if (!isRecord(node) || !isNonEmptyString(node.action)) continue;
        actions.push({
          nodeId: `${flowId}/${nodeId}`,
          action: node.action,
          path: `flows.${flowId}.workflow.nodes.${nodeId}.action`,
        });
      }
    }
  }
  return actions;
}

export function validateInlineFlows(
  ctx: MutableValidationContext,
  recipe: Record<string, unknown>,
): void {
  const flows = recipe.flows;
  if (flows == null) return;
  if (!isRecord(flows)) {
    addFinding(ctx, 'error', 'flow.invalid_flows', 'flows', 'flows must be an object.');
    return;
  }

  const inlineFlowIds = new Set<string>();
  for (const flowId of Object.keys(flows)) {
    const normalizedFlowId = normalizeRecipeFlowRef(flowId);
    if (!normalizedFlowId) {
      addFinding(ctx, 'error', 'flow.invalid_id', `flows.${flowId}`, 'Flow id must not be empty.');
    } else if (inlineFlowIds.has(normalizedFlowId)) {
      addFinding(
        ctx,
        'error',
        'flow.duplicate_id',
        `flows.${flowId}`,
        `Flow id ${flowId} collides with another flow after whitespace normalization.`,
      );
    } else {
      inlineFlowIds.add(normalizedFlowId);
    }
  }
  const callGraph = new Map<string, string[]>();
  for (const [flowId, flow] of Object.entries(flows)) {
    const normalizedFlowId = normalizeRecipeFlowRef(flowId);
    const flowPath = `flows.${flowId}`;
    if (!isRecord(flow)) {
      addFinding(ctx, 'error', 'flow.invalid_flow', flowPath, `Flow ${flowId} must be an object.`);
      continue;
    }
    const workflow = isRecord(flow.workflow) ? flow.workflow : flow;
    const entry = workflow.entry;
    const nodes = workflow.nodes;
    if (!isNonEmptyString(entry)) {
      addFinding(
        ctx,
        'error',
        'flow.invalid_entry',
        `${flowPath}.workflow.entry`,
        `Flow ${flowId} entry must be a non-empty string.`,
      );
    }
    if (!isRecord(nodes) || Object.keys(nodes).length === 0) {
      addFinding(
        ctx,
        'error',
        'flow.invalid_nodes',
        `${flowPath}.workflow.nodes`,
        `Flow ${flowId} nodes must be a non-empty object.`,
      );
      continue;
    }
    if (isNonEmptyString(entry) && !hasOwn(nodes, entry)) {
      addFinding(
        ctx,
        'error',
        'flow.missing_entry_node',
        `${flowPath}.workflow.entry`,
        `Flow ${flowId} entry node ${entry} does not exist.`,
      );
    }

    const callees: string[] = [];
    const reachable = new Set<string>();
    const queue = isNonEmptyString(entry) && hasOwn(nodes, entry) ? [entry] : [];
    let terminalCount = 0;
    let reachableTerminalCount = 0;
    for (const [nodeId, node] of Object.entries(nodes)) {
      const nodePath = `${flowPath}.workflow.nodes.${nodeId}`;
      if (!isRecord(node)) {
        addFinding(
          ctx,
          'error',
          'flow.invalid_node',
          nodePath,
          `Flow node ${nodeId} must be an object.`,
        );
        continue;
      }
      if (!isNonEmptyString(node.action)) {
        addFinding(
          ctx,
          'error',
          'flow.invalid_action',
          `${nodePath}.action`,
          'Flow node action must be a non-empty string.',
        );
        continue;
      }
      if (node.action === 'call' && isNonEmptyString(node.ref)) {
        const ref = normalizeRecipeFlowRef(node.ref);
        if (inlineFlowIds.has(ref)) callees.push(ref);
      }
      if (node.action !== 'end') {
        validateNodeIntent(ctx, 'flow', nodeId, node, nodePath);
        const targets = collectTargets(node, nodePath, ctx);
        if (targets.length === 0) {
          addFinding(
            ctx,
            'error',
            'flow.missing_transition',
            nodePath,
            'Non-terminal flow nodes must transition via next, cases, or default.',
          );
        }
        for (const target of targets) {
          if (!hasOwn(nodes, target)) {
            addFinding(
              ctx,
              'error',
              'flow.missing_target',
              nodePath,
              `Flow node ${nodeId} references missing target node ${target}.`,
            );
          }
        }
      } else {
        terminalCount += 1;
        if (node.status == null) {
          addFinding(
            ctx,
            'error',
            'flow.missing_terminal_status',
            `${nodePath}.status`,
            'Flow end nodes must include status.',
          );
        } else if (typeof node.status !== 'string' || !TERMINAL_STATUSES.has(node.status)) {
          addFinding(
            ctx,
            'error',
            'flow.invalid_terminal_status',
            `${nodePath}.status`,
            'Flow end node status must be pass, fail, or unknown.',
          );
        }
      }
    }
    while (queue.length > 0) {
      const nodeId = queue.shift();
      if (!nodeId || reachable.has(nodeId)) continue;
      const node = nodes[nodeId];
      if (!isRecord(node)) continue;
      reachable.add(nodeId);
      if (node.action === 'end') reachableTerminalCount += 1;
      for (const target of collectTargets(
        node,
        `${flowPath}.workflow.nodes.${nodeId}`,
        ctx,
        false,
      )) {
        if (hasOwn(nodes, target) && !reachable.has(target)) queue.push(target);
      }
    }
    if (terminalCount === 0) {
      addFinding(
        ctx,
        'error',
        'flow.missing_terminal',
        `${flowPath}.workflow.nodes`,
        `Flow ${flowId} must include at least one action:end terminal node.`,
      );
    } else if (isNonEmptyString(entry) && hasOwn(nodes, entry) && reachableTerminalCount === 0) {
      addFinding(
        ctx,
        'error',
        'flow.no_reachable_terminal',
        `${flowPath}.workflow.nodes`,
        `No terminal end node is reachable from flow ${flowId} entry node.`,
      );
    }
    for (const nodeId of Object.keys(nodes)) {
      if (!reachable.has(nodeId)) {
        addFinding(
          ctx,
          'warning',
          'flow.unreachable_node',
          `${flowPath}.workflow.nodes.${nodeId}`,
          `Flow node ${nodeId} is not reachable from the entry node.`,
        );
      }
    }
    if (normalizedFlowId) callGraph.set(normalizedFlowId, callees);
  }
  validateInlineFlowCycles(ctx, callGraph);
}

function validateInlineFlowCycles(
  ctx: MutableValidationContext,
  callGraph: ReadonlyMap<string, readonly string[]>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(flowId: string): void {
    if (visited.has(flowId)) return;
    if (visiting.has(flowId)) {
      const cycleStart = stack.indexOf(flowId);
      const cycle = [...stack.slice(Math.max(cycleStart, 0)), flowId];
      addFinding(
        ctx,
        'error',
        'flow.call_cycle',
        `flows.${flowId}`,
        `Inline flow call cycle detected: ${cycle.join(' -> ')}.`,
      );
      return;
    }
    visiting.add(flowId);
    stack.push(flowId);
    for (const callee of callGraph.get(flowId) ?? []) visit(callee);
    stack.pop();
    visiting.delete(flowId);
    visited.add(flowId);
  }

  for (const flowId of callGraph.keys()) visit(flowId);
}

export function validateWorkflowPreconditions(
  ctx: MutableValidationContext,
  workflow: Record<string, unknown>,
): void {
  const value = workflow.pre_conditions;
  if (value == null) return;
  if (!Array.isArray(value)) {
    addFinding(
      ctx,
      'error',
      'workflow.invalid_pre_conditions',
      'validate.workflow.pre_conditions',
      'validate.workflow.pre_conditions must be an array.',
    );
    return;
  }
  value.forEach((entry, index) => {
    const path = `validate.workflow.pre_conditions[${index}]`;
    if (typeof entry === 'string') {
      if (!entry.trim()) {
        addFinding(
          ctx,
          'error',
          'workflow.invalid_pre_condition',
          path,
          `${path} must be a non-empty string or object with id.`,
        );
      }
      return;
    }
    if (!isRecord(entry)) {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_pre_condition',
        path,
        `${path} must be a non-empty string or object with id.`,
      );
      return;
    }
    if (!isNonEmptyString(entry.id)) {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_pre_condition_id',
        `${path}.id`,
        `${path}.id must be a non-empty string.`,
      );
    }
    if (entry.description != null && typeof entry.description !== 'string') {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_pre_condition_description',
        `${path}.description`,
        `${path}.description must be a string when present.`,
      );
    }
    if (entry.params != null && !isRecord(entry.params)) {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_pre_condition_params',
        `${path}.params`,
        `${path}.params must be an object when present.`,
      );
    }
    if (entry.required != null && typeof entry.required !== 'boolean') {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_pre_condition_required',
        `${path}.required`,
        `${path}.required must be a boolean when present.`,
      );
    }
  });
}

export function getRecipeWorkflowPreconditionEntries(recipe: unknown): RecipePreconditionGate[] {
  if (!isRecord(recipe) || !isRecord(recipe.validate) || !isRecord(recipe.validate.workflow)) {
    return [];
  }
  const entries = recipe.validate.workflow.pre_conditions;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry, index): RecipePreconditionGate[] => {
    const path = `validate.workflow.pre_conditions[${index}]`;
    if (typeof entry === 'string' && entry.trim()) return [{ id: entry.trim(), path }];
    if (isRecord(entry) && isNonEmptyString(entry.id)) {
      return [{ id: entry.id, path: `${path}.id` }];
    }
    return [];
  });
}

export function validateFlowCalls(
  ctx: MutableValidationContext,
  recipe: Record<string, unknown>,
  workflow: WorkflowGraph,
  options?: {
    externalFlowIds?: ReadonlySet<string>;
    /** Skip `call.ref` resolution (unresolved_call_ref) only; shape checks still run. */
    skipResolution?: boolean;
    /**
     * Whether a declared `uses` catalog counts as resolving `call.ref`s. True at
     * authoring/run time (catalogs are loaded). False at artifact-package validation,
     * where the catalogs are not in the package, so only inline `flows` (or a proven
     * resolved-recipe.json) count.
     */
    externalCatalogsResolvable?: boolean;
  },
): void {
  const inlineFlows = isRecord(recipe.flows)
    ? new Set(Object.keys(recipe.flows).map(normalizeRecipeFlowRef))
    : new Set<string>();
  const externalCatalogsResolvable = options?.externalCatalogsResolvable !== false;
  const hasExternalCatalogs =
    externalCatalogsResolvable && Array.isArray(recipe.uses) && recipe.uses.length > 0;
  const externalFlowIds = options?.externalFlowIds;
  const entries = [
    ...Object.entries(workflow.nodes).map(
      ([nodeId, node]) => [nodeId, node, `validate.workflow.nodes.${nodeId}`] as const,
    ),
    ...Object.entries(workflow.lifecycleNodes).map(
      ([nodeId, entry]) => [nodeId, entry.node, entry.path] as const,
    ),
    ...getInlineFlowNodeEntries(recipe),
  ];
  for (const [_nodeId, node, path] of entries) {
    if (node.action !== 'call') continue;
    if (!isNonEmptyString(node.ref)) {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_call_ref',
        `${path}.ref`,
        'call.ref must be a non-empty string.',
      );
      continue;
    }
    const ref = normalizeRecipeFlowRef(node.ref);
    if (
      options?.skipResolution !== true &&
      !hasExternalCatalogs &&
      !inlineFlows.has(ref) &&
      !externalFlowIds?.has(ref)
    ) {
      addFinding(
        ctx,
        'error',
        'workflow.unresolved_call_ref',
        `${path}.ref`,
        `Flow ${node.ref} is not declared in recipe.flows and no uses catalogs are present.`,
      );
    }
    if (node.params != null && !isRecord(node.params)) {
      addFinding(
        ctx,
        'error',
        'workflow.invalid_call_params',
        `${path}.params`,
        'call.params must be an object when present.',
      );
    }
  }
}

function getInlineFlowNodeEntries(
  recipe: Record<string, unknown>,
): Array<readonly [string, Record<string, unknown>, string]> {
  if (!isRecord(recipe.flows)) return [];
  const entries: Array<readonly [string, Record<string, unknown>, string]> = [];
  for (const [flowId, flow] of Object.entries(recipe.flows)) {
    if (!isRecord(flow)) continue;
    const workflow = isRecord(flow.workflow) ? flow.workflow : flow;
    if (!isRecord(workflow.nodes)) continue;
    for (const [nodeId, node] of Object.entries(workflow.nodes)) {
      if (!isRecord(node)) continue;
      entries.push([`${flowId}/${nodeId}`, node, `flows.${flowId}.workflow.nodes.${nodeId}`]);
    }
  }
  return entries;
}
