import assert from 'node:assert/strict';
import test from 'node:test';

import type { SourcePin } from '../src/sources/contracts.js';
import { selectEffectiveSource, validateSourceSelection } from '../src/sources/pins.js';

const source = {
  id: 'pack',
  kind: 'pack' as const,
  repo: 'https://example.test/team/pack',
  ref: 'release',
};
const pin = (scope: SourcePin['scope'], targetId: string, ref: string): SourcePin => ({
  sourceId: source.id,
  scope,
  targetId,
  ref,
  selection: ref === 'main' ? 'main' : 'branch',
  actor: 'operator',
  declarationRevision: 1,
  revision: 1,
  baseMainCommit: 'a'.repeat(40),
  createdAt: '2026-10-12T00:00:00Z',
});

test('run and node selections shadow broader experiments; main overrides stay explicit', () => {
  const farm = pin('farm', 'farm', 'experiment/farm');
  const node = pin('node', 'node-1', 'main');
  const run = pin('run', 'run-1', 'experiment/run');
  const all = [farm, run, node];
  const selected = selectEffectiveSource(source, all, { runId: 'run-1', nodeId: 'node-1' });
  assert.equal(selected.effectiveRef, run.ref);
  assert.deepEqual(selected.shadowedPins, [node, farm]);
  const sibling = selectEffectiveSource(source, all, { runId: 'run-2', nodeId: 'node-1' });
  assert.equal(sibling.effectiveRef, 'main');
  assert.deepEqual(sibling.pin, node);
  assert.deepEqual(sibling.shadowedPins, [farm]);
  assert.equal(selectEffectiveSource(source, all, { nodeId: 'node-2' }).effectiveRef, farm.ref);
  assert.equal(selectEffectiveSource(source, []).effectiveRef, 'release');
  selected.pin!.ref = 'mutated';
  assert.equal(run.ref, 'experiment/run');
});

test('selection validation refuses paths, tags, commits and unknown sources without deleting intent', () => {
  for (const ref of [
    '/tmp/pack',
    '../pack',
    'file:///pack',
    'refs/tags/v1',
    'a'.repeat(40),
    'a'.repeat(64),
    'branch.lock',
    'branch..name',
  ])
    assert.ok(
      validateSourceSelection({ sourceId: source.id, selection: 'branch', ref }, [source]).length,
      ref,
    );
  assert.deepEqual(
    validateSourceSelection({ sourceId: source.id, selection: 'branch', ref: 'experiment/team' }, [
      source,
    ]),
    [],
  );
  assert.deepEqual(
    validateSourceSelection({ sourceId: source.id, selection: 'main' }, [source]),
    [],
  );
  assert.ok(validateSourceSelection({ sourceId: 'unknown', selection: 'main' }, [source]).length);
  assert.ok(
    validateSourceSelection({ sourceId: source.id, selection: 'main', ref: 'experiment/team' }, [
      source,
    ]).length,
  );
  assert.ok(
    validateSourceSelection({ sourceId: source.id, selection: 'main', localPath: '/tmp' }, [source])
      .length,
  );
});
