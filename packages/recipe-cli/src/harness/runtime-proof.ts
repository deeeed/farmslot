// Behavioral proof checks on a recipe: the plan before it runs, and the
// executed artifact package after, independently of any task host.
import assert from 'node:assert/strict';

import {
  isRecord,
  normalizeRecipeRef,
  type RecipeArtifactManifestEntry,
  type RecipeConformanceLiveEvidence,
  type RecipeValidationFinding,
  validateRecipeArtifactPackage,
} from '@farmslot/protocol';
import { extractWorkflowGraph } from '@farmslot/recipe-runner';

/** Validate executed behavioral proof, independently of any task host or control plane. */
export function validateRuntimeProof(
  bundle: Parameters<typeof validateRecipeArtifactPackage>[0],
  smokeTarget?: string,
  teardownTarget?: string,
  visualProof: Pick<RecipeConformanceLiveEvidence, 'captureRequired' | 'hudRequired'> = {},
): string[] {
  const checked = validateRecipeArtifactPackage(bundle);
  assert.equal(checked.status, 'valid', JSON.stringify(checked.findings));
  const { recipe, summary, trace, manifest, recipeResolution, resolvedRecipes } =
    bundle as unknown as {
      recipe: { proofTargets?: { id: string }[]; workflow: { nodes: Record<string, ProofNode> } };
      summary: { status: string };
      trace: Entry[] | { entries: Entry[] };
      manifest: { artifacts: RecipeArtifactManifestEntry[] };
      recipeResolution: { dependencies: { ref: string; digest: string }[] };
      resolvedRecipes: Record<string, { workflow: { nodes: Record<string, ProofNode> } }>;
    };
  assert.equal(summary.status, 'pass', 'Runtime recipe did not pass');
  const entries = Array.isArray(trace) ? trace : trace.entries;
  assert(
    entries.length && entries.every((entry) => entry.ok === true),
    'Runtime trace contains failed or unknown actions',
  );
  assert(
    entries.some(
      (entry) =>
        entry.action === 'end' &&
        entry.status === 'pass' &&
        !String(entry.nodeId ?? entry.id).includes('/'),
    ),
    'Runtime recipe did not reach its passing end',
  );
  const documents = new Map(
    recipeResolution.dependencies.map((dependency) => [
      normalizeRecipeRef(dependency.ref),
      resolvedRecipes[dependency.digest],
    ]),
  );
  const nodes = collectProofNodes(recipe, documents);
  const executed = new Map(
    entries.map((entry, index) => [entry.nodeId ?? entry.id, { entry, index }]),
  );
  function proves(id: string): boolean {
    const node = nodes.get(id)!;
    const current = executed.get(id);
    if (!current || current.entry.action !== node.action) return false;
    if (node.action === 'call')
      return [...nodes.keys()].some((child) => child.startsWith(`${id}/`) && proves(child));
    if (
      !assertions.has(node.action) ||
      !current.entry.output ||
      typeof current.entry.output !== 'object'
    )
      return false;
    if (node.action === 'assert_output') {
      const source = assertionSource(id, node);
      const prior = executed.get(source);
      const action = nodes.get(source)?.action;
      return Boolean(
        prior &&
        prior.index < current.index &&
        action &&
        action === prior.entry.action &&
        isObservation(action),
      );
    }
    if (node.action === 'ui.wait_for')
      return entries.slice(0, current.index).some((entry) => inputs.has(entry.action));
    return (
      typeof node.path === 'string' &&
      manifest.artifacts.some(
        (artifact) => artifact.path === node.path && artifact.category === 'proof',
      )
    );
  }
  assert(recipe.proofTargets?.length, 'Runtime recipe has no behavioral proof targets');
  for (const target of recipe.proofTargets) {
    const linked = [...nodes].filter(([, node]) => node.proves?.includes(target.id));
    assert(
      linked.some(([id]) => proves(id)),
      `Proof target ${target.id} has no executed runtime assertion`,
    );
  }
  if (smokeTarget)
    assert(
      recipe.proofTargets.some((target) => target.id === smokeTarget),
      'Smoke target is absent from recipe',
    );
  if (teardownTarget) {
    assert(
      recipe.proofTargets.some((target) => target.id === teardownTarget) &&
        teardownProofNodes(recipe, nodes, teardownTarget).some(proves),
      `Teardown target ${teardownTarget} has no executed cleanup assertion`,
    );
  }
  if (!visualProof.captureRequired && !visualProof.hudRequired) return [];
  const proofNodes = [...nodes].filter(([, node]) => node.proves?.includes(smokeTarget ?? ''));
  const captures = manifest.artifacts.filter((artifact) => {
    if (artifact.type !== 'screenshot' && artifact.type !== 'video') return false;
    const nodeId = artifact.nodeId;
    if (!nodeId || !proofNodes.some(([id]) => nodeId === id || nodeId.startsWith(`${id}/`)))
      return false;
    const entry = executed.get(nodeId)?.entry;
    if (!entry || entry.action !== nodes.get(nodeId)?.action) return false;
    if (!visualProof.hudRequired) return true;
    const hud = artifact.metadata?.hud;
    if (!isRecord(hud) || typeof entry.intent !== 'string') return false;
    const expected = entry.intent.replace(/\s+/gu, ' ').trim();
    const matches = (value: unknown): boolean => {
      if (!isRecord(value) || value.visible !== true || typeof value.intent !== 'string')
        return false;
      const observed = value.intent.replace(/\s+/gu, ' ').trim();
      return Boolean(expected && observed === expected);
    };
    return matches(hud.before) && matches(hud.after);
  });
  assert(
    captures.length,
    visualProof.hudRequired
      ? 'Live smoke has no capture tied to its proof with the rendered intent HUD observed before and after capture.'
      : 'Live smoke has no capture tied to its named proof.',
  );
  return captures.map((artifact) => artifact.path);
}

function teardownProofNodes(
  recipe: ProofDocument,
  nodes: ReadonlyMap<string, ProofNode>,
  target: string,
): string[] {
  const graph = extractWorkflowGraph(recipe);
  if (!graph.teardownEntry) return [];
  return [...nodes].flatMap(([id, node]) =>
    node.proves?.includes(target) && !graph.mainNodeIds.has(id.split('/')[0]!) ? [id] : [],
  );
}

const assertions = new Set(['assert_output', 'assert_json', 'ui.wait_for']);
const controls = new Set([
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
const inputs = new Set([
  'ui.press',
  'ui.key_press',
  'ui.set_input',
  'ui.swipe',
  'ui.drag',
  'ui.long_press',
]);

function isObservation(action: string): boolean {
  return !controls.has(action) && !assertions.has(action);
}

function assertionSource(id: string, node: ProofNode): string {
  const prefix = id.includes('/') ? id.slice(0, id.lastIndexOf('/') + 1) : '';
  return prefix + String(node.source ?? node.node ?? '');
}

function collectProofNodes(
  recipe: ProofDocument,
  documents: ReadonlyMap<string, ProofDocument>,
): Map<string, ProofNode> {
  const nodes = new Map<string, ProofNode>();
  function collect(document: ProofDocument, prefix = '', stack = new Set<string>()) {
    for (const [id, node] of Object.entries(document.workflow.nodes)) {
      nodes.set(prefix + id, node);
      if (node.action === 'call' && typeof node.ref === 'string') {
        const ref = normalizeRecipeRef(node.ref);
        assert(!stack.has(ref), 'Recursive recipe proof');
        const nested = documents.get(ref);
        assert(nested, `Missing resolved recipe ${ref}`);
        collect(nested, `${prefix}${id}/`, new Set(stack).add(ref));
      }
    }
  }
  collect(recipe);
  return nodes;
}

/**
 * Check possible proof bindings after protocol/dependency validation, without executing a graph.
 * A clean result is conditional: order, branches, successful observations and indexed artifacts
 * still require validateRuntimeProof on the executed package.
 */
export function validateRuntimeProofPlan(
  recipe: ProofDocument,
  documents: ReadonlyMap<string, ProofDocument> = new Map(),
  teardownTarget?: string,
  smokeTarget?: string,
): RecipeValidationFinding[] {
  const finding = (code: string, path: string, message: string): RecipeValidationFinding => ({
    severity: 'error',
    code,
    path,
    message,
  });
  if (!recipe.proofTargets?.length)
    return [
      finding(
        'proof.targets_missing',
        'proofTargets',
        'Behavioral proof requires at least one proof target.',
      ),
    ];
  const nodes = collectProofNodes(recipe, documents);
  const hasInput = [...nodes.values()].some((node) => inputs.has(node.action));
  function eligible(id: string): boolean {
    const node = nodes.get(id)!;
    if (node.action === 'call')
      return [...nodes.keys()].some((child) => child.startsWith(`${id}/`) && eligible(child));
    if (node.action === 'assert_output') {
      const source = nodes.get(assertionSource(id, node));
      return Boolean(source && isObservation(source.action));
    }
    // Inputs may live in a caller or a sibling call. Do not infer execution order here.
    if (node.action === 'ui.wait_for') return hasInput;
    // The manifest is created at execution; a path alone cannot prove it will be indexed.
    return node.action === 'assert_json' && typeof node.path === 'string';
  }
  const findings = recipe.proofTargets.flatMap((target, index) => {
    const linked = [...nodes].filter(([, node]) => node.proves?.includes(target.id));
    return linked.some(([id]) => eligible(id))
      ? []
      : [
          finding(
            'proof.no_runtime_assertion',
            `proofTargets[${index}]`,
            `Proof target ${target.id} has no potentially eligible runtime assertion. Bind proves to assert_output over an observation, ui.wait_for with an input action, assert_json over a proof artifact, or a call containing one. Runtime order, outcomes and artifact indexing remain unverified.`,
          ),
        ];
  });
  if (smokeTarget && !recipe.proofTargets.some((target) => target.id === smokeTarget)) {
    findings.push(
      finding(
        'proof.smoke_target_missing',
        'proofTargets',
        `Smoke target ${smokeTarget} is absent from the recipe.`,
      ),
    );
  }
  if (teardownTarget && !teardownProofNodes(recipe, nodes, teardownTarget).some(eligible)) {
    findings.push(
      finding(
        'proof.teardown_assertion_missing',
        'workflow.teardown',
        `Teardown target ${teardownTarget} needs a runtime assertion in the authored teardown.`,
      ),
    );
  }
  return findings;
}

/** The recipe shape proof checks read: its proof targets and workflow nodes. */
export interface ProofDocument {
  proofTargets?: { id: string }[];
  workflow: { nodes: Record<string, ProofNode> };
}
export interface ProofNode {
  action: string;
  ref?: string;
  proves?: string[];
  source?: string;
  node?: string;
  path?: string;
}
interface Entry {
  nodeId?: string;
  id?: string;
  action: string;
  ok: boolean;
  status?: string;
  output?: unknown;
  intent?: string;
}
