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
  runReferencedSessions,
  skippedJournals,
} from '../runs/native-journal-retention.js';

import {
  type JournalNode,
  type NodeJournalRetentionDeps,
  nodeJournalRetentionPass,
} from './node-native-journals.js';

/** A host session id: a lowercase UUID whose last group is `name` padded. */
const sid = (name: string | number) => `00000000-0000-4000-8000-${String(name).padStart(12, '0')}`;

function binding(session: string): NativeWorkerSessionBinding {
  const [executionNodeId, name] = session.includes(':') ? session.split(':') : ['macpro', session];
  return {
    sessionId: name === 'bad' ? 'not-a-uuid' : sid(name!),
    executionNodeId: executionNodeId!,
    ownerPrincipalId: 'owner',
    leaseId: 'lease',
    commandId: 'command',
  };
}

/** A settled run whose one agent context bound `sessions` (`[node:]name`), the first current. */
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

const sendable = () => undefined;

test('a pass sends released runs’ node sessions that no held run references, never local ones', () => {
  const released = [run('a', ['1', '2', 'local:3', 'bad']), run('b', ['4', '5'])];
  // Held runs name 2 in their contexts and 4 only in a usage record: both stay. A malformed id
  // is never sent.
  const held = [
    run('h', ['2']),
    run('u', [], {
      sessionUsage: [
        {
          measuredAt: '2026-01-01T00:00:00Z',
          source: 'unavailable',
          nativeSession: {
            sessionId: sid(4),
            executionNodeId: 'macpro',
            ownerPrincipalId: 'owner',
          },
        },
      ],
    }),
  ];
  const { batches, pending } = nodeJournalBatches(released, held, new Set(), sendable);
  assert.deepEqual(batches, [
    { executionNodeId: 'macpro', ownerPrincipalId: 'owner', sessionIds: [sid(1), sid(5)] },
  ]);
  assert.deepEqual(pending, { macpro: 2 });
});

test('a pause recovery handle keeps its host session, named beside the runner conversation', () => {
  // MachinePauseNativeRecoveryHandle: `sessionId` is the runner's conversation, `nativeSessionId`
  // the host session.
  const parked = {
    id: 'p',
    park: {
      recoveryHandle: {
        version: 2,
        transport: 'native',
        sessionId: 'runner-conversation',
        nativeSessionId: sid(6),
        executionNodeId: 'macpro',
      },
    },
  };
  assert.ok(runReferencedSessions(parked).has(`macpro/${sid(6)}`));
});

test('a pass sends at most the limit per node and counts the rest as pending', () => {
  const released = [
    run(
      'a',
      Array.from({ length: 7 }, (_, i) => `${i}`),
    ),
    run('b', ['mini:9']),
  ];
  const { batches, pending } = nodeJournalBatches(
    released,
    [],
    new Set([`macpro/${sid(0)}`]),
    sendable,
    3,
  );
  assert.deepEqual(
    batches.map((batch) => [batch.executionNodeId, batch.sessionIds]),
    [
      ['macpro', [sid(1), sid(2), sid(3)]],
      ['mini', [sid(9)]],
    ],
  );
  assert.deepEqual(pending, { macpro: 6, mini: 1 });
});

test('sessions a node cannot take do not count toward its limit', () => {
  // 51 older sessions of another owner come first; the node's own owner still gets its batch.
  const other: Run = run(
    'other',
    Array.from({ length: 51 }, (_, i) => `${100 + i}`),
  );
  for (const context of other.agentContexts ?? [])
    for (const session of [context.nativeSession!, ...(context.nativeSessionHistory ?? [])])
      session.ownerPrincipalId = 'someone-else';
  const { batches, unsendable } = nodeJournalBatches(
    [other, run('mine', ['1'])],
    [],
    new Set(),
    (_node, owner) => (owner === 'owner' ? undefined : 'another owner'),
  );
  assert.deepEqual(batches, [
    { executionNodeId: 'macpro', ownerPrincipalId: 'owner', sessionIds: [sid(1)] },
  ]);
  assert.deepEqual(unsendable, { macpro: { 'another owner': 51 } });
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
    log: (line) => lines.push(line.replace(/^\[native-journal retention\] /, '')),
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
  const [live, gone] = [sid(4), sid(404)];
  const h = harness({ macpro: ready }, (ids) =>
    ids.map((sessionId) =>
      sessionId === live
        ? { sessionId, outcome: 'kept', reason: 'live process' }
        : { sessionId, outcome: sessionId === gone ? 'missing' : 'archived' },
    ),
  );
  try {
    const released = [run('a', ['1', '4', '404'])];
    await nodeJournalRetentionPass(released, [], h.deps);
    await nodeJournalRetentionPass(released, [], h.deps);
    h.advance(JOURNAL_RETRY_DEFERRAL_MS);
    await nodeJournalRetentionPass(released, [], h.deps);
    assert.deepEqual(h.sent, [[sid(1), live, gone], [live]]);
    const record = await readJournalRetention(h.deps.file);
    assert.deepEqual(Object.keys(record.confirmed).sort(), [`macpro/${sid(1)}`, `macpro/${gone}`]);
    assert.deepEqual(Object.keys(record.deferred), [`macpro/${live}`]);
    assert.equal(
      h.lines[0],
      'macpro archived=1 already=0 missing=1 kept=1 (live process) pending=1',
    );
    assert.equal((JSON.parse(readFileSync(h.deps.file, 'utf8')) as { version: number }).version, 1);
  } finally {
    h.done();
  }
});

test('the record forgets sessions no released run binds and deferrals past their day', async () => {
  const h = harness({ macpro: ready }, (ids) =>
    ids.map((sessionId) =>
      sessionId === sid(2)
        ? { sessionId, outcome: 'kept', reason: 'conversation open' }
        : { sessionId, outcome: 'archived' },
    ),
  );
  try {
    await nodeJournalRetentionPass([run('a', ['1', '2'])], [], h.deps);
    // Run a is held again: its confirmation is dropped, so once released it is asked afresh.
    h.advance(JOURNAL_RETRY_DEFERRAL_MS);
    await nodeJournalRetentionPass([], [run('a', ['1', '2'])], h.deps);
    const record = await readJournalRetention(h.deps.file);
    assert.deepEqual(record, { version: 1, confirmed: {}, deferred: {} });
  } finally {
    h.done();
  }
});

test('an offline, undeclared or other-owner node is not sent anything and is asked again', async () => {
  const nodes: Record<string, JournalNode> = {
    macpro: { ...ready, connected: false },
    mini: { ...ready, supportsSessionArchive: false },
    gpu: { ...ready, ownerPrincipalId: 'someone-else' },
  };
  const h = harness(nodes, (ids) => ids.map((sessionId) => ({ sessionId, outcome: 'archived' })));
  try {
    const released = [run('a', ['1', 'mini:2', 'gpu:3'])];
    await nodeJournalRetentionPass(released, [], h.deps);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.lines, [
      'macpro not sent 1 (offline); pending=1',
      'mini not sent 1 (no session archive); pending=1',
      'gpu not sent 1 (another owner); pending=1',
    ]);
    nodes.macpro = ready;
    await nodeJournalRetentionPass(released, [], h.deps);
    assert.deepEqual(h.sent, [[sid(1)]]);
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
    const released = [run('a', ['1', '2'])];
    await nodeJournalRetentionPass(released, [], h.deps);
    answer = (ids) => [{ sessionId: ids[0], outcome: 'archived' }];
    await nodeJournalRetentionPass(released, [], h.deps);
    answer = (ids) => ids.map((sessionId) => ({ sessionId, outcome: 'deleted' }));
    await nodeJournalRetentionPass(released, [], h.deps);
    assert.equal(h.sent.length, 3);
    assert.ok(h.sent.every((ids) => ids.join() === [sid(1), sid(2)].join()));
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
