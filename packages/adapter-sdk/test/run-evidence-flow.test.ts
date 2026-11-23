import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  digestRecipeDocument,
  isRecord,
  recipeTraceEntries,
  type RecordedEvidencePackageInput,
} from '@farmslot/protocol';

import {
  buildRecipeInvocationTree,
  createRecipeFlowProjection,
} from '../../recipe-runner/src/core/flow.js';
import { fixtureTree } from '../../recipe-runner/test/flow.fixture.js';
import { createEvidenceReviewModel, runEvidenceView } from '../src/evidence.js';

const tree = fixtureTree();
const entry = (nodeId: string, extra: Record<string, unknown> = {}) => ({
  nodeId,
  action: tree.nodes.find((node) => node.id === nodeId)?.action ?? 'wait',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:00:00.010Z',
  durationMs: 10,
  ok: true,
  ...extra,
});

const visualFixture = () =>
  (
    JSON.parse(
      fs.readFileSync(
        new URL('../../recipe-runner/test/fixtures/visual-review-package.json', import.meta.url),
        'utf8',
      ),
    ) as { input: RecordedEvidencePackageInput }
  ).input;

test('pending evidence never substitutes a prior recording trace for the current attempt', () => {
  const source = visualFixture();
  const failed = entry('first/nested/observe', { ok: false });
  const model = createEvidenceReviewModel({
    evidencePending: true,
    pendingTrace: { entries: [failed] },
    pendingFlow: {
      tree,
      update: createRecipeFlowProjection(tree, 'new-attempt').start('first/nested/observe'),
    },
    recordings: Object.values(source.timelines).map((timeline) => ({
      timeline,
      videoPath: timeline.videoPath,
      videoDigest: timeline.videoDigest,
      trace: source.trace,
    })),
  });
  const view = runEvidenceView(model);
  assert.equal(view.steps.length, 1);
  assert.equal(view.steps[0]?.nodeId, failed.nodeId);
  assert.equal(view.steps[0]?.ok, false);
  assert.equal(view.steps[0]?.cue, null);
  assert.ok(model.errors.some((error) => error.includes('different execution trace')));
  assert.equal(view.flow?.recipeRunId, 'new-attempt', 'bad media cannot discard the prepared flow');
  const occurrence = view.flow?.nodes.find((node) => node.id === failed.nodeId)?.occurrences[0];
  assert.equal(occurrence?.status, 'fail');
  assert.equal(occurrence?.cue, null);
});

test('a first pending HUD update has no occurrences before its current trace is written', () => {
  const source = visualFixture();
  for (const withPriorRecording of [true, false]) {
    const model = createEvidenceReviewModel({
      evidencePending: true,
      pendingFlow: {
        tree,
        update: createRecipeFlowProjection(tree, 'first-hud').start('first/nested/observe'),
      },
      ...(withPriorRecording
        ? {
            recordings: Object.values(source.timelines).map((timeline) => ({
              timeline,
              videoPath: timeline.videoPath,
              videoDigest: timeline.videoDigest,
              trace: source.trace,
            })),
          }
        : {}),
    });
    const view = runEvidenceView(model);
    assert.deepEqual(view.steps, []);
    assert.equal(view.flow?.recipeRunId, 'first-hud');
    assert.ok(view.flow?.nodes.every((node) => node.occurrences.length === 0));
    assert.equal(
      view.flow?.nodes.find((node) => node.id === 'first/nested/observe')?.status,
      'running',
    );
  }
});

test('segmented media coverage is lazy and computed once for an occurrence in the last segment', (t) => {
  const source = visualFixture();
  const original = Object.values(source.timelines)[0]!;
  const trace = { entries: [recipeTraceEntries(source.trace)![0]] };
  const count = 32;
  const recordings = Array.from({ length: count }, (_, index) => {
    const videoPath = `segment-${index}.mp4`;
    const timeline = {
      ...original,
      videoPath,
      traceDigest: digestRecipeDocument(trace.entries),
      markers: index === count - 1 ? [{ ...original.markers[0]!, traceIndex: 0 }] : [],
    };
    return { timeline, videoPath, videoDigest: timeline.videoDigest, trace, gapBefore: false };
  });
  let segmentVisits = 0;
  const flatMap = Array.prototype.flatMap;
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'flatMap');
  assert.ok(descriptor);
  t.after(() => Object.defineProperty(Array.prototype, 'flatMap', descriptor));
  Object.defineProperty(Array.prototype, 'flatMap', {
    ...descriptor,
    value: function (
      this: unknown[],
      callback: (value: unknown, index: number, values: unknown[]) => unknown,
      thisArg?: unknown,
    ) {
      return flatMap.call(this, (value, index, values) => {
        if (
          isRecord(value) &&
          typeof value.videoPath === 'string' &&
          typeof value.videoDigest === 'string' &&
          !('timeline' in value)
        )
          segmentVisits++;
        return callback.call(thisArg, value, index, values);
      });
    },
  });
  assert.ok(isRecord(source.recipe));
  const prepared = buildRecipeInvocationTree({
    rootRef: '$root',
    root: source.recipe,
    recipes: new Map(),
  });
  const model = createEvidenceReviewModel({
    evidencePending: true,
    pendingTrace: trace,
    recordings,
    pendingFlow: {
      tree: prepared,
      update: createRecipeFlowProjection(prepared, 'segmented-attempt').snapshot(),
    },
  });
  assert.deepEqual(model.errors, []);
  const atCreation = segmentVisits;
  const view = runEvidenceView(model);
  t.diagnostic(
    `segment visits: construction ${atCreation}, first projection ${segmentVisits}, segments ${count}`,
  );
  assert.equal(atCreation, 0, 'legacy-only model construction does not join flow cues');
  assert.ok(segmentVisits <= count * 2, `segment visits: ${segmentVisits}`);
  assert.equal(view.steps[0]?.cue?.videoPath, `segment-${count - 1}.mp4`);
  const flowCue = view.flow?.nodes.find((node) => node.id === original.markers[0]!.nodeId)
    ?.occurrences[0]?.cue;
  assert.deepEqual(flowCue, view.steps[0]?.cue);
  const previousVisits = segmentVisits;
  for (const recording of recordings) {
    model.markerSeekMs(recording.videoPath, 0, 'start');
    model.markerSeekMs(recording.videoPath, 0, 'end');
  }
  runEvidenceView(model);
  assert.equal(segmentVisits, previousVisits, 'all cue endpoints share the occurrence coverage');
});

test('comparison-only reads leave Flow and Story coverage joins deferred', (t) => {
  const source = visualFixture();
  let segmentVisits = 0;
  const flatMap = Array.prototype.flatMap;
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'flatMap');
  assert.ok(descriptor);
  t.after(() => Object.defineProperty(Array.prototype, 'flatMap', descriptor));
  Object.defineProperty(Array.prototype, 'flatMap', {
    ...descriptor,
    value: function (
      this: unknown[],
      callback: (value: unknown, index: number, values: unknown[]) => unknown,
      thisArg?: unknown,
    ) {
      return flatMap.call(this, (value, index, values) => {
        if (
          isRecord(value) &&
          typeof value.videoPath === 'string' &&
          typeof value.videoDigest === 'string' &&
          !('timeline' in value)
        )
          segmentVisits++;
        return callback.call(thisArg, value, index, values);
      });
    },
  });
  const model = createEvidenceReviewModel({ package: source });
  assert.deepEqual(model.errors, []);
  const constructed = segmentVisits;
  assert.ok(model.comparisonView.rows.length > 0);
  const compared = segmentVisits;
  const view = runEvidenceView(model);
  t.diagnostic(
    `comparison-first segment visits: construction ${constructed}, comparison ${compared}, projection ${segmentVisits}`,
  );
  assert.equal(
    compared,
    constructed,
    'comparison rows never request the flow/criterion projection',
  );
  assert.ok(
    segmentVisits > compared,
    'the explicit evidence projection performs the deferred join',
  );
  assert.ok(view.steps.length > 0);
  const projected = segmentVisits;
  model.comparisonView.rows;
  assert.equal(runEvidenceView(model).updateId, view.updateId);
  assert.equal(segmentVisits, projected, 'comparison and evidence rereads reuse checked coverage');
});

test('an idle HUD update has unknown outcome until an explicit summary is available', () => {
  for (const outcome of ['pass', 'fail', 'unknown'] as const) {
    const progress = createRecipeFlowProjection(tree, 'terminal-attempt');
    progress.start('first/nested/observe');
    progress.complete('first/nested/observe', outcome === 'pass');
    const model = createEvidenceReviewModel({
      evidencePending: true,
      pendingTrace: { entries: [entry('first/nested/observe', { ok: outcome === 'pass' })] },
      pendingFlow: { tree, update: progress.finish(outcome) },
    });
    assert.equal(runEvidenceView(model).flow?.nodes[0]?.status, 'unknown', outcome);
  }
  const empty = createEvidenceReviewModel({
    evidencePending: true,
    pendingTrace: { entries: [] },
    pendingFlow: {
      tree,
      update: createRecipeFlowProjection(tree, 'empty-attempt').finish('pass'),
    },
  });
  assert.equal(runEvidenceView(empty).flow?.nodes[0]?.status, 'unknown');
});

test('marker lookup grows linearly and Flow and Story share qualified cues', (t) => {
  const source = visualFixture();
  const original = Object.values(source.timelines)[0]!;
  const entries = recipeTraceEntries(source.trace)!;
  const count = 128;
  const trace = { entries: Array.from({ length: count }, () => structuredClone(entries[0])) };
  let markerReads = 0;
  const find = Array.prototype.find;
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'find');
  assert.ok(descriptor);
  t.after(() => Object.defineProperty(Array.prototype, 'find', descriptor));
  Object.defineProperty(Array.prototype, 'find', {
    ...descriptor,
    value: function (
      this: unknown[],
      predicate: (value: unknown, index: number, values: unknown[]) => unknown,
      thisArg?: unknown,
    ) {
      return find.call(this, (value, index, values) => {
        if (isRecord(value) && 'traceIndex' in value && 'startRangeMs' in value) markerReads++;
        return predicate.call(thisArg, value, index, values);
      });
    },
  });
  const timeline = {
    ...original,
    traceDigest: digestRecipeDocument(trace.entries),
    markers: Array.from({ length: count }, (_, index) => ({
      ...original.markers[0]!,
      traceIndex: index,
    })),
  };
  assert.ok(isRecord(source.recipe));
  const prepared = buildRecipeInvocationTree({
    rootRef: '$root',
    root: source.recipe,
    recipes: new Map(),
  });
  const model = createEvidenceReviewModel({
    evidencePending: true,
    pendingTrace: trace,
    pendingFlow: {
      tree: prepared,
      update: createRecipeFlowProjection(prepared, 'indexed-attempt').snapshot(),
    },
    recordings: [
      { timeline, trace, videoPath: timeline.videoPath, videoDigest: timeline.videoDigest },
    ],
  });
  assert.deepEqual(model.errors, []);
  const view = runEvidenceView(model);
  assert.equal(view.steps.length, count);
  t.diagnostic(`marker comparisons: ${markerReads} for ${count} markers`);
  assert.ok(markerReads < count * 20, `marker reads: ${markerReads} for ${count} markers`);
  const flowCues = view.flow?.nodes
    .find((node) => node.id === original.markers[0]!.nodeId)
    ?.occurrences.map((occurrence) => occurrence.cue);
  assert.deepEqual(
    flowCues,
    view.steps.map((step) => step.cue),
  );
  const previousReads = markerReads;
  runEvidenceView(model);
  assert.equal(markerReads, previousReads, 'unchanged projections do not scan the marker history');
});

test('projects nested and repeated calls through the existing evidence export with qualified timing', () => {
  const progress = createRecipeFlowProjection(tree, 'execution-1');
  const update = progress.start('first/nested/read');
  const model = createEvidenceReviewModel({
    evidencePending: true,
    pendingTrace: { entries: [entry('first/nested/observe')] },
    pendingFlow: { tree, update },
  });
  const view = runEvidenceView(model);
  assert.equal(view.flow?.recipeRunId, 'execution-1');
  assert.equal(view.flow?.rootId, '$root');
  assert.ok(view.flow);
  assert.deepEqual(view.flow?.progress, update.progress);
  const first = view.flow?.nodes.find((node) => node.id === 'first/nested/read');
  const second = view.flow?.nodes.find((node) => node.id === 'second/nested/read');
  assert.ok(first && second);
  assert.deepEqual(first.breadcrumbIds, ['$root', 'first', 'first/nested', 'first/nested/read']);
  assert.equal(first.depth, 3);
  assert.equal(first.parentId, 'first/nested');
  assert.equal(first.status, 'running');
  assert.equal(second.status, 'unknown');
  assert.ok(view.flow?.nodes.every((node) => node.timing));
  assert.equal(first.timing?.inclusiveMs, null);
  assert.deepEqual(
    view.steps.map((step) => step.nodeId),
    ['first/nested/observe'],
  );
  assert.equal(view.steps[0]?.cue, null);
  const before = view.updateId;
  model.selectOccurrence(0);
  assert.equal(runEvidenceView(model).updateId, before, 'selection does not mutate snapshot facts');
  view.flow.nodes[0]!.label = 'caller-owned display change';
  assert.notEqual(runEvidenceView(model).flow?.nodes[0]?.label, 'caller-owned display change');
  assert.equal(
    runEvidenceView(model).updateId,
    before,
    'returned JSON cannot poison the cached source',
  );
});

test('records branch choices without treating unfinished work as skipped', () => {
  const progress = createRecipeFlowProjection(tree, 'execution-1', true);
  progress.start('pick');
  const update = progress.complete('pick', true, 'accept');
  const view = runEvidenceView(
    createEvidenceReviewModel({
      evidencePending: true,
      pendingTrace: { entries: [entry('pick', { case: 'yes', next: 'accept' })] },
      pendingFlow: { tree, update },
    }),
  );
  assert.equal(view.flow?.nodes.find((node) => node.id === 'reject')?.status, 'skipped');
  assert.equal(view.flow?.nodes.find((node) => node.id === 'reject_extra')?.status, 'skipped');
  assert.equal(view.flow?.nodes.find((node) => node.id === 'accept')?.status, 'unknown');
  const occurrence = view.flow?.nodes.find((node) => node.id === 'pick')?.occurrences[0];
  assert.equal(occurrence?.recipeRunId, 'execution-1');
  assert.equal(occurrence?.traceIndex, 0);
  assert.deepEqual(occurrence?.decision, { case: 'yes', next: 'accept' });
  assert.equal(view.flow?.progress.total, null);
  assert.equal(view.flow?.progress.remaining, null);
});

test('snapshot equality covers active and evidence changes without a new trace entry', () => {
  const projection = createRecipeFlowProjection(tree, 'execution-1');
  const update = projection.start('first/nested/observe');
  const trace = { entries: [entry('first/nested/observe')] };
  const input = { evidencePending: true, pendingTrace: trace, pendingFlow: { tree, update } };
  const a = runEvidenceView(createEvidenceReviewModel(input));
  const same = runEvidenceView(createEvidenceReviewModel(structuredClone(input)));
  assert.equal(typeof a.updateId, 'string');
  assert.equal(a.updateId, same.updateId);
  const active = runEvidenceView(
    createEvidenceReviewModel({
      ...input,
      pendingFlow: { tree, update: projection.start('first/nested/read') },
    }),
  );
  assert.notEqual(a.updateId, active.updateId);
  const files = runEvidenceView(
    createEvidenceReviewModel({
      ...input,
      pendingTrace: {
        entries: [
          entry('first/nested/observe', { artifacts: [{ path: 'observed.json', kind: 'data' }] }),
        ],
      },
    }),
  );
  assert.equal(files.steps.length, a.steps.length);
  assert.notEqual(files.updateId, a.updateId);
  const failed = runEvidenceView(
    createEvidenceReviewModel({
      ...input,
      pendingTrace: { entries: [entry('first/nested/observe', { ok: false })] },
    }),
  );
  assert.notEqual(failed.updateId, a.updateId);
  const run = { id: 'gateway-id', status: 'running' } as const;
  assert.notEqual(
    runEvidenceView(createEvidenceReviewModel(input), run).updateId,
    runEvidenceView(createEvidenceReviewModel(input), {
      ...run,
      title: 'Different displayed title',
    }).updateId,
  );
});

test('legacy and incompatible flow data preserve chronological evidence without an invented tree', () => {
  const pendingTrace = { entries: [entry('first/nested/observe')] };
  const legacy = runEvidenceView(
    createEvidenceReviewModel({ evidencePending: true, pendingTrace }),
  );
  assert.equal(legacy.flow, null);
  assert.equal(legacy.steps.length, 1);
  const update = createRecipeFlowProjection(tree, 'execution-1').snapshot();
  const invalid = runEvidenceView(
    createEvidenceReviewModel({
      evidencePending: true,
      pendingTrace,
      pendingFlow: { tree: { ...tree, nodes: [...tree.nodes, tree.nodes[0]!] }, update },
    }),
  );
  assert.equal(invalid.flow, null);
  assert.deepEqual(invalid.steps, legacy.steps);
  assert.ok(invalid.warnings.some((warning) => warning.includes('flow')));
});

test('flow occurrence cues reuse checked media markers and remain null without a measured recording', () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      new URL('../../recipe-runner/test/fixtures/visual-review-package.json', import.meta.url),
      'utf8',
    ),
  ) as { input: RecordedEvidencePackageInput };
  const source = fixture.input;
  assert.ok(isRecord(source.recipe));
  const prepared = buildRecipeInvocationTree({
    rootRef: '$root',
    root: source.recipe,
    recipes: new Map(),
  });
  const progress = createRecipeFlowProjection(prepared, 'qa-attempt');
  for (const value of recipeTraceEntries(source.trace) ?? []) {
    assert.ok(isRecord(value) && typeof value.nodeId === 'string');
    progress.start(value.nodeId);
    progress.complete(
      value.nodeId,
      value.ok === true,
      typeof value.next === 'string' ? value.next : undefined,
    );
  }
  const pendingFlow = { tree: prepared, update: progress.finish('pass') };
  const input = { evidencePending: true, pendingTrace: source.trace, pendingFlow };
  const measuredModel = createEvidenceReviewModel({
    ...input,
    recordings: Object.values(source.timelines).map((timeline) => ({
      timeline,
      videoPath: timeline.videoPath,
      videoDigest: timeline.videoDigest,
      trace: source.trace,
    })),
  });
  const seek = measuredModel.markerSeekMs.bind(measuredModel);
  let markerReads = 0;
  measuredModel.markerSeekMs = (...args) => {
    markerReads++;
    return seek(...args);
  };
  const measured = runEvidenceView(measuredModel);
  const firstProjectionReads = markerReads;
  assert.equal(firstProjectionReads, 0, 'Story reuses the model-owned qualified cue');
  runEvidenceView(measuredModel);
  assert.equal(
    markerReads,
    firstProjectionReads,
    'unchanged renders do not rejoin trace/media history',
  );
  const occurrence = measured.flow?.nodes.find((node) => node.id === 'read-1')?.occurrences[0];
  assert.equal(occurrence?.recipeRunId, 'qa-attempt');
  assert.equal(occurrence?.cue?.startMs, 200);
  assert.deepEqual(occurrence?.cue, measured.steps[0]?.cue);
  const untimed = runEvidenceView(createEvidenceReviewModel(input));
  assert.equal(untimed.flow?.nodes.find((node) => node.id === 'read-1')?.occurrences[0]?.cue, null);
  assert.notEqual(untimed.updateId, measured.updateId);
});

test('a pending task ledger without an execution ID preserves the producer identity', () => {
  const model = createEvidenceReviewModel({
    evidencePending: true,
    ledger: { schemaVersion: 2, criteria: [] },
    pendingTrace: { entries: [entry('first/nested/observe')] },
    pendingFlow: {
      tree,
      update: createRecipeFlowProjection(tree, 'current-attempt').start('first/nested/read'),
    },
  });
  const view = runEvidenceView(model);
  assert.equal(view.flow?.recipeRunId, 'current-attempt');
  assert.equal(
    view.flow?.nodes.find((node) => node.id === 'first/nested/observe')?.occurrences[0]
      ?.recipeRunId,
    'current-attempt',
  );
  assert.ok(!view.warnings.some((warning) => warning.includes('execution identity')));
});

test('pending flow refuses an update from a different recorded execution', () => {
  const source = visualFixture();
  assert.ok(isRecord(source.recipe) && source.claims);
  const prepared = buildRecipeInvocationTree({
    rootRef: '$root',
    root: source.recipe,
    recipes: new Map(),
  });
  for (const recipeRunId of [source.claims.recipeRunId, 'another-execution']) {
    const currentTrace = structuredClone(recipeTraceEntries(source.trace)!);
    if (recipeRunId !== source.claims.recipeRunId) {
      assert.ok(isRecord(currentTrace[1]));
      currentTrace[1].ok = false;
    }
    const model = createEvidenceReviewModel({
      evidencePending: true,
      ledger: source.claims,
      pendingTrace: { entries: currentTrace },
      pendingFlow: {
        tree: prepared,
        update: createRecipeFlowProjection(prepared, recipeRunId).snapshot(),
      },
    });
    const view = runEvidenceView(model);
    assert.ok(view.steps.length > 0, 'legacy Story remains usable');
    if (recipeRunId === source.claims.recipeRunId) {
      assert.equal(view.flow?.recipeRunId, recipeRunId);
      assert.ok(view.criteria.some((claim) => (claim.occurrences?.length ?? 0) > 0));
    } else {
      assert.equal(view.flow, null);
      assert.equal(view.steps[1]?.ok, false, 'the current failing trace stays visible in Story');
      assert.ok(view.warnings.some((warning) => warning.includes('execution identity')));
      assert.ok(
        view.criteria.every((claim) => claim.occurrences?.length === 0),
        'a stale ledger cannot label the current trace',
      );
      for (const claim of view.criteria) assert.deepEqual(model.criterionOccurrences(claim.id), []);
    }
  }
});

test('a replaced package cannot add current-execution occurrence bindings', () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      new URL('../../recipe-runner/test/fixtures/visual-review-package.json', import.meta.url),
      'utf8',
    ),
  ) as { input: RecordedEvidencePackageInput };
  const view = runEvidenceView(
    createEvidenceReviewModel({
      package: fixture.input,
      ledger: { ...fixture.input.claims!, recipeRunId: 'new-execution' },
    }),
  );
  assert.deepEqual(view.steps, []);
  assert.equal(view.flow, null);
  assert.ok(view.criteria.every((claim) => claim.occurrences?.length === 0));
});

test('one shared occurrence binds two criteria without duplicating the invocation', () => {
  const prepared = buildRecipeInvocationTree({
    rootRef: '$root',
    recipes: new Map(),
    root: {
      workflow: {
        entry: 'check',
        nodes: {
          check: {
            action: 'assert_output',
            intent: 'Check shared work',
            proves: ['AC-1', 'AC-2'],
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });
  const progress = createRecipeFlowProjection(prepared, 'shared-execution');
  progress.start('check');
  const update = progress.complete('check', true, 'done');
  const view = runEvidenceView(
    createEvidenceReviewModel({
      evidencePending: true,
      criteria: [
        { id: 'AC-1', text: 'First criterion' },
        { id: 'AC-2', text: 'Second criterion' },
      ],
      pendingTrace: {
        entries: [
          { ...entry('check'), action: 'assert_output', proves: ['AC-1', 'AC-2'], next: 'done' },
        ],
      },
      pendingFlow: { tree: prepared, update },
    }),
  );
  const shared = view.flow?.nodes.find((node) => node.id === 'check');
  assert.ok(shared);
  assert.equal(shared.occurrences.length, 1);
  assert.deepEqual(shared.occurrences[0]?.claimIds, ['AC-1', 'AC-2']);
  const references = view.criteria.map((claim) =>
    claim.occurrences?.map(({ recipeRunId, traceIndex }) => [recipeRunId, traceIndex]),
  );
  assert.deepEqual(references, [[['shared-execution', 0]], [['shared-execution', 0]]]);
  assert.ok(view.criteria.every((claim) => claim.verdict === null));
});
