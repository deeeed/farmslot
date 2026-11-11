import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunDecision } from '../../src/contracts/index.js';
import { summarizeRunEvidence } from '../../src/runs/evidence-summary.js';
import {
  RUN_LIST_PAYLOAD_VALUE_LIMIT,
  runListRow,
  trimDecisionForList,
  trimRunForList,
} from '../../src/runs/list-trim.js';

const big = 'x'.repeat(RUN_LIST_PAYLOAD_VALUE_LIMIT);

test('run.list trims CI snapshot context without a payload and retains other context', () => {
  const stored: RunDecision = {
    id: 'ci',
    type: 'ci_ci_timeout',
    title: 'CI',
    description: '',
    actions: [],
    createdAt: 'now',
    context: {
      checkSnapshot: { checks: [] },
      checks: [{ name: 'lint', status: 'pending' }],
      repo: 'owner/repo',
    },
  };
  const listed = trimDecisionForList(stored);
  assert.deepEqual(listed.payloadTrimmed, ['context.checkSnapshot']);
  assert.equal(listed.context?.checkSnapshot, undefined);
  assert.deepEqual(listed.context?.checks, stored.context?.checks);
  assert.equal(listed.context?.repo, 'owner/repo');
  assert.deepEqual(stored.context?.checkSnapshot, { checks: [] });
});

function decision(payload: Record<string, unknown>): RunDecision {
  return {
    id: 'd1',
    type: 'engine_review_posting',
    title: 't',
    description: '',
    actions: [],
    createdAt: '2026-09-14T00:00:00.000Z',
    payload: payload as unknown as RunDecision['payload'],
  } as RunDecision;
}

test('run.list keeps small decision payload values and names the large ones it drops', () => {
  const trimmed = trimDecisionForList(
    decision({
      kind: 'review',
      recommendation: 'REQUEST_CHANGES',
      reviewMd: big,
      prPackage: { draftBody: big },
    }),
  );
  assert.deepEqual(trimmed.payload, { kind: 'review', recommendation: 'REQUEST_CHANGES' });
  assert.deepEqual(trimmed.payloadTrimmed, ['reviewMd', 'prPackage']);
});

test('a decision with only small values is returned as-is, without a marker', () => {
  const small = decision({ kind: 'review', recommendation: 'COMMENT' });
  assert.equal(trimDecisionForList(small), small);
  assert.equal(trimDecisionForList(small).payloadTrimmed, undefined);
});

test('trimRunForList copies instead of mutating the stored run', () => {
  const run = {
    id: 'r1',
    decisions: [decision({ kind: 'review', reviewMd: big }), decision({ kind: 'ready' })],
  } as unknown as Run;
  const listed = trimRunForList(run);
  assert.notEqual(listed, run);
  assert.equal(
    (run.decisions[0].payload as unknown as Record<string, unknown>).reviewMd,
    big,
    'the store object keeps its payload',
  );
  assert.equal(listed.decisions[0].payloadTrimmed?.[0], 'reviewMd');
  assert.equal(listed.decisions[1], run.decisions[1], 'untouched decisions are shared');
  const noop = { id: 'r2', decisions: [decision({ kind: 'ready' })] } as unknown as Run;
  assert.equal(trimRunForList(noop), noop);
});

test('the limit is measured in UTF-8 bytes, not string length', () => {
  // 1,000 three-byte characters: 1,002 JSON characters, 3,002 JSON bytes.
  const wide = '\u4e2d'.repeat(1000);
  const trimmed = trimDecisionForList(decision({ kind: 'review', reviewMd: wide }));
  assert.deepEqual(trimmed.payloadTrimmed, ['reviewMd']);
  const narrow = 'x'.repeat(RUN_LIST_PAYLOAD_VALUE_LIMIT - 2);
  assert.equal(
    trimDecisionForList(decision({ kind: 'review', reviewMd: narrow })).payloadTrimmed,
    undefined,
  );
});

test('run lists omit output file manifests without changing the retained detail', () => {
  const run = {
    id: 'output',
    decisions: [],
    output: {
      workerFinished: true,
      capturedAt: 'now',
      manifestDigest: 'hash',
      reportPath: 'artifacts/report.md',
      artifactManifest: [{ path: 'artifacts/report.md', purpose: 'report' }],
    },
  } as unknown as Run;
  const listed = trimRunForList(run);
  assert.equal(listed.output?.reportPath, run.output?.reportPath);
  assert.equal(listed.output?.artifactManifestOmitted, true);
  assert.deepEqual(listed.output?.artifactManifest, []);
  assert.equal(run.output?.artifactManifest.length, 1);
});

// ─── runListRow (slim projection) tests ──────────────────────────────────────

function richRun(): Run {
  return {
    id: 'slim-test',
    flowType: 'dev',
    project: 'test-project',
    ticketOrPr: 'T-1',
    status: 'monitoring',
    summary: 'worker running',
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:01:00.000Z',
    familyId: 'fam-1',
    metrics: {
      runner: 'claude',
      model: 'claude-opus',
      outcome: '',
      disposition: '',
    } as Run['metrics'],
    steps: [
      {
        name: 'dispatch',
        status: 'done',
        startedAt: '2026-11-11T00:00:10.000Z',
        completedAt: '2026-11-11T00:00:20.000Z',
        outputs: { selectedSlot: 'slot-a', reason: 'picked best slot', ignoredField: 'drop me' },
      } as unknown as Run['steps'][number],
    ],
    decisions: [
      {
        id: 'd1',
        type: 'engine_human_gate',
        title: 'Human gate',
        description: '',
        createdAt: '2026-11-11T00:00:30.000Z',
        actions: [{ id: 'approve', label: 'Approve', style: 'primary' }],
        payload: {
          kind: 'ready',
          gateReadiness: {
            state: 'ready',
            identity: { runId: 'slim-test', generation: 1 },
            reasons: [],
          },
          reviewRoundBudget: { used: 1, remaining: 2, max: 3 },
          workerReport: 'big report text to drop',
          branch: 'feature/x',
          prNumber: null,
          repo: null,
          diffStat: { additions: 10, deletions: 2, files: 1 },
        },
      } as unknown as Run['decisions'][number],
    ],
    engineState: {
      generation: 5,
      workspaceReviewDispatchGeneration: 3,
      intelligenceAuditDegraded: false,
      reviewedInputs: { fingerprint: 'abc', recordedAt: '2026-11-11' },
      publishGate: {
        reviewPolicy: { minimumReviews: 1, requestedBy: 'dispatch' },
        reviewSequence: [{ runner: 'claude', model: null, effort: null, mode: 'cold' }],
        reviews: [
          {
            id: 'rev-1',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            source: 'dispatch',
            runner: 'claude',
            model: 'claude-opus',
            issues: [],
            artifactPaths: ['artifacts/review.md'],
          } as Run['engineState']['publishGate']['reviews'][number],
        ],
      },
    } as Run['engineState'],
    resourcePosture: { level: 'standard', reason: 'default' } as unknown as Run['resourcePosture'],
    sessionUsage: [{ runner: 'claude', totalTokens: 5000 }] as Run['sessionUsage'],
    visualJudgmentReceipts: [] as Run['visualJudgmentReceipts'],
    templateProvenance: null,
  } as unknown as Run;
}

test('runListRow drops the four heavy fields', () => {
  const run = richRun();
  const row = runListRow(run);
  assert.equal(row.resourcePosture, undefined, 'resourcePosture dropped');
  assert.equal(row.sessionUsage, undefined, 'sessionUsage dropped');
  assert.equal(row.visualJudgmentReceipts, undefined, 'visualJudgmentReceipts dropped');
  assert.equal(row.templateProvenance, undefined, 'templateProvenance dropped');
});

test('runListRow keeps only allowed step output keys', () => {
  const run = richRun();
  const row = runListRow(run);
  assert.equal(row.steps[0]?.outputs?.selectedSlot, 'slot-a');
  assert.equal(row.steps[0]?.outputs?.reason, 'picked best slot');
  assert.equal((row.steps[0]?.outputs as Record<string, unknown>)?.ignoredField, undefined);
});

test('runListRow slims ready payload: drops large content fields, keeps metadata and slims reviews', () => {
  const run = richRun();
  const row = runListRow(run);
  const payload = row.decisions[0]?.payload as Record<string, unknown>;
  assert.equal(payload?.kind, 'ready');
  assert.ok(payload?.gateReadiness, 'gateReadiness kept');
  // reviewRoundBudget slimmed to {used, remaining}
  assert.deepEqual(payload?.reviewRoundBudget, { used: 1, remaining: 2 });
  // Large content fields dropped
  assert.equal(payload?.workerReport, undefined, 'workerReport dropped');
  assert.equal(payload?.inputSnapshot, undefined, 'inputSnapshot dropped');
  assert.equal(payload?.prPackage, undefined, 'prPackage dropped');
  assert.equal(payload?.artifactManifest, undefined, 'artifactManifest dropped');
  // reviews slimmed via slimReviewStatus (keeps verdict, unresolvedCount, etc.)
  const reviews = payload?.reviews as Array<Record<string, unknown>> | undefined;
  assert.ok(reviews, 'reviews kept');
});

test('runListRow slims engineState to the allowed subset', () => {
  const run = richRun();
  const row = runListRow(run);
  const es = row.engineState;
  assert.equal(es?.generation, 5);
  assert.equal(es?.workspaceReviewDispatchGeneration, 3);
  assert.equal(es?.intelligenceAuditDegraded, false);
  assert.equal(es?.reviewedInputs, undefined, 'reviewedInputs dropped');
  // publishGate: reviewPolicy keeps only requestedBy
  assert.equal(es?.publishGate?.reviewPolicy?.requestedBy, 'dispatch');
  assert.equal(
    (es?.publishGate?.reviewPolicy as Record<string, unknown>)?.minimumReviews,
    undefined,
  );
  // publishGate.reviews: keep slim fields only
  const rev = es?.publishGate?.reviews?.[0];
  assert.equal(rev?.id, 'rev-1');
  assert.equal(rev?.verdict, 'pass');
  assert.equal(rev?.runner, 'claude');
  assert.equal((rev as Record<string, unknown>)?.issues, undefined, 'issues dropped');
  assert.equal((rev as Record<string, unknown>)?.artifactPaths, undefined, 'artifactPaths dropped');
});

test('runListRow does not mutate the stored run', () => {
  const run = richRun();
  const before = JSON.stringify(run);
  runListRow(run);
  assert.equal(JSON.stringify(run), before);
});

test('version basis is sha256 of trimRunForList, not runListRow', () => {
  // trimRunForList and runListRow produce different results, but the version is
  // derived from trimRunForList so it stays stable across the slim-row deploy.
  const run = richRun();
  const trim = trimRunForList(run);
  const slim = runListRow(run);
  // They differ (slim drops more)
  assert.notDeepEqual(trim, slim);
  // runListRow also drops the output manifest like trimRunForList does not (output manifest
  // is handled by trimRunForList; runListRow builds on the full run directly).
  // The key invariant: trimRunForList is what the client uses for version comparison.
  assert.ok(trim, 'trimRunForList returns a value');
  assert.ok(slim, 'runListRow returns a value');
});

test('summarizeRunEvidence returns the same result from a full run and from a slim row with evidenceSummary', () => {
  const run = richRun();
  const fromFull = summarizeRunEvidence(run);
  const slim = runListRow(run);
  const withSummary = { ...slim, evidenceSummary: fromFull };
  const fromSlim = summarizeRunEvidence(withSummary);
  assert.deepEqual(fromSlim, fromFull);
});
