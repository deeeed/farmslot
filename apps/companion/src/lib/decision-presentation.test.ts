import assert from 'node:assert/strict';

import {
  artifactsForRecipeRun,
  artifactSource,
  artifactUrl,
  classifyArtifact,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  dedupeArtifacts,
  extractRunArtifactManifest,
  formatVisualArtifactPairLabel,
  groupVisualArtifactPairs,
  inferArtifactPurpose,
  resolveRecipeRunSelection,
} from './artifact-url';
import { type PendingDecisionLike, presentDecision } from './decision-presentation';
import {
  decisionPresentationFixtures,
  retrospectiveDecisionFixture,
} from './decision-presentation.fixtures';

function reviewDecision(recommendation: string): PendingDecisionLike {
  return {
    id: `review-${recommendation}`,
    type: 'review_comments',
    slotId: 'runner-browser-1',
    title: 'Review gate',
    description: 'Review summary',
    context: {},
    createdAt: '2026-05-16T00:00:00.000Z',
    actions: [],
    payload: {
      kind: 'review',
      prNumber: 97,
      repo: 'deeeed/farmslot',
      recommendation,
      reviewMd: 'Review body',
      lineComments: [],
    },
  };
}

assert.equal(
  decisionPresentationFixtures.length,
  4,
  'decision presentation fixtures should execute representative payloads',
);

assert.equal(
  presentDecision(reviewDecision('disapprove')).tone,
  'fail',
  'review tone should not treat disapprove as approve',
);
assert.equal(
  presentDecision(reviewDecision('APPROVE')).tone,
  'ok',
  'review tone should approve canonical approve tokens',
);
assert.equal(
  presentDecision(reviewDecision('REQUEST_CHANGES')).tone,
  'fail',
  'review tone should fail canonical request-changes recommendations',
);
assert.equal(
  presentDecision(reviewDecision('do not approve')).tone,
  'fail',
  'review tone should not approve negated approve phrases',
);
assert.equal(
  presentDecision(reviewDecision('I do not approve this change')).tone,
  'fail',
  'review tone should use token boundaries for negated approval sentences',
);
assert.equal(
  presentDecision({
    ...reviewDecision('APPROVE'),
    runMeta: {
      runId: 'run-1',
      familyId: 'family-1',
      flowType: 'fix-bug',
      ticketOrPr: 'ORG/repo#1',
    },
  }).familyId,
  'family-1',
  'decision presentation should carry family id for review workspace navigation',
);
assert.equal(
  presentDecision({
    ...reviewDecision('APPROVE'),
    context: { project: 'example-mobile-farm' },
  }).project,
  'example-mobile-farm',
  'decision presentation should carry project scope for family workspace navigation',
);

{
  const retro = decisionPresentationFixtures[2];
  assert.deepEqual(
    retro.highlights.map((item) => [item.label, item.value]),
    [
      ['Outcome', 'success'],
      ['CI', '12/12'],
      ['Comments', '2/2 fixed'],
      ['Actions', '2'],
    ],
    'retrospective decisions should surface CI, comments, and action-effect counters',
  );
  assert(
    retro.textSections.some(
      (section) =>
        section.title === 'Action effects' &&
        section.body.includes('`save`') &&
        section.body.includes('No rerun needed'),
    ),
    'retrospective decisions should render action effects as a report section',
  );
  assert(
    retro.textSections.some(
      (section) =>
        section.title === 'Comments triage' &&
        section.body.includes('False positive: 1') &&
        section.body.includes('src/terminal.ts'),
    ),
    'retrospective decisions should render comments triage details',
  );
}

{
  const retro = presentDecision({
    ...retrospectiveDecisionFixture,
    context: {
      runId: 'run-retro-1',
      familyId: 'family-1',
      artifactManifest: [
        { path: 'artifacts/before-market.png', purpose: 'screenshot-before' },
        { path: 'artifacts/after-market.png', purpose: 'screenshot-after' },
        { path: 'artifacts/report.md', purpose: 'report' },
      ],
    },
  });
  assert.deepEqual(
    retro.artifactManifest.map((artifact) => artifact.path),
    ['artifacts/before-market.png', 'artifacts/after-market.png', 'artifacts/report.md'],
    'retrospective presentation should use run-context artifacts as evidence fallback',
  );
  assert(
    retro.highlights.some(
      (highlight) => highlight.label === 'Before→After' && highlight.value === '1 pair',
    ),
    'retrospective context evidence should drive visual-pair highlights',
  );
}

assert.deepEqual(
  artifactSource('https://example.test/artifact.png', { Authorization: 'Bearer dev-token' }),
  {
    uri: 'https://example.test/artifact.png?token=dev-token',
    headers: { Authorization: 'Bearer dev-token' },
  },
  'artifact sources should carry auth headers and query token for protected native media loads',
);
assert.deepEqual(
  artifactSource('https://example.test/artifact.png?token=existing', {
    Authorization: 'Bearer dev-token',
  }),
  {
    uri: 'https://example.test/artifact.png?token=existing',
    headers: { Authorization: 'Bearer dev-token' },
  },
  'artifact sources should not replace an existing query token',
);
assert.deepEqual(
  artifactSource('https://example.test/artifact.png'),
  { uri: 'https://example.test/artifact.png' },
  'artifact sources should omit empty headers for public/local media loads',
);

const bareSentinelPairs = groupVisualArtifactPairs(
  [
    { path: 'before.png', purpose: 'screenshot' },
    { path: 'after.png', purpose: 'screenshot' },
  ],
  (artifact) => artifact.path,
);
assert.equal(
  bareSentinelPairs.pairs.length,
  0,
  'bare before→after sentinels should not collapse into an empty-stem pair',
);

const namedPairs = groupVisualArtifactPairs(
  [
    { path: 'before-market.png', purpose: 'screenshot' },
    { path: 'after-market.png', purpose: 'screenshot' },
  ],
  (artifact) => artifact.path,
);
assert.equal(namedPairs.pairs.length, 1, 'named before→after visuals should still pair');
assert.equal(
  namedPairs.pairs[0]?.stem,
  'market',
  'named before→after visual pairs should expose the comparison stem',
);
assert.equal(
  formatVisualArtifactPairLabel(namedPairs.pairs[0]!),
  'market',
  'mobile comparison labels should use the stable pairing stem instead of raw filenames',
);

const acFallbackPairs = groupVisualArtifactPairs(
  [
    {
      path: 'artifacts/before-ac1-market-detail-no-liq-distance.png',
      purpose: 'screenshot-before',
      stepName: null,
      runId: 'run-1',
    },
    {
      path: 'artifacts/after-ac1-market-detail-liq-distance.png',
      purpose: 'screenshot',
      stepName: 'complete',
      runId: 'run-1',
    },
  ],
  (artifact) => artifact.path,
);
assert.equal(
  acFallbackPairs.pairs.length,
  1,
  'AC-number fallback should pair before→after visuals across different step names',
);
assert.equal(
  acFallbackPairs.pairs[0]?.stem,
  'ac1',
  'AC fallback pairs should expose their acceptance-criteria key as the comparison stem',
);
assert.equal(
  formatVisualArtifactPairLabel(acFallbackPairs.pairs[0]!),
  'AC1',
  'AC fallback labels should be compact enough for mobile evidence cards',
);

assert.equal(
  inferArtifactPurpose('artifacts/evidence/diff-screenshot.png'),
  'screenshot',
  'screenshot evidence should not be reclassified as a diff because its filename mentions diff',
);
assert.equal(
  inferArtifactPurpose('artifacts/review.patch'),
  'diff',
  'patch artifacts should still be classified as diffs',
);
assert.equal(
  classifyArtifact({
    path: 'artifacts/screenshots/live-proof',
    purpose: 'proof',
    type: 'screenshot',
    mimeType: 'image/png',
  }),
  'image',
  'typed artifact metadata should classify extensionless screenshots as images',
);
assert.equal(
  classifyArtifact({
    path: 'artifacts/trace',
    purpose: 'trace',
    type: 'trace',
    mimeType: 'application/json',
  }),
  'document',
  'typed artifact metadata should classify extensionless trace artifacts as documents',
);
assert.equal(
  classifyArtifact({
    path: 'artifacts/performance/cpu-samples',
    purpose: 'metric',
    type: 'metric',
  }),
  'document',
  'typed artifact metadata should classify extensionless metrics as documents',
);
assert.equal(
  classifyArtifact({
    path: 'artifacts/capture.bin',
    purpose: 'screenshot',
    type: 'video',
    mimeType: 'image/png',
  }),
  'video',
  'explicit typed artifact metadata should win over conflicting MIME metadata',
);

assert.deepEqual(
  dedupeArtifacts([
    { path: 'artifacts/replay.mp4', purpose: 'video' },
    { path: 'artifacts/replay.mp4', purpose: 'video-before' },
  ]),
  [{ path: 'artifacts/replay.mp4', purpose: 'video-before' }],
  'dedupe should keep the more specific purpose when manifests reuse a path',
);
assert.deepEqual(
  dedupeArtifacts([
    { path: 'artifacts/metrics/cpu', purpose: 'other' },
    {
      path: 'artifacts/metrics/cpu',
      purpose: 'metric',
      type: 'metric',
      label: 'CPU samples',
      nodeId: 'profile-backend',
      mimeType: 'application/json',
    },
  ]),
  [
    {
      path: 'artifacts/metrics/cpu',
      purpose: 'metric',
      type: 'metric',
      label: 'CPU samples',
      nodeId: 'profile-backend',
      mimeType: 'application/json',
    },
  ],
  'dedupe should preserve typed metadata when duplicate artifact paths merge',
);
assert.deepEqual(
  dedupeArtifacts([
    {
      path: 'artifacts/summary',
      purpose: 'report',
      type: 'summary',
      label: 'Summary',
      mimeType: 'application/json',
    },
    { path: 'artifacts/summary', purpose: 'other' },
  ]),
  [
    {
      path: 'artifacts/summary',
      purpose: 'report',
      type: 'summary',
      label: 'Summary',
      mimeType: 'application/json',
    },
  ],
  'dedupe should not erase typed metadata when a weaker duplicate appears later',
);
assert.deepEqual(
  dedupeArtifacts([
    {
      path: 'artifacts/summary',
      purpose: 'report',
      type: 'summary',
      label: 'Summary',
      mimeType: 'application/json',
    },
    {
      path: 'artifacts/summary',
      purpose: 'other',
      type: 'log',
      label: 'Weak duplicate',
      mimeType: 'text/plain',
    },
  ]),
  [
    {
      path: 'artifacts/summary',
      purpose: 'report',
      type: 'summary',
      label: 'Summary',
      mimeType: 'application/json',
    },
  ],
  'dedupe should not let weaker duplicate metadata overwrite a stronger artifact record',
);

assert.equal(
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  'current-artifacts',
  'current recipe artifact route param should match the gateway group id',
);

assert.equal(
  resolveRecipeRunSelection([{ id: 'attempt' }, { id: 'promoted' }], 'attempt', 'promoted'),
  'attempt',
  'recipe run selection should honor a valid requested id first',
);
assert.equal(
  resolveRecipeRunSelection(
    [{ id: 'current-artifacts' }, { id: 'live-run:recipe-1234' }],
    'live-run:recipe-1234',
    'current-artifacts',
  ),
  'live-run:recipe-1234',
  'recipe run selection should honor live-run ids built from recipe rerun request ids',
);
assert.equal(
  resolveRecipeRunSelection([{ id: 'attempt' }, { id: 'promoted' }], 'stale', 'promoted'),
  'promoted',
  'recipe run selection should fall back to the gateway-selected id when the requested id is stale',
);
assert.equal(
  resolveRecipeRunSelection([{ id: 'attempt' }], 'stale', 'missing'),
  'attempt',
  'recipe run selection should fall back to the first group when requested and fallback ids are stale',
);
assert.equal(
  resolveRecipeRunSelection([], 'stale', 'missing'),
  null,
  'recipe run selection should return null when there are no recipe runs',
);

assert.equal(
  artifactUrl('ws://localhost:7777/ws', 'run-1', 'artifacts/screenshots/ac1.png', 'live-run:r1'),
  'http://localhost:7777/api/run-artifact?runId=run-1&path=artifacts%2Fscreenshots%2Fac1.png&recipeRunId=live-run%3Ar1',
  'recipe run artifact URLs should carry recipeRunId for selected-run roots',
);

assert.equal(
  artifactUrl('ws://localhost:7777/ws', 'run-1', 'artifacts/screenshots/ac1.png', 'live-run:r1', 3),
  'http://localhost:7777/api/run-artifact?runId=run-1&path=artifacts%2Fscreenshots%2Fac1.png&recipeRunId=live-run%3Ar1&m=3',
  'manual mirror refresh should add a cache-busting mirror epoch to artifact URLs',
);

assert.deepEqual(
  artifactsForRecipeRun({
    id: 'current-artifacts',
    label: 'Recipe package',
    groupKind: 'current-artifacts',
    promoted: false,
    status: 'unknown',
    source: 'recipe-run-artifacts',
    selectionReason: 'latest-run',
    recipeRunId: null,
    artifactRoot: '/tmp/task/artifacts',
    recipeJson: null,
    recipeQualityArtifact: null,
    qualityReport: null,
    workerLearnings: null,
    isStale: false,
    artifactManifest: [{ path: 'artifacts/summary.json', purpose: 'report' }],
  }),
  [
    {
      path: 'artifacts/summary.json',
      purpose: 'report',
      recipeRunId: undefined,
      sourceLabel: 'Recipe package',
      sourceStatus: 'unknown',
    },
  ],
  'current task-level artifacts should not send recipeRunId to /api/run-artifact',
);

assert.deepEqual(
  artifactsForRecipeRun({
    id: 'passing-run-1',
    label: 'Latest passing evidence',
    groupKind: 'latest-valid',
    promoted: true,
    status: 'pass',
    source: 'recipe-run-artifacts',
    selectionReason: 'latest-run',
    recipeRunId: 'passing-run-1',
    artifactRoot: '/tmp/task/artifacts/recipe-runs/passing-run-1',
    recipeJson: null,
    recipeQualityArtifact: null,
    qualityReport: null,
    workerLearnings: null,
    isStale: false,
    artifactManifest: [{ path: 'artifacts/screenshots/ac1.png', purpose: 'screenshot' }],
  }),
  [
    {
      path: 'artifacts/screenshots/ac1.png',
      purpose: 'screenshot',
      recipeRunId: 'passing-run-1',
      sourceLabel: 'Latest passing evidence',
      sourceStatus: 'pass',
    },
  ],
  'promoted recipe-run artifacts should send their group id to /api/run-artifact',
);

assert.deepEqual(
  artifactsForRecipeRun({
    id: 'live-run:r1',
    label: 'Attempted run',
    groupKind: 'live-run',
    promoted: false,
    status: 'pass',
    source: 'recipe-run-live',
    selectionReason: 'user-selected',
    recipeRunId: 'r1',
    artifactRoot: '/tmp/artifacts/recipe-runs/r1',
    recipeJson: null,
    recipeQualityArtifact: null,
    qualityReport: null,
    workerLearnings: null,
    isStale: false,
    artifactManifest: [{ path: 'artifacts/screenshots/ac1.png', purpose: 'debug-screenshot' }],
  }),
  [
    {
      path: 'artifacts/screenshots/ac1.png',
      purpose: 'debug-screenshot',
      recipeRunId: 'live-run:r1',
      sourceLabel: 'Attempted run',
      sourceStatus: 'pass',
    },
  ],
  'recipe run artifacts should retain the group id needed by /api/run-artifact',
);

assert.deepEqual(
  extractRunArtifactManifest({
    id: 'run-1',
    familyId: 'family-1',
    ticketOrPr: 'PROJ-1',
    project: 'farm',
    flowType: 'fix-bug',
    lane: 'production',
    status: 'done',
    slotId: null,
    branch: null,
    taskFile: null,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    steps: [
      {
        name: 'complete',
        status: 'done',
        startedAt: '2026-05-21T00:00:00.000Z',
        completedAt: '2026-05-21T00:01:00.000Z',
        outputs: {
          artifacts: [
            { path: 'artifacts/before.png', purpose: 'screenshot-before', sizeBytes: 10 },
            'artifacts/report.md',
          ],
        },
      },
    ],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'gpt-test', runner: 'codex' },
  }).map((artifact) => ({
    path: artifact.path,
    purpose: artifact.purpose,
    sizeBytes: artifact.sizeBytes,
  })),
  [
    { path: 'artifacts/before.png', purpose: 'screenshot-before', sizeBytes: 10 },
    { path: 'artifacts/report.md', purpose: 'report', sizeBytes: undefined },
  ],
  'run artifact extraction should include step output artifacts for retrospective evidence fallback',
);
