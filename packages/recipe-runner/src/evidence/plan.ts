import {
  normalizeRecipeClaimId,
  normalizeRecipeRef,
  type RecipeClaimDeclaration,
  validateRecipeClaimDeclarations,
} from '@farmslot/protocol';

import {
  collectProofNodes,
  potentiallyEligibleProof,
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
    if (node.proves?.length && !potentiallyEligibleProof(id, nodes))
      throw new Error(`Node ${id} declares proof without an observation-bound expectation.`);
  return { declarations: [...declarations.values()], nodes };
}
