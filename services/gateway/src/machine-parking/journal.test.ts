import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { MachineParkRecord } from '@farmslot/protocol';

import { MachineParkingIntentJournalStore } from './journal.js';

function record(machine: string, operationId: string): MachineParkRecord {
  return {
    version: 1,
    machine,
    operationId,
    previewId: 'preview',
    runId: 'run-a',
    generation: 1,
    slotId: 'slot-a',
    mode: 'orchestration',
    phase: 'intent-persisted',
    prePauseStatus: 'monitoring',
    prePauseCurrentStep: { index: 0, name: 'monitor', status: 'running' },
    resourceManifest: {
      capturedAt: '2026-08-21T00:00:00.000Z',
      resources: [],
      capabilityLeases: [],
    },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'running', resources: [] },
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  };
}

function richRecord(operationId: string): MachineParkRecord {
  const base = record('machine-a', operationId);
  return {
    ...base,
    mode: 'release',
    phase: 'resources-restoring',
    restoreDisposition: 'effectful',
    resourceManifest: {
      capturedAt: base.createdAt,
      resources: [
        {
          resourceId: 'browser',
          label: 'Browser',
          type: 'browser',
          observedStatus: 'running',
          phase: 'stopped',
          capabilityLeaseIds: ['lease-1'],
          stoppedAt: base.createdAt,
        },
      ],
      capabilityLeases: [
        {
          leaseId: 'lease-1',
          capabilityId: 'browser',
          state: 'released',
          parameters: {},
          proofRequirement: { capabilityId: 'browser', reason: 'proof', mode: 'visual' },
          resourceId: 'browser',
        },
      ],
    },
    recoveryHandle: {
      version: 1,
      runnerId: 'codex',
      contextId: 'primary',
      sessionId: 'session-1',
      sessionPath: '/sessions/session-1.jsonl',
      target: { session: 'slot-a', window: 'worker', paneId: '%1', target: 'slot-a:worker' },
      model: 'gpt-5',
      safetyTier: 'dangerous',
      capturedAt: base.createdAt,
    },
    recoveryProof: {
      sessionId: 'session-1',
      live: true,
      acknowledgement: { kind: 'structured', source: 'hook', reason: 'accepted' },
      acceptedAt: base.createdAt,
    },
    errors: [
      {
        phase: 'partial',
        action: 'test',
        code: 'TEST',
        message: 'test',
        occurredAt: base.createdAt,
        retryable: true,
      },
    ],
    residuals: {
      runner: 'stopped',
      resources: [{ resourceId: 'browser', state: 'stopped', detail: 'observed stopped' }],
    },
    parkedAt: base.createdAt,
  };
}

test('journal identity includes machine and operation kind but not gateway port', async (t) => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-machine-journal-'));
  t.after(() => rm(runsDir, { recursive: true, force: true }));
  const store = new MachineParkingIntentJournalStore(runsDir);
  const machineA = store.pathFor('machine-a', 'pause', 'same-id');
  const machineB = store.pathFor('machine-b', 'pause', 'same-id');
  const restore = store.pathFor('machine-a', 'restore', 'same-id');
  assert.notEqual(machineA, machineB);
  assert.notEqual(machineA, restore);

  const priorPort = process.env.GATEWAY_PORT;
  process.env.GATEWAY_PORT = '9999';
  try {
    assert.equal(
      new MachineParkingIntentJournalStore(runsDir).pathFor('machine-a', 'pause', 'same-id'),
      machineA,
    );
  } finally {
    if (priorPort === undefined) delete process.env.GATEWAY_PORT;
    else process.env.GATEWAY_PORT = priorPort;
  }
});

test('malformed journal is quarantined without aborting valid recovery', async (t) => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-machine-journal-'));
  t.after(() => rm(runsDir, { recursive: true, force: true }));
  const store = new MachineParkingIntentJournalStore(runsDir);
  await store.write('pause', [record('machine-a', 'valid-op')]);
  const malformed = path.join(
    path.dirname(store.pathFor('machine-a', 'pause', 'valid-op')),
    'bad.json',
  );
  await mkdir(path.dirname(malformed), { recursive: true });
  await writeFile(malformed, '{not json', 'utf8');
  const wrongName = path.join(path.dirname(malformed), 'wrong-name.json');
  await writeFile(
    wrongName,
    JSON.stringify({
      version: 1,
      kind: 'pause',
      machine: 'machine-a',
      operationId: 'wrong-name-op',
      records: [record('machine-a', 'wrong-name-op')],
    }),
    'utf8',
  );
  const invalidRecord = store.pathFor('machine-a', 'pause', 'invalid-record');
  await writeFile(
    invalidRecord,
    JSON.stringify({
      version: 1,
      kind: 'pause',
      machine: 'machine-a',
      operationId: 'invalid-record',
      records: [{ machine: 'machine-a', operationId: 'invalid-record' }],
    }),
    'utf8',
  );

  const loaded = await store.load();
  assert.equal(loaded.journals.length, 1);
  assert.equal(loaded.journals[0]?.operationId, 'valid-op');
  assert.equal(loaded.quarantined.length, 3);
  assert.deepEqual(
    new Set(loaded.quarantined.map((item) => item.file)),
    new Set([malformed, wrongName, invalidRecord]),
  );
});

test('deep-invalid record tables quarantine per file while valid journal loads', async (t) => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-machine-journal-'));
  t.after(() => rm(runsDir, { recursive: true, force: true }));
  const store = new MachineParkingIntentJournalStore(runsDir);
  await store.write('restore', [richRecord('valid-rich')]);
  const invalid: Array<{ name: string; mutate(record: MachineParkRecord): unknown }> = [
    { name: 'null', mutate: () => null },
    {
      name: 'phase',
      mutate: (value) => ({ ...value, phase: 'bogus' }),
    },
    {
      name: 'resource-state',
      mutate: (value) => ({
        ...value,
        resourceManifest: {
          ...value.resourceManifest,
          resources: [{ ...value.resourceManifest.resources[0]!, phase: 'bogus' }],
        },
      }),
    },
    {
      name: 'resource-type',
      mutate: (value) => ({
        ...value,
        resourceManifest: {
          ...value.resourceManifest,
          resources: [{ ...value.resourceManifest.resources[0]!, type: 'bogus' }],
        },
      }),
    },
    {
      name: 'lease-state',
      mutate: (value) => ({
        ...value,
        resourceManifest: {
          ...value.resourceManifest,
          capabilityLeases: [{ ...value.resourceManifest.capabilityLeases[0]!, state: 'bogus' }],
        },
      }),
    },
    {
      name: 'timestamp',
      mutate: (value) => ({ ...value, updatedAt: 'not-a-date' }),
    },
    {
      name: 'pane',
      mutate: (value) => ({
        ...value,
        recoveryHandle: {
          ...value.recoveryHandle!,
          target: { ...value.recoveryHandle!.target, paneId: 'worker.1' },
        },
      }),
    },
    {
      name: 'current-step',
      mutate: (value) => ({
        ...value,
        prePauseCurrentStep: { index: -1, name: '', status: 'bogus' },
      }),
    },
    {
      name: 'recovery-proof',
      mutate: (value) => ({
        ...value,
        recoveryProof: { ...value.recoveryProof!, acceptedAt: 'invalid' },
      }),
    },
  ];
  for (const entry of invalid) {
    const operationId = `invalid-${entry.name}`;
    const file = store.pathFor('machine-a', 'restore', operationId);
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        kind: 'restore',
        machine: 'machine-a',
        operationId,
        records: [entry.mutate(richRecord(operationId))],
      }),
      'utf8',
    );
  }

  const loaded = await store.load();
  assert.equal(loaded.journals.length, 1);
  assert.equal(loaded.journals[0]?.operationId, 'valid-rich');
  assert.equal(loaded.quarantined.length, invalid.length);
});

// ─── ADR-054 free-slot: the write-ahead journal must survive its own reload ───

/** The record shape a freeing park actually journals: preserved, not yet detached. */
function freeingRecord(operationId: string, runId: string): MachineParkRecord {
  return {
    ...record('machine-a', operationId),
    runId,
    slotId: `slot-${runId}`,
    mode: 'release',
    slotDisposition: 'freed',
    // No `detachedAt`. Every journal is written BEFORE the detach lands — that
    // is the entire point of a write-ahead record.
    preservedWorkspace: { branch: `work/${runId}`, headSha: `sha-${runId}` },
  };
}

test('a journal written before the detach lands reloads instead of being quarantined', async (t) => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-machine-journal-'));
  t.after(() => rm(runsDir, { recursive: true, force: true }));
  const store = new MachineParkingIntentJournalStore(runsDir);

  await store.write('free-slot', [freeingRecord('free-op', 'run-a')], 'run-a');
  await store.write('pause', [freeingRecord('pause-op', 'run-a')]);

  const { journals, quarantined } = await store.load();

  // Requiring `detachedAt` here quarantined both, so repair never ran and a
  // crash mid-park left the slot bound to the parked run.
  assert.deepEqual(quarantined, []);
  assert.deepEqual(journals.map((journal) => journal.kind).sort(), ['free-slot', 'pause']);
  assert.equal(journals.find((journal) => journal.kind === 'free-slot')?.scopeId, 'run-a');
});

test('a landed detach still round-trips, so the fact is not lost on reload', async (t) => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-machine-journal-'));
  t.after(() => rm(runsDir, { recursive: true, force: true }));
  const store = new MachineParkingIntentJournalStore(runsDir);
  const detached = freeingRecord('free-op', 'run-a');
  await store.write(
    'free-slot',
    [
      {
        ...detached,
        preservedWorkspace: {
          ...detached.preservedWorkspace!,
          detachedAt: '2026-09-05T00:00:00.000Z',
        },
      },
    ],
    'run-a',
  );

  const { journals, quarantined } = await store.load();

  assert.deepEqual(quarantined, []);
  assert.equal(journals[0]?.records[0]?.preservedWorkspace?.detachedAt, '2026-09-05T00:00:00.000Z');
});

test('free-slot journals of one batch are per run, so one member cannot erase another', async (t) => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-machine-journal-'));
  t.after(() => rm(runsDir, { recursive: true, force: true }));
  const store = new MachineParkingIntentJournalStore(runsDir);
  // One batch, one operationId, two runs — the shape that overwrote itself.
  await store.write('free-slot', [freeingRecord('batch-op', 'run-a')], 'run-a');
  await store.write('free-slot', [freeingRecord('batch-op', 'run-b')], 'run-b');

  assert.notEqual(
    store.pathFor('machine-a', 'free-slot', 'batch-op', 'run-a'),
    store.pathFor('machine-a', 'free-slot', 'batch-op', 'run-b'),
  );

  // run-a completes and deletes its own intent. run-b's pending repair must survive.
  await store.delete('machine-a', 'free-slot', 'batch-op', 'run-a');

  const { journals, quarantined } = await store.load();
  assert.deepEqual(quarantined, []);
  assert.deepEqual(
    journals.map((journal) => journal.records[0]!.runId),
    ['run-b'],
  );
});

test('an unscoped journal keeps the exact path it had before scoping existed', async (t) => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-machine-journal-'));
  t.after(() => rm(runsDir, { recursive: true, force: true }));
  const store = new MachineParkingIntentJournalStore(runsDir);
  // A file already on disk across an upgrade must still match its own identity
  // check rather than being quarantined for a digest that silently changed.
  assert.equal(
    store.pathFor('machine-a', 'pause', 'op'),
    store.pathFor('machine-a', 'pause', 'op', undefined),
  );
  await store.write('pause', [record('machine-a', 'op')]);
  const { journals, quarantined } = await store.load();
  assert.deepEqual(quarantined, []);
  assert.equal(journals.length, 1);
});

test('write refuses a record the loader would quarantine', async (t) => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-machine-journal-'));
  t.after(() => rm(runsDir, { recursive: true, force: true }));
  const store = new MachineParkingIntentJournalStore(runsDir);
  const broken = {
    ...freeingRecord('free-op', 'run-a'),
    preservedWorkspace: { branch: '', headSha: 'sha' },
  } as MachineParkRecord;

  // Validating only at load means a writer/validator mismatch lands a file and
  // fails silently on the next restart. Validating at write fails the park now.
  await assert.rejects(
    () => store.write('free-slot', [broken], 'run-a'),
    /invalid machine parking intent journal/,
  );
  const { journals } = await store.load();
  assert.deepEqual(journals, []);
});
