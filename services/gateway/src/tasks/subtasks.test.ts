import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SubtaskIndexUnit } from '@farmslot/protocol';

import { joinSchemaWithMarkdown } from '../methods/task.js';

import {
  attachSubtaskToStep,
  buildSubtaskEntry,
  listOpenSubtaskUnits,
  openSubtaskContractMessage,
  parseSubtaskIndex,
  parseSubtaskSignal,
  projectSubtaskStatus,
  readSubtaskIndex,
  readSubtaskUnits,
  SUBTASK_STALE_AFTER_MS,
  subtaskUnitsForParentChecklist,
} from './subtasks.js';
import { generateTaskSchema } from './writer.js';

// A local slot: slot-io treats host `localhost` + machine `local` as local IO.
const LOCAL = { host: 'localhost', machine: 'local', sshTarget: '' };

const CHILD_MARKDOWN = [
  '# Parity gate',
  '',
  '- [ ] **1. read the failing job output**',
  '- [ ] **2. reproduce it locally**',
  '- [ ] **3. record the parity result**',
  '',
].join('\n');

function unit(overrides: Partial<SubtaskIndexUnit> = {}): SubtaskIndexUnit {
  return {
    id: 'ci-parity',
    parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
    checklist: 'subtasks/ci-parity.md',
    signal: 'subtasks/ci-parity-SIGNAL.json',
    source: { kind: 'skill', ref: 'skills/ci.md', sha256: 'aa', renderedSha256: 'bb' },
    registeredAt: '2026-09-19T10:00:00Z',
    ...overrides,
  };
}

function indexJson(units: SubtaskIndexUnit[]): string {
  return `${JSON.stringify({ schemaVersion: 1, units }, null, 2)}\n`;
}

/** A task dir with a parent checklist plus whatever child files the test needs. */
function makeTaskDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gw-subtasks-'));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf-8');
  }
  return dir;
}

const PARENT_MARKDOWN = [
  '# Worker',
  '',
  '- [x] **1. read the ticket**',
  '- [ ] **2. run the review skill**',
  '- [ ] **3. write the report**',
  '',
].join('\n');

function parentStructured(): ReturnType<typeof joinSchemaWithMarkdown> {
  return joinSchemaWithMarkdown(generateTaskSchema(PARENT_MARKDOWN, 'dev'), PARENT_MARKDOWN);
}

test('parseSubtaskIndex rejects a present-but-invalid registry instead of reporting no children', () => {
  assert.throws(() => parseSubtaskIndex('{'), /invalid subtasks\/index\.json/);
  assert.throws(() => parseSubtaskIndex('{"schemaVersion":2,"units":[]}'), /schemaVersion/);
  assert.throws(() => parseSubtaskIndex('{"schemaVersion":1}'), /units/);
  assert.throws(
    () => parseSubtaskIndex(indexJson([unit({ id: 'Not A Slug' as string })])),
    /units\[0\]\.id must be a slug/,
  );
  assert.throws(
    () => parseSubtaskIndex(indexJson([unit({ checklist: '../escape.md' })])),
    /units\[0\]\.checklist must be a subtasks\/ relative path/,
  );
  assert.throws(
    () => parseSubtaskIndex(indexJson([unit({ signal: 'subtasks/../SIGNAL.json' })])),
    /units\[0\]\.signal must be a normalized path/,
  );
  assert.throws(
    () =>
      parseSubtaskIndex(
        indexJson([unit({ parent: { checklist: 'CHECKLIST.md', stepNumber: 0 } })]),
      ),
    /units\[0\]\.parent/,
  );
  // The happy path keeps every field.
  assert.deepEqual(parseSubtaskIndex(indexJson([unit()])).units[0], unit());
});

test('readSubtaskIndex returns null for a task dir with no registry', async () => {
  const dir = makeTaskDir({ 'CHECKLIST.md': PARENT_MARKDOWN });
  try {
    assert.equal(await readSubtaskIndex(LOCAL, dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSubtaskIndex propagates a corrupt registry as an error', async () => {
  const dir = makeTaskDir({ 'CHECKLIST.md': PARENT_MARKDOWN, 'subtasks/index.json': 'nope' });
  try {
    await assert.rejects(() => readSubtaskIndex(LOCAL, dir), /invalid .*index\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('subtaskUnitsForParentChecklist keeps only the children of one checklist', () => {
  const index = parseSubtaskIndex(
    indexJson([
      unit(),
      unit({
        id: 'domain-patterns',
        parent: { checklist: 'SELF-REVIEW.md', stepNumber: 3 },
        checklist: 'subtasks/domain-patterns.md',
        signal: 'subtasks/domain-patterns-SIGNAL.json',
      }),
    ]),
  );
  assert.deepEqual(
    subtaskUnitsForParentChecklist(index, 'CHECKLIST.md').map((entry) => entry.id),
    ['ci-parity'],
  );
  assert.deepEqual(
    subtaskUnitsForParentChecklist(index, 'SELF-REVIEW.md').map((entry) => entry.id),
    ['domain-patterns'],
  );
  assert.deepEqual(subtaskUnitsForParentChecklist(null, 'CHECKLIST.md'), []);
});

test('projectSubtaskStatus only ever projects stale over a running child', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  const fresh = new Date(now - 60_000).toISOString();
  const old = new Date(now - SUBTASK_STALE_AFTER_MS - 1_000).toISOString();

  assert.equal(projectSubtaskStatus('running', fresh, now), 'running');
  assert.equal(projectSubtaskStatus('running', old, now), 'stale');
  // A registered child that has not marked anything yet is running, not stale.
  assert.equal(projectSubtaskStatus('running', null, now), 'running');
  // Every other status is the file's own, however old the last event.
  assert.equal(projectSubtaskStatus('blocked', old, now), 'blocked');
  assert.equal(projectSubtaskStatus('complete', old, now), 'complete');
  assert.equal(projectSubtaskStatus(null, old, now), null);
});

test('parseSubtaskSignal narrows an untyped child signal and finds its newest mark', () => {
  assert.deepEqual(
    parseSubtaskSignal({
      status: 'running',
      timestamp: '2026-09-19T10:00:00Z',
      checklistTiming: {
        schemaVersion: 1,
        source: 'subtasks/ci-parity.md',
        events: [
          { stepNumber: 1, label: '1. a', checkedAt: '2026-09-19T10:05:00Z' },
          { stepNumber: 2, label: '2. b', checkedAt: '2026-09-19T10:02:00Z' },
          // Malformed rows are dropped at the boundary, not carried downstream.
          { stepNumber: 'three', label: '3. c', checkedAt: '2026-09-19T10:09:00Z' },
        ],
      },
    }),
    {
      status: 'running',
      lastEventAt: '2026-09-19T10:05:00Z',
      checklistTiming: {
        schemaVersion: 1,
        source: 'subtasks/ci-parity.md',
        events: [
          { stepNumber: 1, label: '1. a', checkedAt: '2026-09-19T10:05:00Z' },
          { stepNumber: 2, label: '2. b', checkedAt: '2026-09-19T10:02:00Z' },
        ],
      },
    },
  );
  // No marks yet: the signal timestamp is the last evidence the child moved.
  assert.deepEqual(parseSubtaskSignal({ status: 'blocked', timestamp: '2026-09-19T10:00:00Z' }), {
    status: 'blocked',
    lastEventAt: '2026-09-19T10:00:00Z',
  });
  // A status outside the signal union is not a status.
  assert.equal(parseSubtaskSignal({ status: 'stale' }).status, null);
  assert.deepEqual(parseSubtaskSignal(null), { status: null, lastEventAt: null });
});

test('attachSubtaskToStep puts the child under the owning step and reports a missing one', async () => {
  const dir = makeTaskDir({
    'CHECKLIST.md': PARENT_MARKDOWN,
    'subtasks/index.json': indexJson([unit()]),
    'subtasks/ci-parity.md': CHILD_MARKDOWN.replace(
      '- [ ] **1. read the failing job output**',
      '- [x] **1. read the failing job output**',
    ),
    'subtasks/ci-parity-SIGNAL.json': JSON.stringify({
      role: 'subtask',
      contextId: 'ci-parity',
      parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
      status: 'running',
      checklistTiming: {
        schemaVersion: 1,
        events: [{ stepNumber: 1, label: '1. read', checkedAt: '2026-09-19T10:05:00Z' }],
      },
      timestamp: '2026-09-19T10:05:00Z',
    }),
  });
  try {
    const index = await readSubtaskIndex(LOCAL, dir);
    const units = subtaskUnitsForParentChecklist(index, 'CHECKLIST.md');
    const reads = await readSubtaskUnits(LOCAL, dir, units);
    assert.equal(reads.length, 1);

    const childProgress = joinSchemaWithMarkdown(
      generateTaskSchema(reads[0].markdown, 'dev'),
      reads[0].markdown,
    );
    const nowMs = Date.parse('2026-09-19T10:06:00Z');
    const entry = buildSubtaskEntry(reads[0].unit, childProgress, reads[0].signal, nowMs);
    assert.equal(entry.id, 'ci-parity');
    assert.equal(entry.status, 'running');
    assert.equal(entry.lastEventAt, '2026-09-19T10:05:00Z');
    assert.equal(entry.progress.completedSteps, 1);
    assert.equal(entry.progress.totalSteps, 3);
    assert.deepEqual(entry.source, unit().source);

    const structured = parentStructured();
    assert.equal(attachSubtaskToStep(structured, 2, entry), true);
    const steps = structured.phases.flatMap((phase) => phase.steps);
    assert.equal(steps.find((step) => step.index === 2)?.subtask?.id, 'ci-parity');
    assert.equal(steps.find((step) => step.index === 1)?.subtask, undefined);
    // A child naming a step this checklist no longer has is reported, not attached.
    assert.equal(attachSubtaskToStep(structured, 99, entry), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildSubtaskEntry projects stale, blocked, and complete from the child signal', async () => {
  const nowMs = Date.parse('2026-09-19T12:00:00Z');
  const staleAt = new Date(nowMs - SUBTASK_STALE_AFTER_MS - 60_000).toISOString();
  const childProgress = joinSchemaWithMarkdown(
    generateTaskSchema(CHILD_MARKDOWN, 'dev'),
    CHILD_MARKDOWN,
  );
  const signalWith = (status: string, checkedAt: string) =>
    parseSubtaskSignal({
      status,
      timestamp: checkedAt,
      checklistTiming: {
        schemaVersion: 1,
        events: [{ stepNumber: 1, label: '1. read', checkedAt }],
      },
    });

  assert.equal(
    buildSubtaskEntry(unit(), childProgress, signalWith('running', staleAt), nowMs).status,
    'stale',
  );
  // `stale` is a projection: a blocked or complete child keeps its file status.
  assert.equal(
    buildSubtaskEntry(unit(), childProgress, signalWith('blocked', staleAt), nowMs).status,
    'blocked',
  );
  assert.equal(
    buildSubtaskEntry(unit(), childProgress, signalWith('complete', staleAt), nowMs).status,
    'complete',
  );
  // A registered child whose signal has not landed yet reads as running.
  assert.equal(buildSubtaskEntry(unit(), childProgress, null, nowMs).status, 'running');
});

test('listOpenSubtaskUnits treats blocked as open and complete as settled', async () => {
  const childSignal = (status: string) =>
    JSON.stringify({
      role: 'subtask',
      contextId: 'x',
      parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
      status,
      timestamp: '2026-09-19T10:00:00Z',
    });
  const units = [
    unit({
      id: 'running-one',
      checklist: 'subtasks/running-one.md',
      signal: 'subtasks/running-one-SIGNAL.json',
      parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
    }),
    unit({
      id: 'blocked-one',
      checklist: 'subtasks/blocked-one.md',
      signal: 'subtasks/blocked-one-SIGNAL.json',
      parent: { checklist: 'CHECKLIST.md', stepNumber: 3 },
    }),
    unit({
      id: 'done-one',
      checklist: 'subtasks/done-one.md',
      signal: 'subtasks/done-one-SIGNAL.json',
      parent: { checklist: 'SELF-REVIEW.md', stepNumber: 1 },
    }),
  ];
  const dir = makeTaskDir({
    'CHECKLIST.md': PARENT_MARKDOWN,
    'subtasks/index.json': indexJson(units),
    'subtasks/running-one.md': CHILD_MARKDOWN,
    'subtasks/running-one-SIGNAL.json': childSignal('running'),
    'subtasks/blocked-one.md': CHILD_MARKDOWN,
    'subtasks/blocked-one-SIGNAL.json': childSignal('blocked'),
    'subtasks/done-one.md': CHILD_MARKDOWN,
    'subtasks/done-one-SIGNAL.json': childSignal('complete'),
  });
  try {
    const open = await listOpenSubtaskUnits(LOCAL, dir);
    assert.deepEqual(
      open.map((entry) => `${entry.unit.id}:${entry.status}`),
      ['running-one:running', 'blocked-one:blocked'],
    );
    const message = openSubtaskContractMessage(open, 'complete');
    assert.match(message, /running-one \(running\)/);
    assert.match(message, /blocked-one \(blocked\)/);
    assert.match(message, /\.\/mark sub running-one complete/);
    assert.match(message, /\.\/mark complete cannot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listOpenSubtaskUnits reports a registered unit whose signal never landed', async () => {
  const dir = makeTaskDir({
    'CHECKLIST.md': PARENT_MARKDOWN,
    'subtasks/index.json': indexJson([unit()]),
    'subtasks/ci-parity.md': CHILD_MARKDOWN,
  });
  try {
    const open = await listOpenSubtaskUnits(LOCAL, dir);
    assert.deepEqual(
      open.map((entry) => [entry.unit.id, entry.status]),
      [['ci-parity', null]],
    );
    assert.match(openSubtaskContractMessage(open, 'complete'), /ci-parity \(no signal\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSubtaskUnits skips a registered unit whose checklist is missing', async () => {
  const dir = makeTaskDir({
    'CHECKLIST.md': PARENT_MARKDOWN,
    'subtasks/index.json': indexJson([unit()]),
  });
  try {
    const index = await readSubtaskIndex(LOCAL, dir);
    assert.deepEqual(await readSubtaskUnits(LOCAL, dir, index?.units ?? []), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
