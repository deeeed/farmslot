import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  FamilyObservabilityArtifact,
  FamilyObservabilityRunSummary,
} from '@farmslot/protocol';

import {
  buildFamilyEvidenceGroups,
  buildFamilyLightboxPairs,
  familyEvidenceArtifactsForFilter,
  familyRunBadgeLabel,
  MAX_ARTIFACTS_PER_EVIDENCE_GROUP,
  MAX_EVIDENCE_GROUPS,
  visibleFamilyEvidenceArtifacts,
} from './family-observability-evidence.js';

type EvidenceRunFixture = Pick<
  FamilyObservabilityRunSummary,
  'runId' | 'flowType' | 'lane' | 'ticketOrPr' | 'slotId' | 'createdAt'
>;

type EvidenceArtifactFixture = Pick<
  FamilyObservabilityArtifact,
  'runId' | 'sourceRunId' | 'path' | 'purpose' | 'stepName' | 'familyId' | 'source'
>;

function run(overrides: Partial<EvidenceRunFixture> = {}): EvidenceRunFixture {
  return {
    runId: 'run-after',
    flowType: 'fix-bug',
    lane: 'production',
    ticketOrPr: 'DEMO-1',
    slotId: 'slot-1',
    createdAt: '2026-05-14T12:00:00.000Z',
    ...overrides,
  };
}

function artifact(
  path: string,
  purpose: string,
  overrides: Partial<EvidenceArtifactFixture> = {},
): EvidenceArtifactFixture {
  return {
    runId: 'run-after',
    path,
    purpose,
    stepName: 'capture',
    familyId: 'family-1',
    source: 'task-artifact',
    ...overrides,
  };
}

test('family evidence groups separate carried-over and current captures', () => {
  const snapshot = {
    evidence: [
      artifact('captures/2026-05-14_115800_before.png', 'BEFORE screenshot'),
      artifact('captures/2026-05-14_120300_after.png', 'AFTER screenshot'),
    ],
  };
  const runs = [run()];

  const groups = buildFamilyEvidenceGroups(
    snapshot,
    (a) => runs.find((r) => r.runId === a.runId) ?? null,
  );

  assert.equal(groups.length, 2);
  assert.equal(groups[0].capturedBeforeRun, false);
  assert.equal(groups[1].capturedBeforeRun, true);
  assert.equal(visibleFamilyEvidenceArtifacts(groups).length, 2);
});

test('family evidence groups use source run provenance before display run ids', () => {
  const source = run({
    runId: 'run-source',
    slotId: 'slot-source',
    createdAt: '2026-05-14T12:00:00.000Z',
  });
  const replay = run({
    runId: 'run-replay',
    lane: 'comparison',
    slotId: 'slot-replay',
    createdAt: '2026-05-14T12:05:00.000Z',
  });
  const snapshot = {
    evidence: [
      artifact('captures/2026-05-14_120700_after.png', 'AFTER screenshot', {
        runId: replay.runId,
        sourceRunId: source.runId,
      }),
    ],
  };

  const groups = buildFamilyEvidenceGroups(
    snapshot,
    (a) => [source, replay].find((r) => r.runId === (a.sourceRunId ?? a.runId)) ?? null,
  );

  assert.equal(groups.length, 1);
  assert.equal(groups[0].run?.runId, source.runId);
  assert.match(groups[0].subtitle, /source run run-sour/);
  assert.match(groups[0].subtitle, /slot slot-source/);
});

test('family lightbox pairs before and after captures by stem', () => {
  const pairs = buildFamilyLightboxPairs(
    [
      artifact('captures/before-login.png', 'BEFORE screenshot'),
      artifact('captures/after-login.png', 'AFTER screenshot'),
    ],
    (a) => ({ url: `/artifact/${a.path}`, path: a.path, purpose: a.purpose, caption: a.path }),
  );

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].stem, 'login');
  assert.equal(pairs[0].kind, 'image');
});

test('family lightbox pairs distinguish videos and ignore incomplete before-after pairs', () => {
  const pairs = buildFamilyLightboxPairs(
    [
      artifact('captures/before-flow.webm', 'BEFORE video'),
      artifact('captures/after-flow.webm', 'AFTER video'),
      artifact('captures/before-missing-after.png', 'BEFORE screenshot'),
    ],
    (a) => ({ url: `/artifact/${a.path}`, path: a.path, purpose: a.purpose, caption: a.path }),
  );

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].stem, 'flow');
  assert.equal(pairs[0].kind, 'video');
});

test('family lightbox uses shared artifact-kind and AC fallback pairing', () => {
  const pairs = buildFamilyLightboxPairs(
    [
      artifact('artifacts/after-ac1-market-detail-liq-distance.png', 'screenshot', {
        stepName: 'complete',
      }),
      artifact('artifacts/before-ac1-market-detail-no-liq-distance.png', 'screenshot-before', {
        stepName: null,
      }),
      artifact(
        'artifacts/screenshots/evidence-ac1-market-detail-liq-distance.png-123.png',
        'debug-screenshot',
        {
          stepName: null,
        },
      ),
    ],
    (a) => ({ url: `/artifact/${a.path}`, path: a.path, purpose: a.purpose, caption: a.path }),
  );

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].stem, 'ac1');
  assert.equal(pairs[0].before.path, 'artifacts/before-ac1-market-detail-no-liq-distance.png');
  assert.equal(pairs[0].after.path, 'artifacts/after-ac1-market-detail-liq-distance.png');
});

test('family run badge labels identify eval and comparison runs', () => {
  assert.equal(familyRunBadgeLabel(run({ lane: 'comparison', ticketOrPr: 'EVAL-demo' })), 'EVAL');
  assert.equal(familyRunBadgeLabel(run({ lane: 'comparison', ticketOrPr: 'DEMO-2' })), 'COMPARE');
});

test('family evidence grouping retains overflow while default visibility caps render output', () => {
  const snapshot = {
    evidence: Array.from({ length: MAX_EVIDENCE_GROUPS + 2 }, (_, groupIndex) =>
      Array.from({ length: MAX_ARTIFACTS_PER_EVIDENCE_GROUP + 2 }, (_, artifactIndex) =>
        artifact(
          `captures/2026-05-${String(14 - groupIndex).padStart(2, '0')}_120000_${artifactIndex}.png`,
          'AFTER screenshot',
          {
            runId: `run-${groupIndex}`,
          },
        ),
      ),
    ).flat(),
  };

  const groups = buildFamilyEvidenceGroups(snapshot, (a) =>
    run({ runId: a.runId, createdAt: '2026-05-14T12:00:00.000Z' }),
  );

  assert.equal(groups.length, MAX_EVIDENCE_GROUPS + 2);
  assert.equal(
    visibleFamilyEvidenceArtifacts(groups).length,
    MAX_EVIDENCE_GROUPS * MAX_ARTIFACTS_PER_EVIDENCE_GROUP,
  );
});

test('family evidence filter artifacts include matches beyond the default visible cap', () => {
  const snapshot = {
    evidence: Array.from({ length: MAX_EVIDENCE_GROUPS + 1 }, (_, index) =>
      artifact(
        index === MAX_EVIDENCE_GROUPS
          ? 'captures/2026-05-01_120000_full-run.webm'
          : `captures/2026-05-${String(20 - index).padStart(2, '0')}_120000_after.png`,
        index === MAX_EVIDENCE_GROUPS ? 'video' : 'AFTER screenshot',
        { runId: `run-${index}` },
      ),
    ),
  };
  const groups = buildFamilyEvidenceGroups(snapshot, (a) =>
    run({ runId: a.runId, createdAt: '2026-05-14T12:00:00.000Z' }),
  );

  assert.equal(familyEvidenceArtifactsForFilter(groups, 'all').length, MAX_EVIDENCE_GROUPS);
  assert.deepEqual(
    familyEvidenceArtifactsForFilter(groups, 'videos').map((artifact) => artifact.path),
    ['captures/2026-05-01_120000_full-run.webm'],
  );
});
