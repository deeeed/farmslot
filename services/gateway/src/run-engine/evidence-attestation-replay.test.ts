import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  buildRunResolveDecisionParams,
  type RunGateReadiness,
} from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const prerequisites = await import('./gate-prerequisites.js');
let checked: RunGateReadiness;
mock.module('./gate-prerequisites.js', {
  namedExports: { ...prerequisites, collectRunGateReadiness: async () => checked },
});
// Its transitive callers loaded the original before the owner-reader mock.
const freshEngine = './engine-decisions.js?attestation-replay';
const { createEngineDecision } = await import(freshEngine);
const { publicationGateDecisionActions } = await import('./gate-policy.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { makeReadyGatePackage, deleteTestRunIfPresent } = await import('./test-fixtures.js');

test(
  'restart replay consumes one attested approval and refuses a missing receipt',
  { timeout: 3000 },
  async (t) => {
    const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'REPLAY' });
    t.after(() => deleteTestRunIfPresent(run.id));
    const prepared = makeReadyGatePackage({
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
    });
    const actions = publicationGateDecisionActions({
      reviewSatisfied: true,
      preparedPackage: prepared,
    });
    assert.ok(actions.some((action) => action.id === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION));
    assert.ok(
      !publicationGateDecisionActions({ reviewSatisfied: true }).some(
        (action) => action.id === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
      ),
    );
    const decision = {
      id: 'gate',
      type: 'engine_human_gate' as const,
      title: 'Publish',
      description: 'Test',
      actions,
      createdAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
      resolvedAction: APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
      payload: {
        kind: 'ready' as const,
        branch: prepared.branch,
        prNumber: null,
        repo: null,
        workerReport: 'done',
        diffStat: prepared.diffStat,
        prPackage: prepared,
      },
    };
    const params = buildRunResolveDecisionParams({
      runId: run.id,
      decision,
      actionId: APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
      evidenceAttestationReason: 'Inspected the retained package.',
    });
    checked = {
      state: 'not-ready',
      identity: { runId: run.id, generation: 0, packageHash: prepared.packageHash },
      reasons: [
        {
          code: 'evidence-policy-unsatisfied',
          prerequisite: 'evidence',
          evidencePolicy: 'criterion-binding',
          message: 'Claim binding differs.',
        },
      ],
    };
    const saved = {
      ...decision,
      selectionData: params.selectionData,
      evidenceAttestation: {
        schemaVersion: 1 as const,
        runId: run.id,
        decisionId: decision.id,
        packageHash: prepared.packageHash,
        selectedEvidenceKeys: [],
        approver: { principalId: 'operator', displayName: 'Operator', credentialId: 'credential' },
        reason: params.evidenceAttestationReason!,
        approvedAt: decision.resolvedAt,
        waivedReasons: checked.reasons,
      },
    };
    updateRun(run.id, { status: 'human-gating', decisions: [saved] });
    assert.equal(
      await createEngineDecision(run.id, 'human_gate', 'Publish', actions, decision.payload),
      APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
    );
    assert.equal(getRun(run.id)!.decisions.length, 1);
    updateRun(run.id, { decisions: [{ ...saved, evidenceAttestation: undefined }] });
    await assert.rejects(
      createEngineDecision(run.id, 'human_gate', 'Publish', actions, decision.payload),
      /does not bind/,
    );
    assert.equal(getRun(run.id)!.decisions.length, 1);
  },
);
