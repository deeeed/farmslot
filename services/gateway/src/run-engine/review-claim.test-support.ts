// ADR-062 Amendment 18 fixture: a passing recorded package with a state claim
// (AC-1) and a `review` claim (AC-2) that no node proves, plus the publication
// review that certifies a prepared package.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  digestRecipeDocument,
  type ReadyGatePrPackage,
  type RecipeClaimDeclaration,
  type RecipeClaimLedger,
  type ReviewStatus,
} from '@farmslot/protocol';

const state: RecipeClaimDeclaration = {
  id: 'AC-1',
  claim: 'The counter is one.',
  proofMode: 'state',
};
const review: RecipeClaimDeclaration = {
  id: 'AC-2',
  claim: 'The change is easy to revert.',
  proofMode: 'review',
};

/** A structured review result the gate reader accepts for a pass. */
export const PASSING_REVIEW_RESULT = JSON.stringify({
  schemaVersion: 1,
  verdict: 'pass',
  issues: [],
});

/** Writes the package files into `directory` and returns its engine ledger and file digests. */
export async function writeReviewClaimPackage(
  directory: string,
): Promise<{ claims: RecipeClaimLedger; files: Array<{ file: string; sha256: string }> }> {
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Counter proof',
    description: 'Observe the counter and verify its value.',
    proofTargets: [state, review],
    workflow: {
      entry: 'read',
      nodes: {
        read: { action: 'state_read', intent: 'Read counter', next: 'assert' },
        assert: {
          action: 'assert_output',
          source: 'read',
          assert: { path: '$.count', operator: 'eq', value: 1 },
          proves: ['AC-1'],
          intent: 'Verify counter',
          next: 'done',
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
  const invocation = {
    version: 1,
    recipeDigest: digestRecipeDocument(recipe),
    recipeRunId: 'review-claim-proof',
    startedAt: '2026-10-19T00:00:00Z',
    params: {},
    redactedPaths: [],
  };
  const row = (declaration: RecipeClaimDeclaration) => ({
    id: declaration.id,
    text: declaration.claim,
    kind: 'acceptance' as const,
    proofMode: declaration.proofMode!,
    verdict: 'awaiting-review' as const,
    recipeNodes: [],
    assertionIndices: [],
    moments: [],
    evidence: [],
  });
  const claims: RecipeClaimLedger = {
    schemaVersion: 2,
    recipeRunId: invocation.recipeRunId,
    criteria: [
      { ...row(state), verdict: 'proven', recipeNodes: ['assert'], assertionIndices: [1] },
      row(review),
    ],
    recording: { status: 'not-required', segments: [] },
  };
  const trace = [
    { nodeId: 'read', action: 'state_read', intent: 'Read counter', output: { count: 1 } },
    {
      nodeId: 'assert',
      action: 'assert_output',
      intent: 'Verify counter',
      output: { matched: true },
    },
    { nodeId: 'done', action: 'end', status: 'pass' },
  ].map((entry) => ({
    ...entry,
    ok: true,
    startedAt: invocation.startedAt,
    endedAt: invocation.startedAt,
    durationMs: 0,
  }));
  const documents = {
    'recipe.json': recipe,
    'recipe-invocation.json': invocation,
    'acceptance-status.json': claims,
    'recipe-resolution.json': {
      schema_version: 1,
      root: { ref: '$root', digest: digestRecipeDocument(recipe) },
      dependencies: [],
      edges: [],
    },
    'trace.json': { entries: trace },
    'summary.json': {
      recipeRunId: invocation.recipeRunId,
      status: 'pass',
      total: 3,
      passed: 3,
      failed: 0,
      cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
      invocationDigest: digestRecipeDocument(invocation),
    },
    'artifact-manifest.json': {
      version: 1,
      runStatus: 'pass',
      artifacts: [
        { path: 'recipe.json', type: 'recipe' },
        { path: 'trace.json', type: 'trace' },
        { path: 'summary.json', type: 'summary' },
        { path: 'acceptance-status.json', type: 'json' },
      ],
    },
  };
  const files: Array<{ file: string; sha256: string }> = [];
  for (const [file, document] of Object.entries(documents)) {
    const bytes = JSON.stringify(document);
    await writeFile(path.join(directory, file), bytes);
    files.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { claims, files };
}

/** A qualifying publication-review pass that certifies `prepared` at its head. */
export function certifyingReview(
  prepared: ReadyGatePrPackage,
  overrides: Partial<ReviewStatus> = {},
): ReviewStatus {
  return {
    id: 'review-1',
    source: 'human-gate',
    mode: 'cold',
    loopNumber: 1,
    reviewerSessionId: 'session-1',
    reviewedHeadSha: prepared.headSha,
    reviewedReviewSubjectHash: prepared.reviewSubjectHash,
    reviewSnapshot: prepared.reviewSnapshot,
    verdict: 'pass',
    unresolvedCount: 0,
    artifactPaths: ['artifacts/review-1/loop-1/review-result.json'],
    ...overrides,
  };
}

/** Another session's open finding at the same head. */
export function openFindingAtHead(prepared: ReadyGatePrPackage): ReviewStatus {
  return certifyingReview(prepared, {
    id: 'review-2',
    reviewerSessionId: 'session-2',
    verdict: 'issues',
    unresolvedCount: 1,
  });
}
