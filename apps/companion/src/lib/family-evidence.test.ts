import assert from 'node:assert/strict';
import test from 'node:test';

import type { FamilyObservabilityArtifact } from '@farmslot/protocol';

import {
  buildFamilyEvidenceGroups,
  familyArtifactKind,
  filterFamilyEvidenceGroups,
  isFamilyVideoArtifact,
  MAX_FAMILY_EVIDENCE_GROUPS,
  visibleFamilyEvidenceArtifacts,
} from './family-evidence';

function artifact(
  path: string,
  overrides: Partial<FamilyObservabilityArtifact> = {},
): FamilyObservabilityArtifact {
  return {
    runId: 'run-after',
    familyId: 'family-1',
    path,
    purpose: 'screenshot',
    sizeBytes: 100,
    source: 'artifact-manifest',
    ...overrides,
  };
}

test('family evidence groups by source run and capture batch', () => {
  const groups = buildFamilyEvidenceGroups(
    {
      evidence: [
        artifact('screens/2026-05-21_091500_before.png'),
        artifact('screens/2026-05-21_091500_after.png'),
        artifact('screens/2026-05-21_101500_after.png', { sourceRunId: 'run-followup' }),
      ],
    },
    (item) => ({
      runId: item.sourceRunId ?? item.runId,
      flowType: 'fix-bug',
      lane: 'production',
      ticketOrPr: 'PR #1',
      slotId: 'runner-mobile-1',
      createdAt: '2026-05-21T09:00:00.000Z',
      diffStat: { available: true, files: 1, additions: 2, deletions: 0 },
    }),
  );

  assert.equal(groups.length, 2);
  assert.equal(groups[0].artifacts.length, 1);
  assert.equal(groups[1].artifacts.length, 2);
  assert.match(groups[1].subtitle, /slot runner-mobile-1/);
});

test('family evidence filters before after review diff recipe and setup artifacts', () => {
  const evidence = [
    artifact('before-balance.png'),
    artifact('after-balance.png'),
    artifact('recordings/e2e-flow.webm', { purpose: 'recipe-recording' }),
    artifact('reports/review.md', { purpose: 'review-report' }),
    artifact('inputs/diff.txt', { purpose: 'diff' }),
    artifact('recipe/output.json', { purpose: 'recipe-output' }),
    artifact('orientation.png', { purpose: 'debug-screenshot' }),
  ];
  const groups = buildFamilyEvidenceGroups({ evidence }, () => null);

  assert.deepEqual(evidence.map(familyArtifactKind), [
    'before',
    'after',
    'recipes',
    'review',
    'diffs',
    'recipes',
    'setup',
  ]);
  assert.equal(filterFamilyEvidenceGroups(groups, 'before')[0].artifacts.length, 1);
  assert.equal(filterFamilyEvidenceGroups(groups, 'after')[0].artifacts.length, 1);
  assert.equal(filterFamilyEvidenceGroups(groups, 'videos')[0].artifacts.length, 1);
  assert.equal(filterFamilyEvidenceGroups(groups, 'review')[0].artifacts.length, 1);
  assert.equal(filterFamilyEvidenceGroups(groups, 'diffs')[0].artifacts.length, 1);
  assert.equal(filterFamilyEvidenceGroups(groups, 'recipes')[0].artifacts.length, 2);
  assert.equal(filterFamilyEvidenceGroups(groups, 'setup')[0].artifacts.length, 1);
  assert.equal(isFamilyVideoArtifact(evidence[2]), true);
  assert.equal(visibleFamilyEvidenceArtifacts(groups).length, 6);
});

test('family evidence filters search groups beyond the default visible cap', () => {
  const evidence = Array.from({ length: MAX_FAMILY_EVIDENCE_GROUPS + 1 }, (_, index) =>
    artifact(
      index === MAX_FAMILY_EVIDENCE_GROUPS
        ? `captures/2026-05-01_120000_older-video.webm`
        : `captures/2026-05-${String(20 - index).padStart(2, '0')}_120000_after.png`,
      { runId: `run-${index}`, purpose: index === MAX_FAMILY_EVIDENCE_GROUPS ? 'video' : 'after' },
    ),
  );
  const groups = buildFamilyEvidenceGroups({ evidence }, () => null);

  assert.equal(groups.length, MAX_FAMILY_EVIDENCE_GROUPS + 1);
  assert.equal(filterFamilyEvidenceGroups(groups, 'all').length, MAX_FAMILY_EVIDENCE_GROUPS);
  assert.equal(
    filterFamilyEvidenceGroups(groups, 'videos')[0].artifacts[0].path,
    evidence.at(-1)?.path,
  );
});
