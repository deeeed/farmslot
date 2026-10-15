import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const { refreshRunGateReadiness } = await import('./gate-prerequisites.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { deleteTestRunIfPresent } = await import('./test-fixtures.js');

function readyDecision(): RunDecision {
  return {
    id: 'ready',
    type: 'engine_human_gate',
    title: 'Ready',
    description: 'Review output',
    createdAt: new Date().toISOString(),
    actions: [
      { id: 'ready', label: 'Ready', style: 'primary' },
      { id: 'hold', label: 'Hold', style: 'secondary' },
    ],
    payload: {
      kind: 'ready',
      prNumber: null,
      repo: null,
      workerReport: 'done',
      branch: 'feature',
      diffStat: { files: 0, additions: 0, deletions: 0 },
    },
  };
}

test('a burst of identical display reads shares evidence work and the next read rechecks', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'READ-CONTENTION' });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, { status: 'human-gating', decisions: [readyDecision()] });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const readers = {
    deterministic: async () => {},
    acceptance: async () => ({ criteria: [], ledger: null, issues: [] }),
    progress: async () => {
      reads++;
      await waiting;
      return { kind: 'idle' as const };
    },
  };
  const requests = Array.from({ length: 350 }, () => refreshRunGateReadiness(run, readers));
  assert.equal(reads, 1);
  release();
  await Promise.all(requests);
  await refreshRunGateReadiness(getRun(run.id)!, readers);
  assert.equal(reads, 2, 'settled results must not become an evidence cache');
});

test('a changed generation starts its own check and an older check cannot clear it', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'READ-GENERATION' });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, { status: 'human-gating', decisions: [readyDecision()] });
  const releases: Array<() => void> = [];
  const readers = {
    deterministic: async () => {},
    acceptance: async () => ({ criteria: [], ledger: null, issues: [] }),
    progress: async () => {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return { kind: 'idle' as const };
    },
  };
  const old = refreshRunGateReadiness(run, readers);
  updateRun(run.id, { engineState: { ...run.engineState, generation: 1 } });
  const current = refreshRunGateReadiness(run, readers);
  assert.equal(releases.length, 2);
  releases[0]();
  await old;
  assert.equal(refreshRunGateReadiness(run, readers), current);
  releases[1]();
  await current;
});

test('a failed display read is released so a subsequent read can recover', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'READ-RETRY' });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, { status: 'human-gating', decisions: [readyDecision()] });
  let reads = 0;
  const readers = {
    deterministic: async () => {},
    acceptance: async () => ({ criteria: [], ledger: null, issues: [] }),
    progress: async () => {
      if (++reads === 1) throw new Error('probe unavailable');
      return { kind: 'idle' as const };
    },
  };
  await assert.rejects(refreshRunGateReadiness(run, readers), /probe unavailable/);
  await refreshRunGateReadiness(run, readers);
  assert.equal(reads, 2);
});
