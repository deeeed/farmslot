import {
  getRecipeWorkflowActionEntries,
  isRecord,
  normalizeRecipeRef,
  RECIPE_ASSERTION_ACTIONS,
} from '@farmslot/protocol';

export interface ProofNode extends Record<string, unknown> {
  action: string;
  ref?: string;
  intent?: string;
  proves?: string[];
  source?: string;
  node?: string;
  path?: string;
  next?: string;
  cause_class?: string;
  default?: string;
  cases?: Record<string, string>;
}

export interface ProofDocument {
  proofTargets?: { id: string; claim?: string }[];
  workflow: { nodes: Record<string, ProofNode> };
}

/** Typed projection of the protocol-validated documents retained by the runner. */
export function proofDocument(value: unknown): ProofDocument {
  return {
    ...(isRecord(value) && Array.isArray(value.proofTargets)
      ? { proofTargets: value.proofTargets as NonNullable<ProofDocument['proofTargets']> }
      : {}),
    workflow: {
      nodes: Object.fromEntries(
        getRecipeWorkflowActionEntries(value).map(({ nodeId, action, node }) => [
          nodeId,
          { ...node, action },
        ]),
      ),
    },
  };
}

export interface ProofTraceEntry {
  nodeId?: string;
  id?: string;
  action: string;
  ok: boolean;
  output?: unknown;
  next?: string;
  cause_class?: string;
}

const assertionActions = RECIPE_ASSERTION_ACTIONS;
const controlActions = new Set([
  'end',
  'wait',
  'manual',
  'switch',
  'call',
  'index_artifacts',
  'assert_exit_code',
  'assert_file',
  'branch',
  'repeat',
  'set',
  'log',
]);
export const PROOF_INPUT_ACTIONS: ReadonlySet<string> = new Set([
  'ui.press',
  'ui.key_press',
  'ui.set_input',
  'ui.swipe',
  'ui.drag',
  'ui.long_press',
]);

export function isProofObservation(action: string): boolean {
  return !controlActions.has(action) && !assertionActions.has(action);
}

export function proofAssertionSource(id: string, node: ProofNode): string {
  return qualifyProofNodeRef(id, String(node.source ?? node.node ?? ''));
}

export function qualifyProofNodeRef(id: string, target: string): string {
  const prefix = id.includes('/') ? id.slice(0, id.lastIndexOf('/') + 1) : '';
  return prefix + target;
}

/** Non-vacuous expectation presence; parameter parsing remains the registered handler's job. */
function hasProofExpectation(node: ProofNode): boolean {
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  const meaningfulAssertion = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    if (text(value.operator)) return true;
    const group = value.all ?? value.any ?? value.none;
    return Array.isArray(group) && group.length > 0 && group.every(meaningfulAssertion);
  };
  if (node.action === 'assert_output')
    return text(node.contains) || text(node.match) || meaningfulAssertion(node.assert);
  if (node.action === 'assert_json') return meaningfulAssertion(node.assert);
  return (
    node.action === 'ui.wait_for' &&
    [node.selector, node.test_id, node.testID, node.text, node.expected].some(text)
  );
}

export function collectProofNodes(
  recipe: ProofDocument,
  documents: ReadonlyMap<string, ProofDocument>,
): Map<string, ProofNode> {
  const nodes = new Map<string, ProofNode>();
  function collect(document: ProofDocument, prefix = '', stack = new Set<string>()): void {
    for (const [id, node] of Object.entries(document.workflow.nodes)) {
      nodes.set(prefix + id, { ...node });
      if (node.action === 'call' && typeof node.ref === 'string') {
        const ref = normalizeRecipeRef(node.ref);
        if (stack.has(ref)) throw new Error('Recursive recipe proof.');
        const nested = documents.get(ref);
        if (!nested) throw new Error(`Missing resolved recipe ${ref}.`);
        collect(nested, `${prefix}${id}/`, new Set(stack).add(ref));
      }
    }
  }
  collect(recipe);
  return nodes;
}

/** Preflight eligibility never asserts that an expectation was actually executed. */
export function potentiallyEligibleProof(
  id: string,
  nodes: ReadonlyMap<string, ProofNode>,
): boolean {
  const node = nodes.get(id);
  if (!node) return false;
  if (node.action === 'call')
    return [...nodes.keys()].some(
      (child) => child.startsWith(`${id}/`) && potentiallyEligibleProof(child, nodes),
    );
  if (!hasProofExpectation(node)) return false;
  if (node.action === 'assert_output') {
    const source = nodes.get(proofAssertionSource(id, node));
    return Boolean(source && isProofObservation(source.action));
  }
  if (node.action === 'ui.wait_for')
    return [...nodes.values()].some((entry) => PROOF_INPUT_ACTIONS.has(entry.action));
  return node.action === 'assert_json' && typeof node.path === 'string';
}

/** All eligible child assertions are retained; the singular API returns the last one. */
export function executedProofIndex(
  id: string,
  nodes: ReadonlyMap<string, ProofNode>,
  entries: readonly ProofTraceEntry[],
  artifacts: readonly { path: string; category?: string }[],
  before = entries.length,
): number | null {
  return executedProofIndices(id, nodes, entries, artifacts, before).at(-1) ?? null;
}

export function executedProofIndices(
  id: string,
  nodes: ReadonlyMap<string, ProofNode>,
  entries: readonly ProofTraceEntry[],
  artifacts: readonly { path: string; category?: string }[],
  before = entries.length,
): number[] {
  const node = nodes.get(id);
  if (!node) return [];
  const currentIndex = lastTraceIndex(entries, id, before);
  const current = entries[currentIndex];
  if (!current || current.action !== node.action) return [];
  if (node.action === 'call') {
    const children = [...nodes.keys()]
      .filter((key) => key.startsWith(`${id}/`))
      .flatMap((key) => executedProofIndices(key, nodes, entries, artifacts, currentIndex));
    if (!children.length) return [];
    return current.ok ? [...new Set(children)].sort((a, b) => a - b) : [currentIndex];
  }
  if (!assertionActions.has(node.action) || !hasProofExpectation(node)) return [];
  if (!current.ok && current.cause_class && current.cause_class !== 'subject') return [];
  if (current.ok && (!current.output || typeof current.output !== 'object')) return [];
  if (node.action === 'assert_output') {
    const source = proofAssertionSource(id, node);
    const prior = entries[lastTraceIndex(entries, source, currentIndex)];
    const action = nodes.get(source)?.action;
    return prior && action && action === prior.action && isProofObservation(action)
      ? [currentIndex]
      : [];
  }
  if (node.action === 'ui.wait_for')
    return entries
      .slice(0, currentIndex)
      .some((entry) => entry.ok && PROOF_INPUT_ACTIONS.has(entry.action))
      ? [currentIndex]
      : [];
  return typeof node.path === 'string' &&
    artifacts.some((artifact) => artifact.path === node.path && artifact.category === 'proof')
    ? [currentIndex]
    : [];
}

function lastTraceIndex(
  entries: readonly ProofTraceEntry[],
  id: string,
  before = entries.length,
): number {
  for (let index = before - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if ((entry.nodeId ?? entry.id) === id) return index;
  }
  return -1;
}
