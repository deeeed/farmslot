import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AgentContext, NativeWorkerSessionBinding, Run } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';
import {
  JOURNAL_RETRY_DEFERRAL_MS,
  nodeJournalBatches,
  readJournalRetention,
  skippedJournals,
} from '../runs/native-journal-retention.js';

import {
  type JournalNode,
  type NodeJournalRetentionDeps,
  nodeJournalRetentionPass,
} from './node-native-journals.js';

function binding(session: string): NativeWorkerSessionBinding {
  const [executionNodeId, sessionId] = session.includes(':')
    ? session.split(':')
    : ['macpro', session];
  return {
    sessionId: sessionId!,
    executionNodeId: executionNodeId!,
    ownerPrincipalId: 'owner',
    leaseId: 'lease',
    commandId: 'command',
  };
}

/** A settled run whose one agent context bound `sessions`, the first one current. */
function run(id: string, sessions: string[], extra: Partial<Run> = {}): Run {
  const [current, ...history] = sessions.map(binding);
  const context: AgentContext = {
    id: 'fix-bug',
    role: 'fix-bug',
    label: 'Fix',
    status: 'complete',
    slotId: null,
    runId: id,
    nativeSession: current,
    nativeSessionHistory: history,
  };
  return {
    ...makeRun({ id, status: 'done', agentContexts: current ? [context] : [] }),
    completedAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

test('a pass sends released runs’ node sessions that no held run references, never local ones', () => {
  const released = [run('a', ['s1', 's2', 'local:s3']), run('b', ['s4', 's5'])];
  // A held run names s2 in its contexts and s4 only in a usage record: both stay.
  const held = [
    run('h', ['s2']),
    run('u', [], {
      sessionUsage: [
        {
          measuredAt: '2026-01-01T00:00:00Z',
          source: 'unavailable',
          nativeSession: { sessionId: 's4', executionNodeId: 'macpro', ownerPrincipalId: 'owner' },
        },
      ],
    }),
  ];
  const { batches, pending } = nodeJournalBatches(released, held, new Set());
  assert.deepEqual(batches, [
    { executionNodeId: 'macpro', ownerPrincipalId: 'owner', sessionIds: ['s1', 's5'] },
  ]);
  assert.deepEqual(pending, { macpro: 2 });
});

test('a pass sends at most the limit per node and counts the rest as pending', () => {
  const released = [
    run(
      'a',
      Array.from({ length: 7 }, (_, i) => `s${i}`),
    ),
    run('b', ['mini:m1']),
  ];
  const { batches, pending } = nodeJournalBatches(released, [], new Set(['macpro/s0']), 3);
  assert.deepEqual(
    batches.map((batch) => [batch.executionNodeId, batch.sessionIds]),
    [
      ['macpro', ['s1', 's2', 's3']],
      ['mini', ['m1']],
    ],
  );
  assert.deepEqual(pending, { macpro: 6, mini: 1 });
});

function harness(nodes: Record<string, JournalNode>, answer: (ids: string[]) => unknown) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'journal-retention-'));
  const sent: string[][] = [];
  const lines: string[] = [];
  let now = Date.parse('2026-02-01T00:00:00Z');
  const deps: NodeJournalRetentionDeps = {
    node: (machine) => nodes[machine] ?? { connected: false, supportsSessionArchive: false },
    archive: async (_owner, _machine, ids) => {
      sent.push(ids);
      return answer(ids);
    },
    file: path.join(home, 'native-journals.json'),
    now: () => now,
    log: (line) => lines.push(line),
  };
  return {
    deps,
    sent,
    lines,
    advance: (ms: number) => (now += ms),
    done: () => rmSync(home, { recursive: true, force: true }),
  };
}

const ready: JournalNode = {
  connected: true,
  ownerPrincipalId: 'owner',
  supportsSessionArchive: true,
};

test('confirmed sessions are recorded and never resent; kept ones wait a day', async () => {
  const h = harness({ macpro: ready }, (ids) =>
    ids.map((sessionId) =>
      sessionId === 'busy'
        ? { sessionId, outcome: 'kept', reason: 'live process' }
        : { sessionId, outcome: sessionId === 'gone' ? 'missing' : 'archived' },
    ),
  );
  try {
    const released = [run('a', ['s1', 'busy', 'gone'])];
    await nodeJournalRetentionPass(released, [], h.deps);
    await nodeJournalRetentionPass(released, [], h.deps);
    h.advance(JOURNAL_RETRY_DEFERRAL_MS);
    await nodeJournalRetentionPass(released, [], h.deps);
    assert.deepEqual(h.sent, [['s1', 'busy', 'gone'], ['busy']]);
    const record = await readJournalRetention(h.deps.file);
    assert.deepEqual(Object.keys(record.confirmed).sort(), ['macpro/gone', 'macpro/s1']);
    assert.deepEqual(Object.keys(record.deferred), ['macpro/busy']);
    assert.match(
      h.lines[0]!,
      /macpro archived=1 already=0 missing=1 kept=1 \(live process\) pending=1/,
    );
    assert.equal((JSON.parse(readFileSync(h.deps.file, 'utf8')) as { version: number }).version, 1);
  } finally {
    h.done();
  }
});

test('an offline, undeclared or other-owner node is skipped and asked again next pass', async () => {
  const nodes: Record<string, JournalNode> = {
    macpro: { ...ready, connected: false },
    mini: { ...ready, supportsSessionArchive: false },
    gpu: { ...ready, ownerPrincipalId: 'someone-else' },
  };
  const h = harness(nodes, (ids) => ids.map((sessionId) => ({ sessionId, outcome: 'archived' })));
  try {
    const released = [run('a', ['s1', 'mini:m1', 'gpu:g1'])];
    await nodeJournalRetentionPass(released, [], h.deps);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(
      h.lines.map((line) => line.replace(/^\[native-journal retention\] /, '')),
      [
        'macpro skipped 1 (offline); pending=1',
        'mini skipped 1 (no session archive); pending=1',
        'gpu skipped 1 (another owner); pending=1',
      ],
    );
    nodes.macpro = ready;
    await nodeJournalRetentionPass(released, [], h.deps);
    assert.deepEqual(h.sent, [['s1']]);
  } finally {
    h.done();
  }
});

test('a failed or malformed answer confirms nothing', async () => {
  let answer: (ids: string[]) => unknown = () => {
    throw new Error('socket closed');
  };
  const h = harness({ macpro: ready }, (ids) => answer(ids));
  try {
    const released = [run('a', ['s1', 's2'])];
    await nodeJournalRetentionPass(released, [], h.deps);
    answer = (ids) => [{ sessionId: ids[0], outcome: 'archived' }];
    await nodeJournalRetentionPass(released, [], h.deps);
    answer = (ids) => ids.map((sessionId) => ({ sessionId, outcome: 'deleted' }));
    await nodeJournalRetentionPass(released, [], h.deps);
    assert.equal(h.sent.length, 3);
    assert.ok(h.sent.every((ids) => ids.join() === 's1,s2'));
    assert.deepEqual(
      skippedJournals(await readJournalRetention(h.deps.file), Date.now()),
      new Set(),
    );
    assert.match(h.lines[0]!, /retained on failure: socket closed/);
    assert.match(h.lines[1]!, /Invalid native journal archive receipt/);
  } finally {
    h.done();
  }
});
