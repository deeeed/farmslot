import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isGatewayOwnedArtifactMirrorEntry } from '../core/artifact-copy-policy.js';

import { mirrorWorkerSubtasks } from './artifact-mirror.js';

const LOCAL = { host: 'localhost', machine: 'local', sshTarget: '' };
const META = { runId: 'run-1', slotId: 'slot-1' };

function makeDirs(workerFiles: Record<string, string>): { worker: string; orchestrator: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'gw-subtask-mirror-'));
  const worker = path.join(root, 'worker');
  const orchestrator = path.join(root, 'orchestrator');
  mkdirSync(worker, { recursive: true });
  mkdirSync(orchestrator, { recursive: true });
  for (const [rel, content] of Object.entries(workerFiles)) {
    const target = path.join(worker, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
  }
  return { worker, orchestrator };
}

test('mirrorWorkerSubtasks writes one .worker file per child unit file', async () => {
  const { worker, orchestrator } = makeDirs({
    'subtasks/index.json': '{"schemaVersion":1,"units":[]}\n',
    'subtasks/ci-parity.md': '- [x] **1. reproduce it**\n',
    'subtasks/ci-parity-SIGNAL.json': '{"status":"complete"}\n',
  });
  try {
    await mirrorWorkerSubtasks(LOCAL, worker, orchestrator, META);
    const mirrored = readdirSync(path.join(orchestrator, 'subtasks')).sort();
    assert.deepEqual(mirrored, [
      'ci-parity-SIGNAL.json.worker',
      'ci-parity.md.worker',
      'index.json.worker',
    ]);
    assert.equal(
      readFileSync(path.join(orchestrator, 'subtasks', 'ci-parity.md.worker'), 'utf-8'),
      '- [x] **1. reproduce it**\n',
    );
  } finally {
    rmSync(path.dirname(worker), { recursive: true, force: true });
  }
});

test('mirrorWorkerSubtasks is a no-op for a task dir with no subtasks directory', async () => {
  const { worker, orchestrator } = makeDirs({ 'CHECKLIST.md': '- [ ] **1. work**\n' });
  try {
    await mirrorWorkerSubtasks(LOCAL, worker, orchestrator, META);
    assert.deepEqual(readdirSync(orchestrator), []);
  } finally {
    rmSync(path.dirname(worker), { recursive: true, force: true });
  }
});

test('mirrorWorkerSubtasks does not re-mirror its own output or walk nested dirs', async () => {
  const { worker, orchestrator } = makeDirs({
    'subtasks/index.json': '{"schemaVersion":1,"units":[]}\n',
    // A leftover mirror copied back onto the slot by a re-dispatch, and a
    // directory the child-unit contract does not define.
    'subtasks/index.json.worker': 'stale\n',
    'subtasks/nested/deep.md': '- [ ] **1. nope**\n',
  });
  try {
    await mirrorWorkerSubtasks(LOCAL, worker, orchestrator, META);
    assert.deepEqual(readdirSync(path.join(orchestrator, 'subtasks')), ['index.json.worker']);
    assert.equal(
      readFileSync(path.join(orchestrator, 'subtasks', 'index.json.worker'), 'utf-8'),
      '{"schemaVersion":1,"units":[]}\n',
    );
  } finally {
    rmSync(path.dirname(worker), { recursive: true, force: true });
  }
});

test('isGatewayOwnedArtifactMirrorEntry never claims a child unit file', () => {
  for (const name of [
    'subtasks',
    'index.json',
    'ci-parity.md',
    'ci-parity-SIGNAL.json',
    'ci-parity.md.worker',
    'self-review-1.md.worker',
  ]) {
    assert.equal(
      isGatewayOwnedArtifactMirrorEntry(name),
      false,
      `${name} must stay worker-owned so the child mirror is not treated as gateway output`,
    );
  }
  // Sanity: the predicate still recognises what it owns.
  assert.equal(isGatewayOwnedArtifactMirrorEntry('session-metrics.json'), true);
  assert.equal(isGatewayOwnedArtifactMirrorEntry('self-review-1.md'), true);
});
