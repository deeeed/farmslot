import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
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

test('projects nested and repeated calls through the existing evidence export without timing', () => {
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
  assert.ok(view.flow?.nodes.every((node) => !('timing' in node)));
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
  assert.ok(firstProjectionReads > 0);
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
