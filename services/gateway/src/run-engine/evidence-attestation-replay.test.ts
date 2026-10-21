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
const { createEngineDecision, resolveEngineDecision } = await import(freshEngine);
const { publicationGateDecisionActions } = await import('./gate-policy.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { makeReadyGatePackage, deleteTestRunIfPresent } = await import('./test-fixtures.js');

test(
  'new gate remedies use the offered actions without changing the assessment or definitions',
  { timeout: 3000 },
  async (t) => {
    for (const continuing of [false, true]) {
      const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'GATE-PARITY' });
      t.after(() => deleteTestRunIfPresent(run.id));
      const actions = [
        { id: 'hold', label: 'Hold', style: 'secondary' as const },
        ...(continuing
          ? [{ id: 'continue-review-fix', label: 'Continue fixing', style: 'primary' as const }]
          : []),
      ];
      checked = {
        state: 'not-ready',
        identity: { runId: run.id, generation: 0 },
        reasons: [
          {
            code: 'review-fix-required',
            prerequisite: 'review',
            message: 'Review found 2 issues. Fix and pass review before publishing.',
            actionId: 'continue-review-fix',
          },
        ],
      };
      const original = structuredClone(checked);
      const waiter = createEngineDecision(
        run.id,
        'human_gate',
        'Publish',
        actions,
        {
          kind: 'ready',
          prNumber: null,
          repo: null,
          workerReport: 'done',
          branch: 'feature',
          diffStat: { files: 0, additions: 0, deletions: 0 },
        },
        { readProgress: async () => ({ kind: 'idle' }) },
      );
      let gateId: string | undefined;
      try {
        const deadline = Date.now() + 1000;
        while (!getRun(run.id)?.decisions.length) {
          if (Date.now() > deadline) throw new Error('Fixture gate did not open');
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const gate = getRun(run.id)!.decisions[0];
        gateId = gate.id;
        if (gate.payload?.kind !== 'ready') throw new Error('Expected ready gate');
        assert.equal(
          gate.payload.gateReadiness?.reasons[0].actionId,
          continuing ? 'continue-review-fix' : undefined,
        );
        assert.deepEqual(gate.actions, actions);
        assert.deepEqual(gate.context?.gateActions, actions);
        assert.deepEqual(checked, original);
      } finally {
        if (gateId) resolveEngineDecision(gateId, 'hold');
        await waiter;
      }
    }
  },
);

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
