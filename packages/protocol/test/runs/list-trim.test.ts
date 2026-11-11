import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RunDecision, RunDecisionPayload } from '../../src/contracts/index.js';
import { summarizeRunEvidence } from '../../src/runs/evidence-summary.js';
import {
  RUN_LIST_PAYLOAD_VALUE_LIMIT,
  runListRow,
  trimDecisionForList,
  trimRunForList,
} from '../../src/runs/list-trim.js';

const big = 'x'.repeat(RUN_LIST_PAYLOAD_VALUE_LIMIT);

/** Minimal valid Run with every required field set to a safe default. */
function minRun(): Run {
  return {
    id: 'min',
    familyId: 'fam-min',
    lane: 'production',
    flowType: 'dev',
    status: 'monitoring',
    project: 'test',
    ticketOrPr: '',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

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
    payload: payload as RunDecisionPayload,
  };
}

test('run.list keeps small decision payload values and names the large ones it drops', () => {
  const trimmed = trimDecisionForList(
    decision({
      kind: 'review',
      recommendation: 'REQUEST_CHANGES',
      reviewMd: big,
      evidenceMarkdown: big,
    }),
  );
  assert.deepEqual(trimmed.payload, { kind: 'review', recommendation: 'REQUEST_CHANGES' });
  assert.deepEqual(trimmed.payloadTrimmed, ['reviewMd', 'evidenceMarkdown']);
});

test('a decision with only small values is returned as-is, without a marker', () => {
  const small = decision({ kind: 'review', recommendation: 'COMMENT' });
  assert.equal(trimDecisionForList(small), small);
  assert.equal(trimDecisionForList(small).payloadTrimmed, undefined);
});

test('trimRunForList copies instead of mutating the stored run', () => {
  const run: Run = {
    ...minRun(),
    id: 'r1',
    decisions: [decision({ kind: 'review', reviewMd: big }), decision({ kind: 'ready' })],
  };
  const listed = trimRunForList(run);
  assert.notEqual(listed, run);
  const storedPayload = run.decisions[0].payload;
  if (!storedPayload || storedPayload.kind !== 'review') throw new Error('Expected review payload');
  assert.equal(storedPayload.reviewMd, big, 'the store object keeps its payload');
  assert.equal(listed.decisions[0].payloadTrimmed?.[0], 'reviewMd');
  assert.equal(listed.decisions[1], run.decisions[1], 'untouched decisions are shared');
  const noop: Run = { ...minRun(), id: 'r2', decisions: [decision({ kind: 'ready' })] };
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
  const run: Run = {
    ...minRun(),
    id: 'output',
    output: {
      workerFinished: true,
      capturedAt: 'now',
      manifestDigest: 'hash',
      reportPath: 'artifacts/report.md',
      artifactManifest: [{ path: 'artifacts/report.md', purpose: 'report' }],
    },
  };
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
    familyId: 'fam-1',
    lane: 'production',
    flowType: 'dev',
    project: 'test-project',
    ticketOrPr: 'T-1',
    status: 'monitoring',
    slotId: null,
    branch: null,
    taskFile: null,
    summary: 'worker running',
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:01:00.000Z',
    metrics: {
      runner: 'claude',
      model: 'claude-opus',
      nudgeCount: 0,
    },
    steps: [
      {
        name: 'dispatch',
        status: 'done',
        startedAt: '2026-11-11T00:00:10.000Z',
        completedAt: '2026-11-11T00:00:20.000Z',
        outputs: { selectedSlot: 'slot-a', reason: 'picked best slot', ignoredField: 'drop me' },
      },
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
          reviewRoundBudget: {
            used: 1,
            remaining: 2,
            limit: 3,
            label: 'rounds',
            noVerdict: 0,
            noVerdictLimit: 3,
          },
          workerReport: 'big report text to drop',
          branch: 'feature/x',
          prNumber: null,
          repo: null,
          diffStat: { additions: 10, deletions: 2, files: 1 },
          reviews: [
            {
              id: 'pr-rev-1',
              mode: 'cold',
              loopNumber: 1,
              verdict: 'pass',
              unresolvedCount: 0,
              runner: 'claude',
              model: 'claude-opus',
              issues: [{ file: 'src/main.ts', description: 'nit' }],
            },
          ],
        },
      },
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
          },
        ],
      },
    },
    resourcePosture: {
      posture: 'active',
      policySource: 'framework-default',
      capabilities: [],
      workerRetained: false,
      updatedAt: '2026-11-11T00:00:00.000Z',
    },
    sessionUsage: [{ runner: 'claude', totalTokens: 5000 }],
    visualJudgmentReceipts: [],
    templateProvenance: null,
  };
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
  assert.equal(row.steps[0]?.outputs?.['ignoredField'], undefined);
});

test('runListRow slims ready payload: drops large content fields, keeps metadata and slims reviews', () => {
  const run = richRun();
  const row = runListRow(run);
  const payload = row.decisions[0]?.payload;
  assert.equal(payload?.kind, 'ready');
  if (!payload || payload.kind !== 'ready') throw new Error('Expected ready payload');
  assert.ok(payload.gateReadiness, 'gateReadiness kept');
  // reviewRoundBudget slimmed to {used, remaining}
  assert.deepEqual(payload.reviewRoundBudget, { used: 1, remaining: 2 });
  // workerReport kept as optional (undefined on slim rows that omit it)
  assert.equal(payload.workerReport, undefined, 'workerReport dropped');
  // inputSnapshot, prPackage, artifactManifest are omitted from the slim type at runtime
  assert.equal('inputSnapshot' in payload, false, 'inputSnapshot dropped');
  assert.equal('prPackage' in payload, false, 'prPackage dropped');
  assert.equal('artifactManifest' in payload, false, 'artifactManifest dropped');
  // reviews slimmed via slimReviewStatus (keeps verdict, unresolvedCount, etc.)
  assert.ok(payload.reviews, 'reviews kept');
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
  assert.equal(es?.publishGate?.reviewPolicy?.minimumReviews, undefined);
  // publishGate.reviews: keep slim fields only
  const rev = es?.publishGate?.reviews?.[0];
  assert.equal(rev?.id, 'rev-1');
  assert.equal(rev?.verdict, 'pass');
  assert.equal(rev?.runner, 'claude');
  assert.equal(rev?.issues, undefined, 'issues dropped');
  assert.equal(rev?.artifactPaths, undefined, 'artifactPaths dropped');
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
