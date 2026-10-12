import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  type AcceptanceStatusLedger,
  digestRecipeDocument,
  type RecipeClaimDeclaration,
  type RecipeRecordingTimelineDocument,
  type RecordedEvidencePackageInput,
} from '@farmslot/protocol';

import type { TraceEntry } from '../../recipe-runner/src/core/types.js';
import type { ProofNode } from '../../recipe-runner/src/evidence/assertions.js';
import { deriveRecipeClaims } from '../../recipe-runner/src/evidence/claims.js';
import {
  createEvidenceReviewModel,
  type EvidenceReviewRecordingInput,
  readEvidenceReviewReport,
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
  assert.equal(model.selection?.caption, 'Report snapshot retained-output');
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
    /bytes no longer match/,
  );
  const stale = createEvidenceReviewModel({
    report: { ...report, manifestDigest: 'new-manifest' },
    reportSnapshot,
  });
  await assert.rejects(
    readEvidenceReviewReport(stale, async () => bytes),
    /no longer matches/,
  );
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
    /bytes no longer match/,
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
  assert.equal(stale.selectReport(), null);
  await assert.rejects(
    readEvidenceReviewReport(stale, async () => new TextEncoder().encode(body)),
    /no longer matches/,
  );
});

test('unknown reads stay informational while identified current-contract failures are red', () => {
  const unknown = createEvidenceReviewModel({
    readErrors: ['Select a retained recipe execution from the gate package.'],
  });
  assert.equal(unknown.packageStatus?.status, 'Invalid');
  assert.equal(unknown.packageStatus?.tone, 'info');
  const pkg = qaPackage(1);
  pkg.summary = undefined;
  assert.equal(createEvidenceReviewModel({ package: pkg }).packageStatus?.tone, 'error');
});

test('an authored recipe beside legacy media does not identify an executed Recipe v1 package', () => {
  const model = createEvidenceReviewModel({
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
