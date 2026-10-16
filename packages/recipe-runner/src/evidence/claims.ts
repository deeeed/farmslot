import {
  digestRecipeDocument,
  normalizeRecipeClaimId,
  type QualifiedRecipeVisualJudgment,
  type RecipeArtifactManifestEntry,
  type RecipeClaimDeclaration,
  type RecipeClaimEvidence,
  type RecipeClaimVerdict,
  type RecipeRecordingTimelineDocument,
  type RecipeVisualJudgment,
  type RecordingSegmentRef,
  validateRecipeClaimDeclarations,
  validVisualJudgmentReason,
} from '@farmslot/protocol';

import { reachableNodes } from '../core/graph.js';

import {
  executedProofIndices,
  type ProofNode,
  type ProofTraceEntry,
  qualifyProofNodeRef,
} from './assertions.js';
import { occurrenceRecordingCoverage } from './moments.js';

export interface DeriveRecipeClaimsInput {
  recipeRunId: string;
  declarations: readonly RecipeClaimDeclaration[];
  nodes: ReadonlyMap<string, ProofNode>;
  trace: readonly ProofTraceEntry[];
  artifacts: readonly RecipeArtifactManifestEntry[];
  segments: readonly RecordingSegmentRef[];
  timelines?: ReadonlyMap<string, RecipeRecordingTimelineDocument>;
  judgments?: readonly RecipeVisualJudgment[];
}

const parentVerdictOrder: readonly RecipeClaimVerdict[] = [
  'failed',
  'missing',
  'weak',
  'awaiting-review',
  'untestable',
];

/** Successful actions/captures are evidence, never the assertion that proves a claim. */
export function deriveRecipeClaims(
  input: DeriveRecipeClaimsInput,
  qualifiedJudgments: readonly QualifiedRecipeVisualJudgment[] = [],
): RecipeClaimEvidence[] {
  const validation = validateRecipeClaimDeclarations(input.declarations);
  if (validation.status !== 'valid')
    throw new Error(validation.findings.map((finding) => finding.message).join('\n'));
  const excluded = unselectedProofNodes(input.nodes, input.trace);
  const claims = input.declarations.map((declaration): RecipeClaimEvidence => {
    const id = normalizeRecipeClaimId(declaration.id);
    const recipeNodes = [...input.nodes]
      .filter(
        ([nodeId, node]) =>
          !excluded.has(nodeId) &&
          node.proves?.some((claim) => normalizeRecipeClaimId(claim) === id),
      )
      .map(([nodeId]) => nodeId);
    // Only declared retry groups may replace an earlier result. Repeated ordinary
    // occurrences remain required, so their failure cannot disappear.
    const required = new Map<string, (number | null)[]>();
    for (const nodeId of recipeNodes) {
      const node = input.nodes.get(nodeId)!;
      const group =
        typeof node.retryGroup === 'string'
          ? qualifyProofNodeRef(nodeId, `retry:${node.retryGroup}`)
          : nodeId;
      const occurrences = input.trace.flatMap((entry, index) => {
        if ((entry.nodeId ?? entry.id) !== nodeId) return [];
        const eligible = executedProofIndices(
          nodeId,
          input.nodes,
          input.trace,
          input.artifacts,
          index + 1,
        );
        return eligible.length ? eligible : [null];
      });
      const prior = required.get(group) ?? [];
      required.set(group, [...prior, ...(occurrences.length ? occurrences : [null])]);
    }
    const indices = [...required].flatMap(([group, values]) =>
      group.includes('retry:')
        ? values.at(-1) === null
          ? [null]
          : [
              values
                .filter((index): index is number => index !== null)
                .sort((a, b) => a - b)
                .at(-1) ?? null,
            ]
        : values,
    );
    const assertionIndices = [
      ...new Set(indices.filter((index): index is number => index !== null)),
    ];
    const uiProof =
      assertionIndices.some((index) => input.trace[index]?.action.startsWith('ui.')) ||
      recipeNodes.some((nodeId) =>
        [...input.nodes].some(
          ([id, node]) =>
            (id === nodeId || id.startsWith(`${nodeId}/`)) && node.action.startsWith('ui.'),
        ),
      );
    const proofMode = declaration.proofMode ?? (uiProof ? 'visual' : 'state');
    const momentData = assertionIndices.map((traceIndex) => ({
      traceIndex,
      ...occurrenceRecordingCoverage(traceIndex, input.segments, input.timelines),
    }));
    const timing =
      !input.segments.length || momentData.some((moment) => moment.timing === 'outside-recording')
        ? 'outside-recording'
        : momentData.some((moment) => moment.timing === 'untimed')
          ? 'untimed'
          : 'measured';
    let verdict: RecipeClaimVerdict;
    if (assertionIndices.some((index) => input.trace[index]?.ok === false)) verdict = 'failed';
    else if (!recipeNodes.length || indices.some((index) => index === null)) verdict = 'missing';
    else if (proofMode !== 'state' && timing === 'outside-recording') verdict = 'weak';
    else verdict = proofMode === 'state' ? 'proven' : 'awaiting-review';
    const assertionNodes = new Set(
      assertionIndices.map((index) => input.trace[index]?.nodeId ?? input.trace[index]?.id),
    );
    const media = new Set(
      momentData.flatMap((moment) => moment.segments.map((segment) => segment.videoPath)),
    );
    const assertionFiles = new Set(
      recipeNodes.flatMap((nodeId) =>
        typeof input.nodes.get(nodeId)?.path === 'string'
          ? [String(input.nodes.get(nodeId)!.path)]
          : [],
      ),
    );
    const evidence = input.artifacts
      .filter(
        (artifact) =>
          media.has(artifact.path) ||
          assertionFiles.has(artifact.path) ||
          (artifact.nodeId !== undefined &&
            (recipeNodes.includes(artifact.nodeId) || assertionNodes.has(artifact.nodeId))),
      )
      .map((artifact) => artifact.path);
    const moments = momentData.flatMap(({ traceIndex, segments }) =>
      segments.map((segment) => ({
        recipeRunId: input.recipeRunId,
        videoDigest: segment.videoDigest,
        traceIndex,
      })),
    );
    const qualified = qualifiedJudgments
      .filter((entry) => normalizeRecipeClaimId(entry.claimId) === id)
      .at(-1);
    const judgment =
      qualified ??
      input.judgments?.filter((entry) => normalizeRecipeClaimId(entry.claimId) === id).at(-1);
    if (verdict === 'awaiting-review' && judgment) {
      if (
        judgment.recipeRunId !== input.recipeRunId ||
        !judgment.actor.trim() ||
        !validVisualJudgmentReason(qualified?.kind, judgment.verdict, judgment.reason) ||
        !Number.isFinite(Date.parse(judgment.judgedAt)) ||
        digestRecipeDocument(judgment.moments) !== digestRecipeDocument(moments)
      )
        throw new Error(`Visual judgment for ${id} does not bind these retained moments.`);
      verdict = judgment.verdict === 'confirmed' ? 'proven' : 'failed';
    }
    return {
      id,
      text: declaration.claim,
      kind: declaration.kind ?? 'acceptance',
      ...(declaration.parentId ? { parentId: normalizeRecipeClaimId(declaration.parentId) } : {}),
      proofMode,
      verdict,
      recipeNodes,
      assertionIndices,
      evidence: [...new Set(evidence)],
      timing,
      moments,
      ...(verdict === 'missing' ? { note: 'A required executed expectation is missing.' } : {}),
    };
  });
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const resolved = new Set<string>();
  function aggregate(id: string): RecipeClaimEvidence {
    const claim = byId.get(id)!;
    if (resolved.has(id)) return claim;
    const children = claims
      .filter((child) => child.parentId === id)
      .map((child) => aggregate(child.id));
    if (children.length) {
      const verdicts = children.map((child) => child.verdict);
      if (claim.recipeNodes.length) verdicts.push(claim.verdict);
      claim.verdict = parentVerdictOrder.find((verdict) => verdicts.includes(verdict)) ?? 'proven';
      claim.recipeNodes = [
        ...new Set([...claim.recipeNodes, ...children.flatMap((child) => child.recipeNodes)]),
      ];
      claim.assertionIndices = [
        ...new Set([
          ...claim.assertionIndices,
          ...children.flatMap((child) => child.assertionIndices),
        ]),
      ];
      claim.evidence = [
        ...new Set([...claim.evidence, ...children.flatMap((child) => child.evidence)]),
      ];
      claim.moments = [...claim.moments, ...children.flatMap((child) => child.moments)];
      claim.timing = children.some((child) => child.timing === 'outside-recording')
        ? 'outside-recording'
        : children.some((child) => child.timing === 'untimed')
          ? 'untimed'
          : 'measured';
      if (claim.verdict !== 'missing') delete claim.note;
    }
    resolved.add(id);
    return claim;
  }
  return claims.map((claim) => aggregate(claim.id));
}

/** Reuse the engine's graph traversal: an unselected branch is not a skipped required check. */
function unselectedProofNodes(
  nodes: ReadonlyMap<string, ProofNode>,
  trace: readonly ProofTraceEntry[],
): Set<string> {
  const qualified = Object.fromEntries(
    [...nodes].map(([id, node]) => [
      id,
      {
        ...node,
        ...(node.next ? { next: qualifyProofNodeRef(id, node.next) } : {}),
        ...(node.default ? { default: qualifyProofNodeRef(id, node.default) } : {}),
        ...(node.cases
          ? {
              cases: Object.fromEntries(
                Object.entries(node.cases).map(([key, target]) => [
                  key,
                  qualifyProofNodeRef(id, target),
                ]),
              ),
            }
          : {}),
      },
    ]),
  );
  const excluded = new Set<string>();
  for (const entry of trace) {
    const id = entry.nodeId ?? entry.id;
    if (!id || !entry.next) continue;
    const node = qualified[id];
    if (!node?.cases) continue;
    const selected = qualifyProofNodeRef(id, entry.next);
    const selectedNodes = reachableNodes(qualified, selected);
    const otherTargets = [...Object.values(node.cases), ...(node.default ? [node.default] : [])];
    for (const target of otherTargets) {
      if (target === selected) continue;
      for (const other of reachableNodes(qualified, target)) {
        if (!selectedNodes.has(other)) excluded.add(other);
      }
    }
  }
  for (const id of nodes.keys())
    if ([...excluded].some((parent) => id.startsWith(`${parent}/`))) excluded.add(id);
  return excluded;
}
