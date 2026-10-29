import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

// The projects dir is read once, at import, so the override is set first.
const projects = mkdtempSync(path.join(tmpdir(), 'fleet-monitor-task-roots-'));
after(() => rmSync(projects, { recursive: true, force: true }));
process.env.FARMSLOT_PROJECTS_DIR = projects;
const taskRoot = path.join(projects, 'demo/tasks');
let rootReads = 0;
let readGate: Promise<void> | undefined;
let entered: (() => void) | undefined;
let failNextRoot = false;
let deepReads = 0;
mock.module('node:fs/promises', {
  namedExports: {
    ...fs,
    readdir: async (...args: Parameters<typeof fs.readdir>) => {
      const file = String(args[0]);
      if (file === taskRoot) {
        rootReads++;
        const fail = failNextRoot;
        failNextRoot = false;
        entered?.();
        await readGate;
        if (fail) throw Object.assign(new Error('decision directory denied'), { code: 'EACCES' });
      }
      if (file === path.join(taskRoot, 'qa/run-1/artifacts/deep')) deepReads++;
      return fs.readdir(...args);
    },
  },
});
// Unit discovery must not import the production PTY module or touch a real tmux server.
await import('../runtime/mock-pty.test-support.js');
const { loadPendingDecisions } = await import('./fleet-monitor.js');

test('pending decisions are found in task folders under FARMSLOT_PROJECTS_DIR', async () => {
  const task = path.join(projects, 'demo', 'tasks', 'qa', 'run-1');
  mkdirSync(task, { recursive: true });
  writeFileSync(
    path.join(task, '.pending_decision.json'),
    JSON.stringify({ id: 'decision-1', title: 'Blocked on a fixture', actions: [] }),
  );
  const decisions = await loadPendingDecisions();
  assert.deepEqual(
    decisions.map(({ id, title }) => ({ id, title })),
    [{ id: 'decision-1', title: 'Blocked on a fixture' }],
  );
});

test('decision discovery includes depth three and never descends into depth four', async (t) => {
  const artifacts = path.join(taskRoot, 'qa/run-1/artifacts');
  mkdirSync(path.join(artifacts, 'deep'), { recursive: true });
  t.after(() => rmSync(artifacts, { recursive: true, force: true }));
  for (const [file, id] of [
    [path.join(artifacts, '.pending_decision.json'), 'depth-three'],
    [path.join(artifacts, 'deep/.pending_decision.json'), 'depth-four'],
  ])
    writeFileSync(file, JSON.stringify({ id, title: id, actions: [] }));
  deepReads = 0;
  const decisions = await loadPendingDecisions();
  assert.deepEqual(decisions.map(({ id }) => id).sort(), ['decision-1', 'depth-three']);
  assert.equal(deepReads, 0, 'historical artifact trees below the bound must not be read');
});

function holdRootRead() {
  let release!: () => void;
  readGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter!: () => void;
  const started = new Promise<void>((resolve) => {
    enter = resolve;
  });
  entered = enter;
  rootReads = 0;
  return { started, release };
}

test(
  'concurrent lists share one scan and the next list reads a fresh decision',
  { timeout: 4000 },
  async () => {
    const gate = holdRootRead();
    const first = loadPendingDecisions();
    const second = loadPendingDecisions();
    try {
      await gate.started;
    } finally {
      gate.release();
      readGate = undefined;
      entered = undefined;
    }
    const [one, two] = await Promise.all([first, second]);
    assert.equal(rootReads, 1);
    assert.deepEqual(one, two);
    writeFileSync(
      path.join(taskRoot, 'qa/run-1/.pending_decision.json'),
      JSON.stringify({ id: 'fresh-decision', title: 'Updated', actions: [] }),
    );
    assert.deepEqual(
      (await loadPendingDecisions()).map(({ id }) => id),
      ['fresh-decision'],
    );
    assert.equal(rootReads, 2, 'settled scans must not be cached');
  },
);

test(
  'a shared scan rejection reaches every caller and permits a fresh successful scan',
  { timeout: 4000 },
  async () => {
    const gate = holdRootRead();
    failNextRoot = true;
    const first = loadPendingDecisions();
    const second = loadPendingDecisions();
    try {
      await gate.started;
    } finally {
      gate.release();
      readGate = undefined;
      entered = undefined;
    }
    const results = await Promise.allSettled([first, second]);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') {
        assert.ok(result.reason instanceof Error);
        assert.match(result.reason.message, /decision directory denied/);
      }
    }
    assert.equal(rootReads, 1);
    assert.deepEqual(
      (await loadPendingDecisions()).map(({ id }) => id),
      ['fresh-decision'],
    );
    assert.equal(rootReads, 2);
  },
);
