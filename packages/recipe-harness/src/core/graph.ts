import { isRecord } from './json.js';
import type {
  ActionResult,
  PreconditionChecker,
  PreconditionResult,
  RecipePreconditionGate,
} from './types.js';

export interface WorkflowGraph {
  entry: string;
  nodes: Record<string, Record<string, unknown>>;
  preconditions: RecipePreconditionGate[];
  teardownEntry?: string;
}

export function extractWorkflowGraph(recipe: unknown): WorkflowGraph {
  if (!isRecord(recipe) || !isRecord(recipe.validate) || !isRecord(recipe.validate.workflow)) {
    throw new Error('Recipe must include validate.workflow.');
  }
  const workflow = recipe.validate.workflow;
  if (typeof workflow.entry !== 'string' || !isRecord(workflow.nodes)) {
    throw new Error('Recipe workflow must include entry and nodes.');
  }
  const nodes: Record<string, Record<string, unknown>> = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >;
  for (const [nodeId, node] of Object.entries(workflow.nodes)) {
    if (isRecord(node)) nodes[nodeId] = node;
  }
  const mainEntry = workflow.entry;
  const setupNodes = parseLifecycleNodes(workflow.setup, 'setup');
  const startState = isRecord(recipe.startState)
    ? [{ id: 'startState', node: recipe.startState }]
    : [];
  const teardownNodes = parseLifecycleNodes(workflow.teardown, 'teardown');
  const preconditions = parsePreconditions(workflow.pre_conditions);

  let entry = mainEntry;
  const setupChain = [...setupNodes, ...startState];
  if (setupChain.length > 0) {
    entry = setupChain[0]!.id;
    linkLifecycleNodes(nodes, setupChain, mainEntry);
  }

  let teardownEntry: string | undefined;
  if (teardownNodes.length > 0) {
    teardownEntry = teardownNodes[0]!.id;
    linkLifecycleNodes(nodes, teardownNodes, 'teardown:end');
    nodes['teardown:end'] = { action: 'end', status: 'pass', phase: 'teardown' };
  }

  return { entry, nodes, preconditions, teardownEntry };
}

export function parsePreconditions(value: unknown): RecipePreconditionGate[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error('validate.workflow.pre_conditions must be an array.');
  }
  return value.map((entry, index) => {
    if (typeof entry === 'string' && entry.trim()) return { id: entry.trim() };
    if (!isRecord(entry)) {
      throw new Error(`validate.workflow.pre_conditions[${index}] must be a string or object.`);
    }
    if (typeof entry.id !== 'string' || !entry.id.trim()) {
      throw new Error(`validate.workflow.pre_conditions[${index}].id must be a non-empty string.`);
    }
    if (entry.params != null && !isRecord(entry.params)) {
      throw new Error(`validate.workflow.pre_conditions[${index}].params must be an object.`);
    }
    return {
      id: entry.id.trim(),
      description: typeof entry.description === 'string' ? entry.description : undefined,
      params: isRecord(entry.params) ? entry.params : undefined,
      required: typeof entry.required === 'boolean' ? entry.required : undefined,
    };
  });
}

export function normalizePreconditionResult(
  result: Awaited<ReturnType<PreconditionChecker['execute']>>,
): PreconditionResult {
  if (typeof result === 'boolean') return { ok: result };
  if (result === undefined) return { ok: true };
  return result;
}

function parseLifecycleNodes(
  value: unknown,
  phase: 'setup' | 'teardown',
): Array<{ id: string; node: Record<string, unknown> }> {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`validate.workflow.${phase} must be an array.`);
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`validate.workflow.${phase}[${index}] must be an action node object.`);
    }
    const authoredId =
      typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `${phase}:${index}`;
    return {
      id: authoredId,
      node: {
        phase,
        ...entry,
      },
    };
  });
}

function linkLifecycleNodes(
  nodes: Record<string, Record<string, unknown>>,
  lifecycleNodes: Array<{ id: string; node: Record<string, unknown> }>,
  nextAfterLifecycle: string,
): void {
  lifecycleNodes.forEach((entry, index) => {
    if (nodes[entry.id])
      throw new Error(`Lifecycle node id ${entry.id} conflicts with graph node.`);
    if (entry.node.next != null) {
      throw new Error(
        `Lifecycle node ${entry.id} must not declare next; setup and teardown arrays are ordered lists.`,
      );
    }
    const next = lifecycleNodes[index + 1]?.id ?? nextAfterLifecycle;
    nodes[entry.id] = {
      ...entry.node,
      next,
    };
  });
}

export function resolveNextNode(
  node: Record<string, unknown>,
  result: ActionResult,
): string | undefined {
  if (result.next) return result.next;
  if (result.case && isRecord(node.cases)) {
    const target = node.cases[result.case];
    if (typeof target === 'string') return target;
  }
  if (typeof node.next === 'string') return node.next;
  if (typeof node.default === 'string') return node.default;
  return undefined;
}
