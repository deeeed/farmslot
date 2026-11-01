import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  type AcceptanceStatusLedger,
  digestRecipeDocument,
  type RecipeClaimDeclaration,
  type RecipeRecordingTimelineDocument,
  type RecipeVisualJudgmentReceipt,
  recordedEvidenceClosureIdentity,
  type RecordedEvidencePackageInput,
  reviewedVisualFiles,
  type RunDecision,
  type SelfPrincipalSummary,
} from '@farmslot/protocol';

import type { TraceEntry } from '../../recipe-runner/src/core/types.js';
import type { ProofNode } from '../../recipe-runner/src/evidence/assertions.js';
import { deriveRecipeClaims } from '../../recipe-runner/src/evidence/claims.js';
import {
  createEvidenceReviewModel,
  type EvidenceReviewRecordingInput,
  readEvidenceReviewReport,
  runEvidencePending,
} from '../src/evidence.js';

const zero = Date.parse('2026-01-01T00:00:00Z');
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const videoDigest = digest('original recording');
const at = (ms: number) => new Date(zero + ms).toISOString();
const entry = (nodeId: string, start: number, end: number) => ({
  nodeId,
  action: 'assert_output',
  intent: `Verify ${nodeId}.`,
  ok: true,
  startedAt: at(start),
  endedAt: at(end),
  durationMs: end - start,
});

function recordedGate(selectedEvidenceKeys: string[]): RunDecision {
  const diffStat = { files: 0, additions: 0, deletions: 0 };
  return {
    id: 'gate',
    type: 'engine_human_gate',
    title: 'Review',
    description: '',
    actions: [],
    createdAt: at(0),
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      diffStat,
      workerReport: '',
      branch: 'review',
      prPackage: {
        id: 'package',
        packageHash: digest('package'),
        artifactPath: 'artifacts/pr-package.json',
        branch: 'review',
        diffStat,
        draftTitle: 'Review',
        draftBody: '',
        reviewArtifactIds: [],
        gatePolicy: {
          owner: 'human',
          dispatchMode: 'autonomous',
          publishAuthority: 'human',
          reason: 'Review the proof.',
        },
        publicationTarget: 'ready',
        publicationStatus: 'not_published',
        createdAt: at(0),
        selectedEvidenceKeys,
      },
    },
  };
}

test('the display uses recorded publication selections and retains every remaining artifact without changing claims', () => {
  const evidence = ['artifacts/proof.png', 'artifacts/still.png', 'artifacts/log.txt'];
  const ledger: AcceptanceStatusLedger = {
    schemaVersion: 1,
    criteria: [
      {
        id: 'AC-1',
        text: 'Inspect the result.',
        verdict: 'weak',
        evidence,
        recipeNodes: [],
        updatedAt: at(0),
      },
    ],
  };
  const inventory = [...evidence, 'artifacts/summary.json'].map((path) => ({
    path,
    purpose: 'evidence',
  }));
  const model = createEvidenceReviewModel({
    ledger,
    artifacts: inventory,
    gateDecision: recordedGate(['artifacts/proof.png']),
  });
  const original = structuredClone(model.claims);
  const display = model.claimDisplay('AC-1');
  assert.deepEqual(
    display.selected.map((file) => file.artifactPath),
    evidence.slice(0, 1),
  );
  assert.deepEqual(
    display.raw.map((file) => file.artifactPath),
    evidence.slice(1),
  );
  assert.deepEqual(
    model.rawArtifacts(inventory).map((file) => file.path),
    [...evidence.slice(1), 'artifacts/summary.json'],
  );
  assert.deepEqual(model.claims, original);
  assert.deepEqual(ledger.criteria[0]?.evidence, evidence);
  assert.equal(model.selection, null);
  assert.equal(model.comparisonView.rows[0]?.primaryClip, null);
  assert.deepEqual(
    model.comparisonView.rows[0]?.primaryFiles.map((file) => file.artifactPath),
    ['artifacts/proof.png'],
  );
  assert.deepEqual(
    createEvidenceReviewModel({ ledger, gateDecision: recordedGate([]) }).claimDisplay('AC-1')
      .selected,
    [],
  );
  assert.deepEqual(createEvidenceReviewModel({ ledger }).claimDisplay('AC-1').selected, []);
  // Review evidence opens the selected proof, else the first evidence file.
  const selectedStill = createEvidenceReviewModel({
    ledger,
    artifacts: inventory,
    gateDecision: recordedGate(['artifacts/still.png']),
  });
  assert.equal(selectedStill.claimFocusPath('AC-1'), 'artifacts/still.png');
  assert.equal(createEvidenceReviewModel({ ledger }).claimFocusPath('AC-1'), 'artifacts/proof.png');
});

test('a measured proof stays primary while its supporting stills remain raw and filterable', () => {
  const source = qaPackage(2);
  const before = JSON.stringify(source);
  const model = createEvidenceReviewModel({
    package: source,
    artifactPrefix: 'artifacts/selected/',
  });
  assert.deepEqual(model.errors, []);
  const claim = model.claims.find((row) => row.id === 'check-1');
  assert.ok(claim);
  const display = model.claimDisplay(claim.id);
  assert.equal(display.clip, claim.clips[0]);
  assert.deepEqual(display.selected, []);
  assert.deepEqual(
    display.raw.map((file) => file.artifactPath),
    ['artifacts/selected/stills/1.png'],
  );
  const inventory = [
    ...claim.evidence.map((file) => ({ path: file.artifactPath, purpose: 'evidence' })),
    { path: 'artifacts/selected/summary.json', purpose: 'summary' },
  ];
  assert.deepEqual(model.rawArtifacts(inventory), inventory.slice(1));
  model.setComparisonFilter('before');
  assert.ok(model.comparisonView.rows.every((row) => row.primaryClip === null));
  model.setComparisonFilter('moments');
  assert.equal(
    model.comparisonView.rows.find((row) => row.claim.id === claim.id)?.primaryClip,
    display.clip,
  );
  assert.equal(JSON.stringify(source), before);
});

test('selected before and after captures are excluded from raw inventory without losing their source bindings', () => {
  const baseSha = '1'.repeat(40),
    headSha = '2'.repeat(40);
  const source = withComparison(
    boundComparisonPackage('head', 'after', headSha),
    boundComparisonPackage('baseline', 'before', baseSha),
  );
  const model = createEvidenceReviewModel({
    package: source,
    artifactPrefix: 'artifacts/selected/',
    comparisonSnapshot: { baseSha, headSha },
  });
  assert.deepEqual(model.errors, []);
  const row = model.comparisons.find((row) => row.claim.id === 'check-1');
  assert.ok(row?.selectedBefore && row.selectedAfter);
  const inventory = [row.selectedBefore, row.selectedAfter].map((file) => ({
    path: file.artifactPath,
    purpose: 'evidence',
  }));
  const supporting = { path: 'artifacts/selected/summary.json', purpose: 'summary' };
  assert.deepEqual(model.rawArtifacts([...inventory, supporting]), [supporting]);
  assert.ok(
    model
      .claimDisplay('check-1')
      .selected.some((file) => file.artifactPath === row.selectedAfter?.artifactPath),
  );
  assert.equal(row.selectedBefore.recipeRunId, 'baseline');
  assert.equal(row.selectedAfter.recipeRunId, 'head');
});

function groupedRecording(path = 'video.mp4') {
  const trace = [
    { ...entry('setup', 0, 200), proves: [] },
    { ...entry('first-a', 1000, 1200), proves: ['AC-1'] },
    { ...entry('other-ac', 1800, 2100), proves: ['AC-2'] },
    { ...entry('second-a', 2200, 2400), proves: ['AC-1'] },
    { ...entry('teardown', 3000, 3200), proves: [] },
  ];
  const source = recording(trace, 0, 4000, path);
  for (const marker of source.timeline.markers) marker.proves = trace[marker.traceIndex]!.proves;
  return source;
}

test('group selection seeks the complete AC range without changing claims or narrowing a full-run timeline', () => {
  const model = createEvidenceReviewModel({
    criteria: [{ id: 'AC-1', text: 'Both observations hold.' }],
    recordings: [groupedRecording()],
  });
  assert.deepEqual(model.errors, []);
  assert.deepEqual(
    model.timelineGroups('video.mp4').map((group) => group.label),
    ['Setup', 'AC-1', 'AC-2', 'Teardown'],
  );
  const claims = structuredClone(model.claims);
  const group = model.timelineGroups('video.mp4').find((entry) => entry.claimId === 'AC-1');
  assert.ok(group);
  const playback = model.selectTimelineGroup('video.mp4', group.id);
  assert.equal(playback.seekMs, 1000);
  assert.ok(playback.clip && playback.clip.startMs <= 1000 && playback.clip.endMs >= 2400);
  assert.equal(model.selection?.claimId, undefined);
  assert.equal(model.timelineGroups('video.mp4').length, 4);
  assert.ok(model.selectClaim('AC-1'));
  assert.deepEqual(
    model.timelineGroups('video.mp4').map((group) => group.label),
    ['AC-1'],
  );
  model.selectTimelineGroup('video.mp4', group.id);
  model.selectOccurrence(3, { videoPath: 'video.mp4' });
  assert.equal(model.selection?.claimId, 'AC-1');
  assert.deepEqual(model.claims, claims);
  model.clearSelection();
  assert.deepEqual(
    model.timelineGroups('video.mp4').map((group) => group.label),
    ['Setup', 'AC-1', 'AC-2', 'Teardown'],
  );
});

test('timeline selection stays on the requested original and preserves timing refusal', () => {
  const model = createEvidenceReviewModel({
    recordings: [groupedRecording(), { ...groupedRecording('second.mp4'), gapBefore: false }],
  });
  assert.deepEqual(model.errors, []);
  const selected = model.selectOccurrence(1, { videoPath: 'second.mp4' });
  assert.equal(selected?.clips.length, 1);
  assert.equal(selected?.clips[0]?.videoPath, 'second.mp4');
  const group = model.timelineGroups('second.mp4').find((entry) => entry.claimId === 'AC-1');
  assert.ok(group);
  assert.equal(model.selectTimelineGroup('second.mp4', group.id).clip?.videoPath, 'second.mp4');
  const invalid = createEvidenceReviewModel({
    recordings: [groupedRecording()],
    readErrors: ['Retained recording could not be qualified.'],
  });
  assert.equal(invalid.timelineGroups('video.mp4')[1]?.startMs, null);
  const unavailable = invalid.timelineGroups('video.mp4').find((entry) => entry.claimId === 'AC-1');
  assert.ok(unavailable);
  assert.equal(invalid.selectTimelineGroup('video.mp4', unavailable.id).seekMs, null);
  assert.equal(invalid.selection, null);
});

function recording(
  trace: ReturnType<typeof entry>[],
  start = 0,
  duration = 4_000,
  path = 'video.mp4',
): EvidenceReviewRecordingInput {
  const timeline: RecipeRecordingTimelineDocument = {
    version: 1,
    videoPath: path,
    videoDigest: digest(path),
    traceDigest: digestRecipeDocument(trace),
    durationMs: duration,
    framesMs: [0, 1_000, 1_400, 2_000, 3_000].filter((ms) => ms < duration),
    clock: { source: 'fixture', earliestZeroUnixMs: zero + start, latestZeroUnixMs: zero + start },
    markers: trace.map((node, traceIndex) => ({
      traceIndex,
      nodeId: node.nodeId,
      action: node.action,
      intent: node.intent,
      ok: node.ok,
      startRangeMs: [
        Date.parse(node.startedAt) - zero - start,
        Date.parse(node.startedAt) - zero - start,
      ],
      endRangeMs: [
        Date.parse(node.endedAt) - zero - start,
        Date.parse(node.endedAt) - zero - start,
      ],
    })),
  };
  return { timeline, trace, videoPath: path, videoDigest: timeline.videoDigest };
}

/** Real engine derivation supplies the claims; these tests exercise their review projection. */
function qaPackage(cases = 10, durationMs = cases * 1_000 + 2_000): RecordedEvidencePackageInput {
  const targets: RecipeClaimDeclaration[] = [];
  const nodes: Record<string, ProofNode> = {};
  const trace: TraceEntry[] = [];
  const screenshots = [];
  for (let index = 0; index < cases; index++) {
    const id = index + 1;
    const next = id < cases ? `read-${id + 1}` : 'done';
    targets.push(
      { id: `case-${id}`, claim: `Case ${id} succeeds.`, kind: 'qa-case', proofMode: 'state' },
      {
        id: `check-${id}`,
        claim: `Value ${id} is observed.`,
        kind: 'qa-check',
        parentId: `case-${id}`,
        proofMode: 'state',
      },
    );
    nodes[`read-${id}`] = {
      action: 'state_read',
      intent: `Read value ${id}.`,
      next: `assert-${id}`,
    };
    nodes[`assert-${id}`] = {
      action: 'assert_output',
      source: `read-${id}`,
      intent: `Verify value ${id}.`,
      assert: { path: '$.count', operator: 'eq', value: id },
      proves: [`check-${id}`],
      next,
    };
    trace.push(
      {
        ...entry(`read-${id}`, index * 1_000 + 200, index * 1_000 + 300),
        action: 'state_read',
        intent: `Read value ${id}.`,
        next: `assert-${id}`,
        output: { count: id },
      },
      {
        ...entry(`assert-${id}`, index * 1_000 + 400, index * 1_000 + 700),
        intent: `Verify value ${id}.`,
        next,
        proves: [`check-${id}`],
        output: { source: `read-${id}`, assertion: nodes[`assert-${id}`]!.assert },
      },
    );
    screenshots.push({
      path: `stills/${id}.png`,
      type: 'screenshot' as const,
      nodeId: `assert-${id}`,
      metadata: {
        recordedEvidence: { videoPath: 'video.mp4', videoDigest, traceIndex: index * 2 + 1 },
      },
    });
  }
  nodes.done = { action: 'end', status: 'pass' };
  trace.push({
    ...entry('done', cases * 1_000 + 800, cases * 1_000 + 800),
    action: 'end',
    intent: undefined,
    status: 'pass',
  });
  const recipe = {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    description: 'Review composed QA cases.',
    proofTargets: targets,
    workflow: { entry: 'read-1', nodes },
  };
  const invocation = {
    version: 1,
    recipeRunId: 'qa-attempt',
    recipeDigest: digestRecipeDocument(recipe),
    startedAt: at(0),
    params: {},
    redactedPaths: [],
  };
  const segments = [{ videoPath: 'video.mp4', videoDigest, timelinePath: 'timeline.json' }];
  const timeline: RecipeRecordingTimelineDocument = {
    version: 1,
    videoPath: 'video.mp4',
    videoDigest,
    traceDigest: digestRecipeDocument(trace),
    durationMs,
    framesMs: [
      0,
      ...trace.flatMap((node) => [
        Date.parse(String(node.startedAt)) - zero,
        Date.parse(String(node.endedAt)) - zero,
      ]),
    ]
      .filter((ms, index, list) => ms < durationMs && list.indexOf(ms) === index)
      .sort((a, b) => a - b),
    clock: { source: 'fixture', earliestZeroUnixMs: zero, latestZeroUnixMs: zero },
    markers: trace.map((node, traceIndex) => ({
      traceIndex,
      nodeId: String(node.nodeId),
      action: String(node.action),
      ok: node.ok === true,
      ...(typeof node.intent === 'string' ? { intent: node.intent } : {}),
      ...(node.proves ? { proves: node.proves } : {}),
      startRangeMs: [
        Date.parse(String(node.startedAt)) - zero,
        Date.parse(String(node.startedAt)) - zero,
      ],
      endRangeMs: [
        Date.parse(String(node.endedAt)) - zero,
        Date.parse(String(node.endedAt)) - zero,
      ],
    })),
  };
  const artifacts = [
    { path: 'recipe.json', type: 'recipe' },
    { path: 'trace.json', type: 'trace' },
    { path: 'summary.json', type: 'summary' },
    { path: 'acceptance-status.json', type: 'json' },
    { path: 'video.mp4', type: 'video', timelinePath: 'timeline.json' },
    { path: 'timeline.json', type: 'json' },
    ...screenshots,
  ];
  return {
    recipe,
    trace: { metadata: { recipeRunId: 'qa-attempt' }, entries: trace },
    invocation,
    recipeRunId: 'qa-attempt',
    claims: {
      schemaVersion: 2,
      recipeRunId: 'qa-attempt',
      criteria: deriveRecipeClaims({
        recipeRunId: 'qa-attempt',
        declarations: targets,
        nodes: new Map(Object.entries(nodes)),
        trace,
        artifacts: screenshots,
        segments,
        timelines: new Map([['video.mp4', timeline]]),
      }),
      recording: { status: 'complete', segments },
    },
    summary: {
      recipeRunId: 'qa-attempt',
      status: 'pass',
      total: trace.length,
      passed: trace.length,
      failed: 0,
      cause_counts: { subject: 0, harness: 0, environment: 0, unknown: 0 },
      invocationDigest: digestRecipeDocument(invocation),
    },
    recipeResolution: {
      schema_version: 1,
      root: { ref: '$root', digest: digestRecipeDocument(recipe) },
      dependencies: [],
      edges: [],
    },
    resolvedRecipes: {},
    manifest: { version: 1, runStatus: 'pass', artifacts },
    artifactPaths: [
      ...artifacts.map((artifact) => artifact.path),
      'artifact-manifest.json',
      'recipe-resolution.json',
      'recipe-invocation.json',
    ],
    artifactDigests: {
      'video.mp4': videoDigest,
      ...Object.fromEntries(screenshots.map((shot) => [shot.path, digest(shot.path)])),
    },
    timelines: { 'timeline.json': timeline },
  };
}

test('every review context opens the same measured, padded source range', () => {
  const source = recording([entry('verify', 1_100, 1_400)]);
  for (const context of ['gate', 'pr-preview', 'run-detail', 'artifact'] as const) {
    const model = createEvidenceReviewModel({ context, recordings: [source] });
    assert.deepEqual(model.errors, []);
    const selected = model.selectOccurrence(0)!;
    assert.equal(selected.caption, 'Verify verify.');
    assert.equal(selected.timing, 'measured');
    assert.deepEqual(
      selected.clips.map(({ startMs, endMs }) => [startMs, endMs]),
      [[100, 2_400]],
    );
    assert.equal(model.selection, selected);
    model.clearSelection();
    assert.equal(model.selection, null);
    assert.equal(model.playback.clip, null);
  }
});

test('video and trace digest mismatches remain visible and disable all seeking', () => {
  const trace = [entry('verify', 1_100, 1_400)];
  const source = recording(trace);
  for (const changed of [
    { ...source, videoDigest: digest('other video') },
    { ...source, trace: [{ ...trace[0], intent: 'Different intent.' }] },
  ]) {
    const model = createEvidenceReviewModel({ recordings: [changed] });
    assert(model.errors.length);
    assert.equal(model.selectOccurrence(0)?.clips.length, 0);
    assert.equal(model.markerSeekMs(source.timeline.videoPath, 0, 'end'), null);
    assert.equal(model.adjacentFrameMs(source.timeline.videoPath, 1_100, 1), null);
  }
});

test('outside footage is never trimmed into proof, and untimed files stay visible', () => {
  const model = createEvidenceReviewModel({ recordings: [recording([entry('early', -100, 100)])] });
  assert.equal(model.selectOccurrence(0)?.timing, 'outside-recording');
  assert.equal(model.markerSeekMs('video.mp4', 0, 'end'), null);
  assert.deepEqual(model.selection?.clips, []);
  const ledger: AcceptanceStatusLedger = {
    schemaVersion: 1,
    criteria: [
      {
        id: 'AC-1',
        text: 'Legacy proof.',
        verdict: 'proven',
        evidence: ['still.png', 'trace.json'],
        recipeNodes: ['verify'],
      },
    ],
  };
  const legacy = createEvidenceReviewModel({ ledger });
  assert.equal(legacy.selectClaim('AC-1')?.timing, 'untimed');
  assert.deepEqual(
    legacy.selection?.stills.map((file) => file.path),
    ['still.png'],
  );
  assert.equal(legacy.selectClaim('AC-1', 'unrelated.png'), null);
});

test('ordinary unassessed criteria and manifest links cannot invent verdicts', () => {
  const model = createEvidenceReviewModel({
    criteria: [{ id: 'AC-1', text: 'Verify it.' }],
    evidenceLinks: [{ id: 'AC-1', evidence: ['still.png'] }],
  });
  assert.equal(model.claims[0]?.status, null);
  assert.equal(model.selectClaim('AC-1')?.caption, 'AC-1 · not assessed');
  assert.deepEqual(
    model.selection?.stills.map((file) => file.path),
    ['still.png'],
  );
});

test('a working run with nothing retained reports its verdicts without judging a package', () => {
  assert.equal(runEvidencePending({ status: 'monitoring' }), true);
  assert.equal(runEvidencePending({ status: 'done' }), false);
  assert.equal(
    runEvidencePending({
      status: 'human-gating',
      artifactBundle: {
        storeId: 'store',
        bundleDigest: 'sha256:retained',
        taskKey: 'task',
        manifestDigest: 'sha256:manifest',
      },
    }),
    false,
  );
  const verdict = {
    id: 'AC-1',
    text: 'Proven by the worker.',
    verdict: 'proven' as const,
    evidence: [],
    recipeNodes: [],
    updatedAt: at(0),
  };
  for (const schemaVersion of [1, 2] as const) {
    const ledger = { schemaVersion, recipeRunId: 'live', criteria: [verdict] };
    assert.notDeepEqual(createEvidenceReviewModel({ ledger, contractVersion: 1 }).errors, []);
    const pending = createEvidenceReviewModel({
      ledger,
      contractVersion: 1,
      evidencePending: true,
    });
    assert.deepEqual(pending.errors, []);
    assert.equal(pending.packageStatus, null);
  }
});

test('a criterion row has details only when something would open behind More', () => {
  const linked = createEvidenceReviewModel({
    criteria: [
      { id: 'AC-1', text: 'Not started.' },
      { id: 'AC-2', text: 'Linked.' },
    ],
    evidenceLinks: [{ id: 'AC-2', evidence: ['still.png'] }],
  });
  assert.equal(linked.claimHasDetails('AC-1'), false);
  assert.equal(linked.claimHasDetails('AC-1', { playable: true, overridable: true }), false);
  assert.equal(linked.claimHasDetails('AC-2'), true);
  // Review evidence opens the same file in both clients, and nothing while it is pending.
  assert.equal(linked.claimFocusPath('AC-1'), undefined);
  assert.match(linked.claimFocusPath('AC-2') ?? '', /still\.png$/);
  const pending = createEvidenceReviewModel({
    criteria: [{ id: 'AC-2', text: 'Linked.' }],
    evidenceLinks: [{ id: 'AC-2', evidence: ['still.png'] }],
    evidencePending: true,
  });
  assert.equal(pending.claimFocusPath('AC-2'), undefined);
  const noted = createEvidenceReviewModel({
    ledger: {
      schemaVersion: 1,
      criteria: [
        {
          id: 'AC-1',
          text: 'Weak.',
          verdict: 'weak',
          note: 'Unit test only.',
          evidence: [],
          recipeNodes: [],
          updatedAt: at(0),
        },
      ],
    },
  });
  assert.equal(noted.claimHasDetails('AC-1'), true);
});

test('continuous source segments play in order while restart gaps remain outside recording', () => {
  const trace = [entry('cross-boundary', 1_500, 2_500)];
  const first = recording(trace, 0, 2_000, 'first.mp4');
  const next = { ...recording(trace, 2_000, 2_000, 'next.mp4'), gapBefore: false };
  const continuous = createEvidenceReviewModel({ recordings: [first, next] }).selectOccurrence(0)!;
  assert.deepEqual(
    continuous.clips.map(({ videoPath, startMs, endMs }) => [videoPath, startMs, endMs]),
    [
      ['first.mp4', 500, 2_000],
      ['next.mp4', 0, 1_500],
    ],
  );
  const scoped = createEvidenceReviewModel({ recordings: [first, next] });
  assert.equal(scoped.markerSeekMs('next.mp4', 0, 'start'), null);
  assert.equal(scoped.markerSeekMs('next.mp4', 0, 'end'), 500);
  assert.equal(scoped.selectOccurrence(0, { videoPath: 'next.mp4' }), null);
  assert.equal(
    scoped.selectOccurrence(0, { videoPath: 'next.mp4', phase: 'end' })?.clips[0]?.videoPath,
    'next.mp4',
  );
  const gap = createEvidenceReviewModel({ recordings: [first, { ...next, gapBefore: true }] });
  assert.equal(gap.selectOccurrence(0)?.timing, 'outside-recording');
  assert.deepEqual(gap.selection?.clips, []);
});

test('identical video bytes retain distinct original clocks and playback identities', () => {
  const trace = [entry('cross-boundary', 1_500, 2_500)];
  const bytesDigest = digest('identical recorded frames');
  const originals = [
    recording(trace, 0, 2_000, 'first.mp4'),
    recording(trace, 2_000, 2_000, 'next.mp4'),
  ].map((source) => ({
    ...source,
    gapBefore: false,
    videoDigest: bytesDigest,
    timeline: { ...source.timeline, videoDigest: bytesDigest },
  }));
  const model = createEvidenceReviewModel({ recordings: originals });
  assert.deepEqual(model.errors, []);
  const selected = model.selectOccurrence(0)!;
  assert.deepEqual(
    selected.clips.map(({ videoPath, startMs, endMs }) => [videoPath, startMs, endMs]),
    [
      ['first.mp4', 500, 2_000],
      ['next.mp4', 0, 1_500],
    ],
  );
  model.cueClip(1);
  assert.equal(model.playbackAt('first.mp4', 2_000).sourceChanged, false);
  assert.equal(model.playbackAt('next.mp4', 1_500).pause, true);
});

test('gateway override projection keeps original engine facts and refuses another closure', () => {
  const pkg = qaPackage(1);
  pkg.artifactDigests = Object.fromEntries(
    (pkg.artifactPaths ?? []).map((file) => [
      file,
      pkg.artifactDigests[file] ?? `sha256:${createHash('sha256').update(file).digest('hex')}`,
    ]),
  );
  const original = structuredClone(pkg.claims);
  const claim = pkg.claims!.criteria[0]!;
  const authority = {
    runId: 'run',
    recipeRunId: pkg.claims!.recipeRunId,
    closureIdentity: recordedEvidenceClosureIdentity(pkg),
    receipts: [
      {
        id: 'receipt',
        runId: 'run',
        decisionId: 'gate',
        claimId: claim.id,
        recipeRunId: pkg.claims!.recipeRunId,
        closureIdentity: recordedEvidenceClosureIdentity(pkg),
        priorVerdict: claim.verdict,
        approver: { principalId: 'person', displayName: 'Reviewer', credentialId: 'credential' },
        reason: 'Manual exception.',
        overriddenAt: '2026-10-13T00:00:00Z',
      },
    ],
  };
  for (const context of ['gate', 'pr-preview', 'run-detail', 'artifact'] as const) {
    const model = createEvidenceReviewModel({
      context,
      package: pkg,
      claimOverrideAuthority: authority,
    });
    assert.deepEqual(model.errors, []);
    assert.equal(model.claims[0]?.status?.verdict, 'untestable');
    assert.equal(model.claims[0]?.status?.engineVerdict, 'proven');
  }
  assert.deepEqual(pkg.claims, original);
  const changed = createEvidenceReviewModel({
    package: pkg,
    claimOverrideAuthority: { ...authority, closureIdentity: 'other' },
  });
  assert.equal(changed.claims[0]?.status?.verdict, 'proven');
});

test('ten QA cases and their checks use the same verified claim and occurrence navigation', () => {
  const pkg = qaPackage();
  const model = createEvidenceReviewModel({ package: pkg, criteria: [] });
  assert.deepEqual(model.errors, []);
  assert.equal(model.claims.length, 20, 'an empty task AC list cannot hide recipe QA claims');
  for (let id = 1; id <= 10; id++) {
    const selected = model.selectClaim(`case-${id}`)!;
    assert.equal(
      model.claims.find((claim) => claim.id === `case-${id}`)?.status?.verdict,
      'proven',
    );
    assert.equal(selected.clips.length, 1);
    assert.equal(selected.clips[0]?.traceIndex, (id - 1) * 2 + 1);
    assert.deepEqual(
      selected.stills.map((file) => file.path),
      [`stills/${id}.png`],
    );
    assert.deepEqual(model.selectOccurrence((id - 1) * 2 + 1)?.clips, selected.clips);
  }
});

test('a task ledger in package claims displays the schema finding without measured proof', () => {
  const pkg = qaPackage();
  pkg.claims = JSON.parse(
    JSON.stringify({
      schemaVersion: 1,
      criteria: [
        {
          id: 'AC-1',
          text: 'The task check passes.',
          verdict: 'proven',
          evidence: ['artifacts/check.log'],
          recipeNodes: [],
          updatedAt: at(0),
        },
      ],
    }),
  );
  const model = createEvidenceReviewModel({ package: pkg });
  assert(model.errors.some((message) => /require schema 2/.test(message)));
  assert.equal(model.packageStatus?.status, 'Invalid');
  assert.deepEqual(model.claims, []);
  assert.equal(model.summary.proven, 0);
  assert.equal(model.selectClaim('AC-1'), null);
  assert.equal(model.selectOccurrence(1)?.timing, 'untimed');
  assert.deepEqual(model.selectOccurrence(1)?.clips, []);
});

test('schema-2 claims still require moment arrays', () => {
  const pkg = qaPackage();
  assert(pkg.claims);
  Reflect.deleteProperty(pkg.claims.criteria[0]!, 'moments');
  const model = createEvidenceReviewModel({ package: pkg });
  assert(model.errors.some((message) => /\.moments: invalid moment references/.test(message)));
  assert.equal(model.packageStatus?.status, 'Invalid');
  assert.equal(model.selectClaim(pkg.claims.criteria[0]!.id)?.timing, 'untimed');
  assert.deepEqual(model.selectClaim(pkg.claims.criteria[0]!.id)?.clips, []);
});

test('recorded claims cannot borrow an unrelated task ledger or omit their source package', () => {
  const pkg = qaPackage(1);
  const ledger = { ...pkg.claims!, recipeRunId: 'another-attempt' };
  const stale = createEvidenceReviewModel({ package: pkg, ledger });
  assert(stale.errors.some((error) => error.includes('another recipe execution')));
  assert.equal(stale.selectClaim('case-1')?.clips.length, 0);
  const missing = createEvidenceReviewModel({ ledger: pkg.claims! });
  assert(missing.errors.some((error) => error.includes('retained execution package')));
});

test('source mutation after validation cannot change selected clips or captions', () => {
  const pkg = qaPackage(1);
  const model = createEvidenceReviewModel({ package: pkg });
  const expected = model.selectClaim('case-1');
  pkg.timelines['timeline.json']!.markers[1]!.endRangeMs[1] += 9_000;
  pkg.claims!.criteria[0]!.verdict = 'failed';
  assert.deepEqual(model.selectClaim('case-1'), expected);
  assert.equal(model.claims[0]?.status?.verdict, 'proven');
});

test('measured frame stepping preserves the existing player controls', () => {
  const source = recording([entry('verify', 1_100, 1_400)]);
  const model = createEvidenceReviewModel({ recordings: [source] });
  assert.equal(model.markerSeekMs(source.timeline.videoPath, 0, 'end'), 1_400);
  assert.equal(model.adjacentFrameMs(source.timeline.videoPath, 1_450, 1), 2_000);
  assert.equal(model.adjacentFrameMs(source.timeline.videoPath, 1_450, -1), 1_000);
  assert.deepEqual(model.displayedFrameRangeMs(source.timeline.videoPath, 1_450), [1_400, 2_000]);
  assert.equal(model.displayedFrameRangeMs(source.timeline.videoPath, 4_000), null);
  assert.equal(model.markerSeekMs(source.timeline.videoPath, 0, 'end', 1_300), null);
  assert.deepEqual(
    model.displayedFrameRangeMs(source.timeline.videoPath, 1_450, 1_500),
    [1_400, 1_500],
  );
});

test('both player renderers inherit bounded seeking, stopping and ordered segment transitions', () => {
  const trace = [entry('cross-boundary', 1_500, 2_500)];
  const first = recording(trace, 0, 2_000, 'first.mp4');
  const next = { ...recording(trace, 2_000, 2_000, 'next.mp4'), gapBefore: false };
  const model = createEvidenceReviewModel({ recordings: [first, next] });
  model.selectOccurrence(0);
  assert.equal(model.cueClip(0).seekMs, 500);
  assert.equal(model.seekClip(-1).seekMs, 500);
  assert.equal(model.seekClip(9_000).seekMs, 2_000);
  assert.equal(model.playbackAt('foreign.mp4', 9_000).sourceChanged, false);
  const advance = model.playbackAt(first.timeline.videoPath, 2_000);
  assert.equal(advance.sourceChanged, true);
  assert.equal(advance.clip?.videoPath, 'next.mp4');
  assert.equal(advance.seekMs, 0);
  assert.equal(model.playbackAt(next.timeline.videoPath, 1_500).pause, true);
  assert.equal(model.playbackAt(next.timeline.videoPath, 1_500).seekMs, 1_500);
});

test('QA report selection retains the reviewed report and output manifest identity', () => {
  const report = {
    reportPath: 'artifacts/report.html',
    manifestDigest: 'retained-output',
    artifactManifest: [
      { path: 'artifacts/report.html', purpose: 'report' as const, sha256: 'a'.repeat(64) },
    ],
  };
  const model = createEvidenceReviewModel({ context: 'gate', report });
  assert.equal(model.selectReport()?.artifacts[0]?.path, report.reportPath);
  assert.match(model.selection?.caption ?? '', /^Report snapshot retained-output/);
  assert.match(model.selection?.caption ?? '', /no recorded review binding/);
  assert.equal(model.report?.artifactManifest[0]?.sha256, report.artifactManifest[0]?.sha256);
  assert.equal(
    createEvidenceReviewModel({ report: { ...report, reportPath: 'other.html' } }).selectReport(),
    null,
  );
});

test('outside claims without moment refs retain their timing limitation and proof occurrence', () => {
  const model = createEvidenceReviewModel({ package: qaPackage(1, 300) });
  assert.deepEqual(model.errors, []);
  const selection = model.selectClaim('check-1')!;
  assert.equal(selection.timing, 'outside-recording');
  assert.equal(selection.traceIndex, 1);
  assert.equal(selection.message, 'Outside recording.');
  assert.deepEqual(selection.clips, []);
});

test('standalone originals cannot join independently supplied trace semantics', () => {
  const first = recording([entry('original', 1_500, 2_500)], 0, 2_000, 'first.mp4');
  const second = {
    ...recording([entry('other-run', 1_500, 2_500)], 2_000, 2_000, 'next.mp4'),
    gapBefore: false,
  };
  const model = createEvidenceReviewModel({ recordings: [first, second] });
  assert(model.errors.some((error) => error.includes('trace')));
  assert.deepEqual(model.selectOccurrence(0)?.clips, []);
});

test('measured marker seek never exceeds the decoder duration', () => {
  const source = recording([entry('verify', 1_100, 1_400)]);
  source.timeline.clock.earliestZeroUnixMs = zero - 100;
  source.timeline.clock.latestZeroUnixMs = zero + 100;
  source.timeline.markers[0]!.startRangeMs = [1_000, 1_200];
  source.timeline.markers[0]!.endRangeMs = [1_300, 1_500];
  const model = createEvidenceReviewModel({ recordings: [source] });
  assert.deepEqual(model.errors, []);
  assert.equal(model.markerSeekMs('video.mp4', 0, 'end', 1_350), 1_350);
});

test('equal-byte originals with different marker subsets resolve a claim against its matching original', () => {
  const pkg = qaPackage(1);
  const first = pkg.timelines['timeline.json']!;
  const second = {
    ...first,
    videoPath: 'second.mp4',
    markers: first.markers.filter((marker) => marker.traceIndex !== 0),
  };
  pkg.timelines = {
    ...pkg.timelines,
    'timeline.json': {
      ...first,
      markers: first.markers.filter((marker) => marker.traceIndex !== 1),
    },
    'second.timeline.json': second,
  };
  pkg.artifactPaths = [...pkg.artifactPaths!, 'second.mp4', 'second.timeline.json'];
  pkg.artifactDigests = { ...pkg.artifactDigests, 'second.mp4': videoDigest };
  (pkg.manifest as { artifacts: unknown[] }).artifacts.push(
    { path: 'second.mp4', type: 'video', timelinePath: 'second.timeline.json' },
    { path: 'second.timeline.json', type: 'json' },
  );
  pkg.claims!.recording.segments.push({
    videoPath: 'second.mp4',
    videoDigest,
    timelinePath: 'second.timeline.json',
    gapBefore: false,
  });
  const model = createEvidenceReviewModel({ package: pkg });
  assert.deepEqual(model.errors, []);
  assert.equal(model.selectClaim('check-1')?.clips[0]?.videoPath, 'second.mp4');
  assert.deepEqual(
    model.claims
      .find((claim) => claim.id === 'check-1')!
      .evidence.filter((file) => file.mediaType === 'video')
      .map((file) => file.path),
    ['second.mp4'],
  );
});

test('report rendering is bound to both the decision snapshot and actual report bytes', async () => {
  const bytes = new TextEncoder().encode('# QA report');
  const report = {
    reportPath: 'artifacts/report.md',
    manifestDigest: 'frozen-manifest',
    artifactManifest: [
      { path: 'artifacts/report.md', purpose: 'report', sha256: digest('# QA report') },
    ],
  };
  const reportSnapshot = {
    kind: 'output-review' as const,
    manifestDigest: report.manifestDigest,
    reportPath: report.reportPath,
  };
  const model = createEvidenceReviewModel({ report, reportSnapshot });
  assert.equal((await readEvidenceReviewReport(model, async () => bytes)).body, '# QA report');
  await assert.rejects(
    readEvidenceReviewReport(model, async () => new TextEncoder().encode('changed')),
    /bytes do not match/,
  );
  const stale = createEvidenceReviewModel({
    report: { ...report, manifestDigest: 'new-manifest' },
    reportSnapshot,
  });
  const staleReport = await readEvidenceReviewReport(stale, async () => bytes);
  assert.equal(staleReport.body, '# QA report');
  assert.match(staleReport.caption, /no longer matches.*expected frozen-manifest/);
  assert.ok(stale.warnings.some((warning) => warning.includes('no longer matches')));
  assert.equal(stale.errors.length, 0);
});

test('review projection carries the retained checked expectation beside its claim', () => {
  const model = createEvidenceReviewModel({ package: qaPackage(1) });
  assert.deepEqual(
    model.claims.find((claim) => claim.id === 'case-1')?.occurrences[0]?.expectation,
    { assert: { path: '$.count', operator: 'eq', value: 1 } },
  );
});

test('package originals and legacy task refs keep their distinct transport namespaces', () => {
  const model = createEvidenceReviewModel({ package: qaPackage(1), artifactPrefix: 'artifacts/' });
  assert.equal(model.selectClaim('check-1')?.stills[0]?.artifactPath, 'artifacts/stills/1.png');
  assert.equal(model.artifactPath('video.mp4'), 'artifacts/video.mp4');
  assert.equal(model.selectClaim('check-1', 'artifacts/stills/1.png')?.claimId, 'check-1');
  const legacy = createEvidenceReviewModel({
    artifactPrefix: 'artifacts/',
    ledger: {
      schemaVersion: 1,
      criteria: [
        {
          id: 'AC-1',
          text: 'Existing task proof.',
          verdict: 'proven',
          evidence: ['artifacts/legacy.png'],
          recipeNodes: [],
        },
      ],
    },
  });
  assert.equal(legacy.selectClaim('AC-1')?.stills[0]?.artifactPath, 'artifacts/legacy.png');
});

test('legacy root diagnostics merge reader/type/include repeats per missing file', () => {
  const pkg: RecordedEvidencePackageInput = {
    summary: undefined,
    trace: undefined,
    manifest: undefined,
    artifactPaths: ['report.html'],
    artifactDigests: {},
    timelines: {},
  };
  const model = createEvidenceReviewModel({
    contractVersion: 0,
    package: pkg,
    packagePath: 'artifacts/previous/',
    readErrors: [
      'Missing required Recipe v1 artifact summary.json.',
      'summary.json must be an object.',
      'Recipe artifact package must include summary.json.',
      'Missing required Recipe v1 artifact trace.json.',
      'Recipe artifact package must include artifact-manifest.json.',
    ],
  });
  assert.equal(model.packageStatus?.status, 'Legacy');
  assert.equal(model.packageStatus?.path, 'previous');
  assert.match(
    model.packageStatus!.summary,
    /Recorded before Recipe v1: not machine-checkable.*media untimed/,
  );
  assert.deepEqual(
    model.packageStatus!.issues.map((issue) => issue.message),
    ['Missing summary.json', 'Missing trace.json', 'Missing artifact-manifest.json'],
  );
  assert.equal(model.packageStatus!.issues[0]!.count, 5);
  assert.equal(model.packageStatus!.action, undefined);
  assert.deepEqual(model.displayWarnings, []);
  assert(model.errors.length > model.packageStatus!.issues.length);
  assert.equal(model.markerSeekMs('video.mp4', 0, 'start'), null);
});

test('current packages are valid or invalid with recovery guidance, never downgraded to legacy', () => {
  const pkg = qaPackage(1);
  assert.equal(createEvidenceReviewModel({ package: pkg }).packageStatus?.status, 'Valid');
  pkg.artifactPaths = pkg.artifactPaths!.filter((file) => file !== 'summary.json');
  pkg.summary = undefined;
  const model = createEvidenceReviewModel({ package: pkg });
  assert.equal(model.packageStatus?.status, 'Invalid');
  assert.match(model.packageStatus!.action!, /Refresh the gate package or re-run the recipe/);
  assert(model.packageStatus!.issues.some((issue) => issue.message === 'Missing summary.json'));
  assert.deepEqual(model.selectClaim('check-1')?.clips, []);
});

test('present malformed files remain shape errors rather than missing-file diagnostics', () => {
  const pkg = qaPackage(1);
  pkg.summary = 'not an object';
  const model = createEvidenceReviewModel({
    package: pkg,
    readErrors: ['Unreadable retained file', 'Unreadable retained file'],
  });
  assert.equal(model.packageStatus?.status, 'Invalid');
  assert(
    model.packageStatus!.issues.some(
      (issue) => issue.message === 'summary.json must be an object.',
    ),
  );
  assert(!model.packageStatus!.issues.some((issue) => issue.message === 'Missing summary.json'));
  assert.equal(
    model.packageStatus!.issues.find((issue) => issue.message === 'Unreadable retained file')
      ?.count,
    2,
  );
});

test('artifact-only reports open read-only despite recipe selection errors and still verify their own snapshot', async () => {
  const body = '<h1>Retained QA report</h1>';
  const report = {
    reportPath: 'artifacts/report.html',
    manifestDigest: 'captured-output',
    artifactManifest: [{ path: 'artifacts/report.html', purpose: 'report', sha256: digest(body) }],
  };
  const model = createEvidenceReviewModel({
    context: 'gate',
    report,
    reportSnapshot: {
      kind: 'output-review',
      manifestDigest: report.manifestDigest,
      reportPath: report.reportPath,
    },
    readErrors: ['Select a retained recipe execution from the gate package.'],
  });
  assert.equal(
    (await readEvidenceReviewReport(model, async () => new TextEncoder().encode(body))).body,
    body,
  );
  assert.equal(model.selection?.timing, 'untimed');
  assert.deepEqual(model.selection?.clips, []);
  assert.equal(model.errors.length, 1);
  await assert.rejects(
    readEvidenceReviewReport(model, async () => new TextEncoder().encode('changed')),
    /bytes do not match/,
  );
  const stale = createEvidenceReviewModel({
    report,
    reportSnapshot: {
      kind: 'output-review',
      reportPath: report.reportPath,
      manifestDigest: 'another-output',
    },
    readErrors: model.errors,
  });
  assert.ok(stale.selectReport());
  const staleReport = await readEvidenceReviewReport(stale, async () =>
    new TextEncoder().encode(body),
  );
  assert.equal(staleReport.body, body);
  assert.match(staleReport.caption, /no longer matches.*expected another-output/);
  assert.deepEqual(stale.errors, model.errors);
});

test('unverifiable current reads are invalid with recovery guidance', () => {
  const unknown = createEvidenceReviewModel({
    readErrors: ['Select a retained recipe execution from the gate package.'],
  });
  assert.equal(unknown.packageStatus?.status, 'Invalid');
  assert.equal(unknown.packageStatus?.tone, 'error');
  const pkg = qaPackage(1);
  pkg.summary = undefined;
  assert.equal(createEvidenceReviewModel({ package: pkg }).packageStatus?.tone, 'error');
});

test('an authored recipe beside legacy media does not identify an executed Recipe v1 package', () => {
  const model = createEvidenceReviewModel({
    contractVersion: 0,
    package: {
      recipe: { $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json' },
      summary: undefined,
      trace: undefined,
      manifest: undefined,
      artifactPaths: ['recipe.json'],
      artifactDigests: {},
      timelines: {},
    },
  });
  assert.equal(model.packageStatus?.status, 'Legacy');
  assert.equal(model.packageStatus?.tone, 'info');
  assert(
    model.packageStatus!.issues.some((issue) => issue.message === 'Missing recipe-resolution.json'),
  );
});

test('historical filenames alone never mark an older artifact format as a current contract failure', () => {
  const model = createEvidenceReviewModel({
    contractVersion: 0,
    package: {
      summary: { version: 0 },
      trace: [],
      manifest: { version: 0, artifacts: [] },
      artifactPaths: ['summary.json', 'trace.json', 'artifact-manifest.json'],
      artifactDigests: {},
      timelines: {},
    },
  });
  assert(model.errors.length);
  assert.equal(model.packageStatus?.status, 'Legacy');
  assert.equal(model.packageStatus?.tone, 'info');
  assert.equal(model.packageStatus?.action, undefined);
});

test('new unverifiable packages never inherit a Legacy label and future run contracts fail closed', () => {
  const pkg: RecordedEvidencePackageInput = {
    summary: undefined,
    trace: undefined,
    manifest: undefined,
    artifactPaths: ['report.html'],
    artifactDigests: {},
    timelines: {},
  };
  const current = createEvidenceReviewModel({ contractVersion: 1, package: pkg });
  assert.equal(current.packageStatus?.status, 'Invalid');
  assert.equal(current.packageStatus?.tone, 'error');
  assert.equal(current.packageStatus?.reasonCode, 'evidence-package-unverifiable');
  assert.match(current.packageStatus?.action ?? '', /Refresh the gate package/);
  assert.equal(
    createEvidenceReviewModel({ contractVersion: 0, package: pkg }).packageStatus?.status,
    'Legacy',
  );
  const future = createEvidenceReviewModel({ contractVersion: 2, package: qaPackage(1) });
  assert.equal(future.packageStatus?.status, 'Invalid');
  assert.equal(future.packageStatus?.reasonCode, 'evidence-contract-unsupported');
  assert.equal(future.markerSeekMs('video.mp4', 0, 'start'), null);
  assert.equal(future.adjacentFrameMs('video.mp4', 100, 1), null);
  assert.equal(future.displayedFrameRangeMs('video.mp4', 100), null);
});

test('authenticated review uses one engine projection in every view and preserves source bytes', () => {
  const input: RecordedEvidencePackageInput = JSON.parse(
    readFileSync(
      new URL('../../recipe-runner/test/fixtures/visual-review-package.json', import.meta.url),
      'utf8',
    ),
  ).input;
  const original = JSON.stringify(input);
  const receipt: RecipeVisualJudgmentReceipt = {
    id: 'review',
    runId: 'run',
    snapshotIdentity: 'captured',
    recipeRunId: input.claims!.recipeRunId,
    claimId: 'check-1',
    closureIdentity: recordedEvidenceClosureIdentity(input),
    verdict: 'confirmed',
    moments: input.claims!.criteria.find(({ id }) => id === 'check-1')!.moments,
    approver: { principalId: 'person', credentialId: 'credential', displayName: 'Reviewer' },
    reason: 'Observed the expected view.',
    judgedAt: '2026-10-14T00:00:00Z',
  };
  const authority = {
    runId: 'run',
    recipeRunId: receipt.recipeRunId,
    closureIdentity: receipt.closureIdentity,
    receipts: [receipt],
  };
  for (const context of ['gate', 'pr-preview', 'run-detail', 'artifact'] as const) {
    const pending = createEvidenceReviewModel({ package: input, context });
    assert.equal(pending.summary?.proven, 0);
    const confirmed = createEvidenceReviewModel({
      package: input,
      context,
      visualReviewAuthority: authority,
    });
    assert.deepEqual(confirmed.errors, []);
    assert.equal(confirmed.summary?.proven, 2);
    assert.deepEqual(confirmed.claims.find(({ id }) => id === 'check-1')!.proofKinds, [
      'assertion',
      'person-reviewed',
    ]);
    const pipeline: RecipeVisualJudgmentReceipt = {
      ...receipt,
      kind: 'pipeline-reviewed',
      reviewerSubjectKind: 'service',
      approver: { principalId: 'native-review:session:lease', displayName: 'Independent review' },
      pipeline: {
        contextId: 'review',
        sessionId: 'session',
        generation: 'generation',
        leaseId: 'lease',
        commandId: 'command',
        executionNodeId: 'node',
        ownerPrincipalId: 'owner',
      },
      reviewedFiles: reviewedVisualFiles(input, receipt.claimId),
    };
    const verified = createEvidenceReviewModel({
      package: input,
      context,
      visualReviewAuthority: { ...authority, receipts: [pipeline] },
    });
    assert.equal(verified.summary.proven, 2);
    const verifiedClaim = verified.claims.find((c) => c.id === 'check-1')!;
    assert.deepEqual(verifiedClaim.proofKinds, ['assertion', 'agent-reviewed']);
    assert.match(verified.visualReviewMarkdown, /Verified by agent/);
    assert.equal(
      verified.judgmentRows(null).find((r) => r.claim.id === 'check-1')!.prevalidation?.reason,
      receipt.reason,
    );
    const policy = { delegatedReviewerPrincipalIds: ['lead'], delegatorPrincipalId: 'person' };
    const delegated = createEvidenceReviewModel({
      package: input,
      context,
      visualReviewAuthority: {
        ...authority,
        projectPolicy: policy,
        receipts: [
          {
            ...receipt,
            kind: 'lead-agent-reviewed',
            reviewerSubjectKind: 'service',
            approver: {
              principalId: 'lead',
              credentialId: 'own-credential',
              displayName: 'Lead reviewer',
            },
            reviewedFiles: reviewedVisualFiles(input, receipt.claimId),
            delegation: {
              principalId: 'person',
              displayName: 'Operator',
              policyDigest: digestRecipeDocument(policy),
            },
          },
        ],
      },
    });
    assert.equal(delegated.summary.proven, 2);
    const row = delegated.judgmentRows(null).find(({ claim }) => claim.id === 'check-1')!;
    assert.equal(row.prevalidation?.reason, receipt.reason);
    assert.equal(row.prevalidation?.verdict, 'confirmed');
    assert.equal(
      confirmed.judgmentRows(null).find(({ claim }) => claim.id === 'check-1')!.prevalidation,
      null,
    );
    assert.match(delegated.visualReviewMarkdown, /agent-reviewed \(delegated by Operator\)/);
    assert.doesNotMatch(delegated.visualReviewMarkdown, /human-reviewed/);
    for (const claim of delegated.claims) {
      assert.deepEqual(claim.proofKinds, ['assertion', 'agent-reviewed']);
      assert.deepEqual(claim.reviewLabels, [
        'agent-reviewed (delegated by Operator) · Lead reviewer',
      ]);
      assert.equal(
        claim.reviewLabels.some((label) => label.includes('human')),
        false,
      );
    }
    const rejected = createEvidenceReviewModel({
      package: input,
      context,
      visualReviewAuthority: {
        ...authority,
        receipts: [
          receipt,
          { ...receipt, id: 'rejection', verdict: 'rejected', judgedAt: '2026-10-15T00:00:00Z' },
        ],
      },
    });
    assert.equal(rejected.summary?.failed, 2);
  }
  assert.equal(JSON.stringify(input), original);
});

test('the shared visual review request binds an eligible claim to its captured source and own identity', () => {
  const input: RecordedEvidencePackageInput = JSON.parse(
    readFileSync(
      new URL('../../recipe-runner/test/fixtures/visual-review-package.json', import.meta.url),
      'utf8',
    ),
  ).input;
  const original = JSON.stringify(input);
  const lead: SelfPrincipalSummary = {
    id: 'lead',
    displayName: 'Own reviewer',
    subjectKind: 'service',
    roles: [],
  };
  const authority = {
    runId: 'run',
    recipeRunId: input.claims!.recipeRunId,
    closureIdentity: recordedEvidenceClosureIdentity(input),
    receipts: [],
    projectPolicy: { delegatedReviewerPrincipalIds: ['lead'], delegatorPrincipalId: 'person' },
  };
  const model = createEvidenceReviewModel({
    package: input,
    visualReviewAuthority: authority,
    visualReviewContext: { snapshotIdentity: 'frozen', decisionId: 'gate' },
  });
  assert.deepEqual(model.errors, []);
  assert(model.pendingVisualClaimIds.includes('check-1'));
  const request = model.visualReviewRequest(
    'check-1',
    lead,
    'confirmed',
    ' Observed the recorded view. ',
  );
  assert.deepEqual(request, {
    runId: 'run',
    decisionId: 'gate',
    snapshotIdentity: 'frozen',
    recipeRunId: input.claims!.recipeRunId,
    claimId: 'check-1',
    kind: 'lead-agent-reviewed',
    verdict: 'confirmed',
    reason: 'Observed the recorded view.',
  });
  assert.equal(model.visualReviewKind('check-1', { ...lead, id: 'other' }), null);
  const person = { ...lead, subjectKind: 'person' as const };
  assert.equal('reason' in model.visualReviewRequest('check-1', person, 'confirmed'), false);
  assert.throws(() => model.visualReviewRequest('check-1', person, 'rejected'), /needs a reason/);
  assert.equal(
    model.judgmentRows(person).find(({ claim }) => claim.id === 'check-1')!.prevalidation,
    null,
  );
  assert.throws(
    () => model.visualReviewRequest('check-1', lead, 'confirmed', ''),
    /needs a reason/,
  );
  assert.equal(
    createEvidenceReviewModel({
      package: input,
      visualReviewAuthority: authority,
    }).visualReviewKind('check-1', lead),
    null,
  );
  assert.equal(JSON.stringify(input), original);
});

for (const { name, count, evidence } of [
  { name: 'task beside a recorded attempt', count: 4, evidence: ['artifacts/state.json'] },
  {
    name: 'summary without claim package',
    count: 3,
    evidence: ['artifacts/recipe-run/summary.json'],
  },
  {
    name: 'media without claim package',
    count: 3,
    evidence: ['artifacts/recipe-run/videos/recording.mp4'],
  },
]) {
  test(`retained ${name} is display only across the cutover`, () => {
    const ledger = {
      schemaVersion: 1 as const,
      criteria: Array.from({ length: count }, (_, index) => ({
        id: `AC-${index + 1}`,
        text: `Registered behavior ${index + 1}`,
        verdict: 'proven' as const,
        evidence,
        recipeNodes: [],
        updatedAt: '2026-10-12T00:00:00.000Z',
      })),
    };
    const historical = createEvidenceReviewModel({ ledger, contractVersion: 0 });
    assert.equal(historical.packageStatus, null, 'a task ledger alone is not a package');
    assert.ok(historical.warnings.some((warning) => warning.includes('retained display only')));
    assert.equal(
      historical.summary.proven,
      count,
      'totals describe the supplied historical ledger',
    );
    assert.ok(
      historical.claims.every(
        (claim) =>
          historical.selectClaim(claim.id)?.timing === 'untimed' && claim.moments.length === 0,
      ),
    );
    const current = createEvidenceReviewModel({ ledger, contractVersion: 1 });
    assert.equal(current.packageStatus?.status, 'Invalid');
    assert.ok(current.claims.every((claim) => claim.moments.length === 0));
    assert.equal(ledger.criteria[0]?.updatedAt, '2026-10-12T00:00:00.000Z');
  });
}

function boundComparisonPackage(
  id: string,
  role: 'before' | 'after',
  sourceCommit: string,
  durationMs = 3000,
): RecordedEvidencePackageInput {
  const pkg = qaPackage(1, durationMs);
  assert.ok(pkg.claims);
  pkg.claims.recipeRunId = id;
  pkg.recipeRunId = id;
  for (const claim of pkg.claims.criteria)
    claim.moments = claim.moments.map((moment) => ({ ...moment, recipeRunId: id }));
  assert.ok(
    pkg.invocation && typeof pkg.invocation === 'object' && 'recipeRunId' in pkg.invocation,
  );
  pkg.invocation.recipeRunId = id;
  assert.ok(
    pkg.summary &&
      typeof pkg.summary === 'object' &&
      'recipeRunId' in pkg.summary &&
      'invocationDigest' in pkg.summary,
  );
  pkg.summary.recipeRunId = id;
  pkg.summary.invocationDigest = digestRecipeDocument(pkg.invocation);
  assert.ok(
    pkg.manifest &&
      typeof pkg.manifest === 'object' &&
      'artifacts' in pkg.manifest &&
      Array.isArray(pkg.manifest.artifacts),
  );
  for (const artifact of pkg.manifest.artifacts)
    if (artifact.path === 'stills/1.png')
      artifact.capture = {
        ac: 'check-1',
        role,
        recipeRunId: id,
        nodeId: 'assert-1',
        traceIndex: 1,
        sourceCommit,
        sourceDirty: false,
      };
  pkg.artifactDigests = {
    ...Object.fromEntries((pkg.artifactPaths ?? []).map((file) => [file, digest(file)])),
    ...pkg.artifactDigests,
  };
  return pkg;
}

function withComparison(
  head: RecordedEvidencePackageInput,
  baseline: RecordedEvidencePackageInput,
): RecordedEvidencePackageInput {
  assert.ok(baseline.claims);
  const artifactRoot = `comparison-dependencies/${baseline.claims.recipeRunId}`;
  const refs = [
    {
      artifactRoot,
      recipeRunId: baseline.claims.recipeRunId,
      closureIdentity: recordedEvidenceClosureIdentity(baseline),
    },
  ];
  assert.ok(head.manifest && typeof head.manifest === 'object');
  head.manifest = { ...head.manifest, comparisonDependencies: refs };
  assert.ok(head.invocation && typeof head.invocation === 'object');
  head.invocation = { ...head.invocation, comparisonDependencies: refs };
  assert.ok(head.summary && typeof head.summary === 'object');
  head.summary = { ...head.summary, invocationDigest: digestRecipeDocument(head.invocation) };
  head.comparisonDependencies = [{ artifactRoot, input: baseline }];
  head.artifactPaths = [
    ...(head.artifactPaths ?? []),
    ...(baseline.artifactPaths ?? []).map((file) => `${artifactRoot}/${file}`),
  ];
  head.artifactDigests = {
    ...head.artifactDigests,
    ...Object.fromEntries(
      Object.entries(baseline.artifactDigests).map(([file, digest]) => [
        `${artifactRoot}/${file}`,
        digest,
      ]),
    ),
  };
  return head;
}

test('comparison roles retain original executions, exact claim rows, independent timestamps and shared transform state', () => {
  const baseSha = '1'.repeat(40),
    headSha = '2'.repeat(40);
  const source = withComparison(
    boundComparisonPackage('head', 'after', headSha),
    boundComparisonPackage('baseline', 'before', baseSha),
  );
  const model = createEvidenceReviewModel({
    package: source,
    artifactPrefix: 'artifacts/selected/',
    comparisonSnapshot: { baseSha, headSha },
    criterionSourceUrl: 'https://example.test/TAT-1',
  });
  assert.deepEqual(model.errors, []);
  assert.equal(model.comparisons.length, 2); // The uncaptured QA case remains a row too.
  const row = model.comparisons.find((row) => row.claim.id === 'check-1')!;
  assert.equal(row.sourceUrl, 'https://example.test/TAT-1');
  assert.equal(row.selectedBefore?.recipeRunId, 'baseline');
  assert.equal(row.selectedAfter?.recipeRunId, 'head');
  assert.notEqual(row.selectedBefore?.identity, row.selectedAfter?.identity);
  assert.equal(row.selectedBefore?.clips[0]?.moment?.recipeRunId, 'baseline');
  assert.equal(model.markerSeekMs(row.selectedBefore!.clips[0]!.videoPath, 1, 'start'), 400);
  model.setComparisonTransform({ scale: 3, x: 0.25, y: 0.8 });
  assert.deepEqual(model.comparisonTransform, { scale: 3, x: 0.25, y: 0.8 });
  assert.equal(
    model.chooseComparisonMedia('check-1', 'before', row.selectedBefore!.identity),
    true,
  );
  assert.deepEqual(model.comparisonTransform, { scale: 1, x: 0.5, y: 0.5 });
  model.setComparisonFilter('before');
  assert.equal(
    model.comparisonView.rows.find((row) => row.claim.id === 'check-1')!.after.length,
    0,
  );
  assert.equal(model.comparisonView.unassigned.length, 0);
  model.setComparisonFilter('unassigned');
  assert.equal(model.comparisonView.rows.length, 0);
  assert.equal(model.comparisonView.unassigned.length, 2); // Original full-run videos have no authored role.
  const selected = [row.selectedBefore!, row.selectedAfter!].map((media) => ({
    path: media.artifactPath,
    purpose: 'screenshot',
  }));
  assert.equal(model.pairedArtifacts(selected).length, 1);
  assert.equal(model.artifactRole(selected[0]!.path), 'before');
  assert.equal(model.artifactRole(selected[1]!.path), 'after');
  assert.equal(model.pairedArtifacts(selected.slice(1)).length, 0);
  assert.equal(model.artifactRole('before-AC1.png'), null);

  const mismatched = createEvidenceReviewModel({
    package: source,
    comparisonSnapshot: { baseSha: '3'.repeat(40), headSha },
  });
  assert.equal(mismatched.comparisonErrors[0]?.code, 'comparison-source-mismatch');
  assert.equal(
    mismatched.comparisons.find((row) => row.claim.id === 'check-1')!.selectedBefore,
    undefined,
  );
  assert.equal(
    mismatched.chooseComparisonMedia('check-1', 'before', row.selectedBefore!.identity),
    false,
  );
  assert.equal(
    row.claim.status?.verdict,
    source.claims?.criteria.find((claim) => claim.id === 'check-1')?.verdict,
  );
});

test('unbound media stays Unassigned and an empty claim row never borrows a Before or After', () => {
  const model = createEvidenceReviewModel({
    criteria: [{ id: 'AC-1', text: 'Controls fit.' }],
    artifacts: [
      { path: 'artifacts/before-AC1.png', purpose: 'video-before', sha256: 'a'.repeat(64) },
      { path: 'artifacts/after-AC1.png', purpose: 'video-after', sha256: 'a'.repeat(64) },
    ],
  });
  assert.equal(model.comparisons.length, 1);
  assert.equal(model.comparisons[0]?.before.length, 0);
  assert.equal(model.comparisons[0]?.after.length, 0);
  assert.equal(model.unassigned.length, 2);
  assert.equal(model.unassigned[0]?.timing, 'untimed');
  assert.equal(model.selectComparisonMedia(model.unassigned[0]!.identity)?.timing, 'untimed');
});

test('baseline outside its own recording never borrows measured timing from the same head trace index', () => {
  const baseSha = '1'.repeat(40),
    headSha = '2'.repeat(40);
  const model = createEvidenceReviewModel({
    package: withComparison(
      boundComparisonPackage('head', 'after', headSha),
      boundComparisonPackage('baseline', 'before', baseSha, 350),
    ),
    comparisonSnapshot: { baseSha, headSha },
  });
  assert.deepEqual(model.errors, []);
  const row = model.comparisons.find((row) => row.claim.id === 'check-1')!;
  const before = row.selectedBefore!;
  assert.equal(before.clips.length, 0);
  assert.equal(before.timing, 'outside-recording');
  assert.equal(model.selectComparisonMedia(before.identity)?.timing, 'outside-recording');
  assert.equal(model.markerSeekMs('comparison-dependencies/baseline/video.mp4', 1, 'start'), null);
  assert.equal(model.markerSeekMs('video.mp4', 1, 'start'), 400);
});

test('pending visual criteria stay visible before evidence loads and after a read error without granting review authority', () => {
  const input: RecordedEvidencePackageInput = JSON.parse(
    readFileSync(
      new URL('../../recipe-runner/test/fixtures/visual-review-package.json', import.meta.url),
      'utf8',
    ),
  ).input;
  const person: SelfPrincipalSummary = {
    id: 'operator',
    displayName: 'Operator',
    subjectKind: 'person',
    roles: [],
  };
  for (const readErrors of [[], ['Evidence request timed out']]) {
    const model = createEvidenceReviewModel({ ledger: input.claims, readErrors });
    assert(model.pendingVisualClaimIds.includes('check-1'));
    assert.equal(model.visualReviewKind('check-1', person), null);
    assert.throws(() =>
      model.visualReviewRequest('check-1', person, 'confirmed', 'Inspected the view.'),
    );
  }
});

test('a gate package the worker re-recorded reads as replaced, with no details from it', () => {
  // Run directory stamps are UTC; labels show the viewer's local time.
  const local = (iso: string) => {
    const time = new Date(iso);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `Recording ${pad(time.getHours())}:${pad(time.getMinutes())}`;
  };
  const pkg = qaPackage(2);
  const packagePath = 'recipe-runs/20261101072653297-84101';
  const ledger = (recipeRunId: string, evidence: string) => ({
    ...pkg.claims!,
    recipeRunId,
    criteria: pkg.claims!.criteria.map((criterion) => ({ ...criterion, evidence: [evidence] })),
  });
  const current = createEvidenceReviewModel({
    package: pkg,
    packagePath,
    ledger: ledger('qa-attempt', `artifacts/${packagePath}/trace.json`),
  });
  assert.deepEqual(current.recording, { label: local('2026-11-01T07:26:00Z') });
  assert.ok(current.currentOccurrences.length > 0);
  assert.notEqual(current.packageStatus?.status, 'Replaced');

  const replaced = createEvidenceReviewModel({
    package: pkg,
    packagePath,
    ledger: ledger('newer-attempt', 'artifacts/recipe-runs/20261101082718242-33108/trace.json'),
  });
  assert.deepEqual(replaced.recording, {
    label: local('2026-11-01T07:26:00Z'),
    replacedBy: local('2026-11-01T08:27:00Z'),
  });
  assert.deepEqual(
    {
      status: replaced.packageStatus?.status,
      tone: replaced.packageStatus?.tone,
      summary: replaced.packageStatus?.summary,
      action: replaced.packageStatus?.action,
      issues: replaced.packageStatus?.issues,
    },
    {
      status: 'Replaced',
      tone: 'info',
      summary: `Evidence replaced by ${local('2026-11-01T08:27:00Z').replace('Recording', 'recording')}`,
      action: 'Refresh the gate package or re-run the recipe.',
      issues: [],
    },
  );
  // Panel-level evidence details describe the current recording only; the replaced package's
  // own steps stay with its rows and clips.
  assert.deepEqual(replaced.currentOccurrences, []);
  assert.deepEqual(replaced.displayWarnings, []);
  assert.equal(replaced.occurrences.length, current.occurrences.length);
  // Validity is unchanged: the mismatch still refuses measured proof.
  assert.ok(replaced.errors.includes('The task ledger belongs to another recipe execution.'));
});
