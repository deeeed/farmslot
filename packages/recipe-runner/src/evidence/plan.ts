import {
  normalizeRecipeClaimId,
  normalizeRecipeRef,
  type RecipeClaimDeclaration,
  validateRecipeClaimDeclarations,
} from '@farmslot/protocol';

import {
  collectProofNodes,
  isProofObservation,
  potentiallyEligibleProof,
  proofAssertionSource,
  type ProofDocument,
  type ProofNode,
} from './assertions.js';

export interface RecipeEvidencePlan {
  declarations: RecipeClaimDeclaration[];
  nodes: Map<string, ProofNode>;
}

/** The resolved call path is the identity, even when the same library is called twice. */
export function planRecipeEvidence(
  root: ProofDocument,
  documents: ReadonlyMap<string, ProofDocument>,
  registered?: readonly RecipeClaimDeclaration[],
): RecipeEvidencePlan {
  const nodes = collectProofNodes(root, documents);
  const declarations = new Map<string, RecipeClaimDeclaration>();
  const register = (claim: RecipeClaimDeclaration, taskProjection = false) => {
    const previous = declarations.get(claim.id);
    if (previous && !taskProjection) throw new Error(`Duplicate qualified claim ${claim.id}.`);
    if (
      previous &&
      (previous.claim !== claim.claim ||
        (previous.kind ?? 'acceptance') !== (claim.kind ?? 'acceptance') ||
        (previous.proofMode && claim.proofMode && previous.proofMode !== claim.proofMode))
    )
      throw new Error(`Conflicting claim declaration ${claim.id}.`);
    declarations.set(claim.id, { ...previous, ...claim });
  };
  if (registered) {
    const validation = validateRecipeClaimDeclarations(registered);
    if (validation.status !== 'valid')
      throw new Error(validation.findings.map((finding) => finding.message).join('\n'));
  }
  const taskClaims = new Map(registered?.map((claim) => [normalizeRecipeClaimId(claim.id), claim]));
  for (const claim of taskClaims.values())
    register({ ...claim, id: normalizeRecipeClaimId(claim.id) });
  function visit(
    document: ProofDocument,
    prefix = '',
    bindings: Readonly<Record<string, string>> = {},
  ): void {
    const local = (document.proofTargets ?? []) as RecipeClaimDeclaration[];
    const validation = validateRecipeClaimDeclarations(local);
    if (validation.status !== 'valid')
      throw new Error(validation.findings.map((finding) => finding.message).join('\n'));
    const ids = new Map(
      local.map((claim) => {
        const id = normalizeRecipeClaimId(claim.id);
        return [id, bindings[id] ?? `${prefix}${id}`];
      }),
    );
    for (const id of Object.keys(bindings))
      if (!ids.has(id)) throw new Error(`Unknown child claim binding ${prefix}${id}.`);
    for (const claim of local) {
      const id = ids.get(normalizeRecipeClaimId(claim.id))!;
      const bound = bindings[normalizeRecipeClaimId(claim.id)];
      const task = !prefix ? taskClaims.get(id) : undefined;
      if (!prefix && registered && (claim.kind ?? 'acceptance') === 'acceptance' && !task)
        throw new Error(`Claim ${id} is not registered by the task.`);
      if (task && task.claim !== claim.claim)
        throw new Error(`Claim ${id} conflicts with the task expectation.`);
      if (!bound)
        register(
          {
            ...claim,
            id,
            ...(claim.parentId
              ? { parentId: ids.get(normalizeRecipeClaimId(claim.parentId))! }
              : {}),
          },
          Boolean(task),
        );
      else if (!declarations.has(bound)) throw new Error(`Unknown parent claim binding ${bound}.`);
    }
    for (const [localId, node] of Object.entries(document.workflow.nodes)) {
      const id = prefix + localId;
      const qualified = nodes.get(id)!;
      qualified.captureClaimBindings = Object.fromEntries([
        ...ids,
        ...(!prefix ? [...taskClaims.keys()].map((key) => [key, key] as const) : []),
      ]);
      qualified.proves = node.proves?.map((claim) => {
        const mapped = ids.get(normalizeRecipeClaimId(claim));
        if (!mapped) throw new Error(`Unknown claim ${claim} at ${id}.`);
        return mapped;
      });
      if (node.action !== 'call' || !node.ref) continue;
      const child = documents.get(normalizeRecipeRef(node.ref));
      if (!child) throw new Error(`Missing resolved recipe ${node.ref}.`);
      const raw = node.claimBindings as Record<string, string> | undefined;
      const childBindings = Object.fromEntries(
        Object.entries(raw ?? {}).map(([childId, parentId]) => {
          const parent = ids.get(normalizeRecipeClaimId(parentId));
          if (!parent) throw new Error(`Unknown claim binding ${parentId} at ${id}.`);
          return [normalizeRecipeClaimId(childId), parent];
        }),
      );
      visit(child, `${id}/`, childBindings);
    }
  }
  visit(root);
  for (const [id, node] of nodes)
    for (const claim of node.proves ?? [])
      if (declarations.get(claim)?.proofMode === 'review')
        throw new Error(`Node ${id} proves review claim ${claim}; only the code review checks it.`);
  for (const [id, node] of nodes)
    if (node.proves?.length && !potentiallyEligibleProof(id, nodes))
      throw new Error(`Node ${id} declares proof without an observation-bound expectation.`);
  return { declarations: [...declarations.values()], nodes };
}

/** Built-in observations that never appear on the app's recording: shell output and log reads. */
const OFF_SCREEN_OBSERVATIONS: ReadonlySet<string> = new Set(['command', 'watch_logs']);

/**
 * A visual or mixed claim is judged on the recording. One whose proof rests only on shell output
 * and file or log checks can never be confirmed there, so the gate would refuse it after the run:
 * it is refused here instead, before anything runs. The closure is every node the claim's proof
 * can rest on: the proving nodes of the claim and of its child claims, what they call, and the
 * sources they assert or re-read. Control and assertion nodes observe nothing themselves. Any
 * other observation, including an adapter's own app or UI query, keeps the declared mode.
 */
export function assertVisualClaimsObserveUi(plan: RecipeEvidencePlan): void {
  const refused: string[] = [];
  for (const claim of plan.declarations) {
    if (claim.proofMode !== 'visual' && claim.proofMode !== 'mixed') continue;
    const claims = new Set([claim.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const child of plan.declarations)
        if (child.parentId && claims.has(child.parentId) && !claims.has(child.id)) {
          claims.add(child.id);
          grew = true;
        }
    }
    const closure = new Set<string>();
    const add = (id: string) => {
      if (closure.has(id)) return;
      closure.add(id);
      const node = plan.nodes.get(id);
      if (node?.action === 'call')
        for (const child of plan.nodes.keys()) if (child.startsWith(`${id}/`)) add(child);
      if (node?.action === 'assert_output' || node?.action === 'state_read')
        add(proofAssertionSource(id, node));
    };
    for (const [id, node] of plan.nodes)
      if (node.proves?.some((proved) => claims.has(proved))) add(id);
    // A claim nothing proves is reported as missing by claim derivation, not here.
    if (!closure.size) continue;
    const onScreen = [...closure].some((id) => {
      const node = plan.nodes.get(id);
      // An unresolved source is the recipe's own validation to report; it never refuses here.
      if (!node) return true;
      if (node.action.startsWith('ui.')) return true;
      return (
        isProofObservation(node.action) &&
        node.action !== 'state_read' &&
        !OFF_SCREEN_OBSERVATIONS.has(node.action)
      );
    });
    if (!onScreen) refused.push(`${claim.id} (${claim.proofMode})`);
  }
  if (refused.length)
    throw new Error(
      `Only shell commands and file or log checks prove these visual or mixed claims, so the recording cannot show them: ${refused.join(', ')}. Prove each with a UI observation (ui.wait_for, or assert_output on a UI query), or declare proofMode state.`,
    );
}
