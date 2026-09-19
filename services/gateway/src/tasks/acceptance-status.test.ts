import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AcceptanceStatusLedger } from '@farmslot/protocol';

import type { SlotLocality } from '../core/slot-io.js';

import {
  ACCEPTANCE_STATUS_FILENAME,
  acceptanceCoverageMarkdown,
  AcceptanceReadError,
  acceptanceStatusPathFor,
  handoffCriteriaFromText,
  handoffListsAcceptanceCriteria,
  ledgerFromArtifactText,
  parseAcceptanceStatusLedger,
  readAcceptanceStatusForDisplay,
  readAcceptanceStatusLedger,
  readHandoffAcceptanceCriteria,
} from './acceptance-status.js';

const LOCAL: SlotLocality = {
  host: 'localhost',
  machine: 'local',
  sshTarget: '',
};

const LEDGER: AcceptanceStatusLedger = {
  schemaVersion: 1,
  criteria: [
    {
      id: 'AC-1',
      text: 'The panel lists every criterion',
      verdict: 'proven',
      proofMode: 'visual',
      evidence: ['artifacts/after-panel.png'],
      recipeNodes: ['assert-panel'],
      updatedAt: '2026-09-19T10:00:00.000Z',
    },
    {
      id: 'AC-2',
      text: 'A weak verdict blocks the mark',
      verdict: 'untestable',
      evidence: [],
      recipeNodes: [],
      note: 'No client reaches it yet.',
      updatedAt: '2026-09-19T10:05:00.000Z',
    },
  ],
};

function taskDirWith(body: string | null, handoff?: string | null): string {
  const taskDir = mkdtempSync(path.join(os.tmpdir(), 'gw-acceptance-'));
  mkdirSync(path.join(taskDir, 'artifacts'), { recursive: true });
  mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  if (body !== null) writeFileSync(acceptanceStatusPathFor(taskDir), body);
  if (handoff !== null && handoff !== undefined) {
    writeFileSync(path.join(taskDir, 'inputs', 'handoff.json'), handoff);
  }
  return taskDir;
}

test('the ledger path is the contract path beside the task dir', () => {
  assert.equal(
    acceptanceStatusPathFor('/tmp/task'),
    path.join('/tmp/task', 'artifacts', ACCEPTANCE_STATUS_FILENAME),
  );
});

test('a valid ledger reads back through the slot IO layer', async () => {
  const taskDir = taskDirWith(`${JSON.stringify(LEDGER, null, 2)}\n`);
  try {
    assert.deepEqual(await readAcceptanceStatusLedger(LOCAL, taskDir), LEDGER);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test('a task directory without a ledger reads as null, not an error', async () => {
  const taskDir = taskDirWith(null);
  try {
    assert.equal(await readAcceptanceStatusLedger(LOCAL, taskDir), null);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
});

test('a ledger that breaks the contract throws, naming the field', () => {
  assert.throws(
    () => parseAcceptanceStatusLedger('{ not json'),
    /invalid artifacts\/acceptance-status\.json/,
  );
  assert.throws(
    () =>
      parseAcceptanceStatusLedger(
        JSON.stringify({
          schemaVersion: 1,
          criteria: [{ ...LEDGER.criteria[0], verdict: 'nope' }],
        }),
      ),
    /criteria\[0\]\.verdict/,
  );
  assert.throws(
    () => parseAcceptanceStatusLedger(JSON.stringify({ schemaVersion: 2, criteria: [] })),
    /schemaVersion: expected 1/,
  );
});

test('the display read reports a broken ledger instead of failing progress', async () => {
  const taskDir = taskDirWith('{ not json');
  try {
    const read = await readAcceptanceStatusForDisplay(LOCAL, taskDir);
    assert.equal(read.ledger, null);
    assert.match(read.error ?? '', /invalid .*acceptance-status\.json/);
  } finally {
    rmSync(taskDir, { recursive: true, force: true });
  }
  assert.equal(ledgerFromArtifactText('{ not json'), null);
  assert.equal(ledgerFromArtifactText(''), null);
  assert.equal(ledgerFromArtifactText(undefined), null);
  assert.deepEqual(ledgerFromArtifactText(JSON.stringify(LEDGER)), LEDGER);
});

test('coverage markdown comes from the ledger, and only when it has criteria', () => {
  const rendered = acceptanceCoverageMarkdown(LEDGER);
  assert.ok(rendered, 'a ledger with criteria renders');
  assert.match(rendered, /\| AC-1 \|.*\| PROVEN \| visual \| assert-panel \|/);
  assert.match(
    rendered.trimEnd().split('\n').pop() ?? '',
    /^Overall recipe coverage: 1\/2 ACs PROVEN \(untestable: AC-2, weak: 0, missing: 0\)$/,
  );
  // No ledger and an empty ledger both mean "keep reading recipe-coverage.md".
  assert.equal(acceptanceCoverageMarkdown(null), null);
  assert.equal(acceptanceCoverageMarkdown({ schemaVersion: 1, criteria: [] }), null);
});

test('the handoff read fails closed for the terminal check and open for display', async () => {
  const criteria = JSON.stringify({ task: { acceptanceCriteria: ['one', 'two'] } });
  const good = taskDirWith(null, criteria);
  try {
    assert.deepEqual(await readHandoffAcceptanceCriteria(LOCAL, good), [
      { id: 'AC-1', text: 'one' },
      { id: 'AC-2', text: 'two' },
    ]);
    assert.equal(await handoffListsAcceptanceCriteria(LOCAL, good), true);
  } finally {
    rmSync(good, { recursive: true, force: true });
  }

  // Corrupt handoff: the terminal path must throw rather than report "no criteria",
  // which would silently drop the ledger requirement from a completion.
  const corrupt = taskDirWith(null, '{ not json');
  try {
    await assert.rejects(
      () => readHandoffAcceptanceCriteria(LOCAL, corrupt),
      (err: unknown) =>
        err instanceof AcceptanceReadError &&
        /invalid .*handoff\.json/.test((err as Error).message),
    );
    await assert.rejects(() => handoffListsAcceptanceCriteria(LOCAL, corrupt));
    // The display path reports it instead, so a panel can say why it is empty.
    const read = await readAcceptanceStatusForDisplay(LOCAL, corrupt);
    assert.deepEqual(read.criteria, []);
    assert.equal(read.ledger, null);
    assert.match(read.error ?? '', /invalid .*handoff\.json/);
  } finally {
    rmSync(corrupt, { recursive: true, force: true });
  }

  // A task with no handoff at all has no criteria; that is not an error.
  const none = taskDirWith(null, null);
  try {
    assert.deepEqual(await readHandoffAcceptanceCriteria(LOCAL, none), []);
    assert.equal((await readAcceptanceStatusForDisplay(LOCAL, none)).error, undefined);
  } finally {
    rmSync(none, { recursive: true, force: true });
  }
});

test('handoff criteria parsed from text mirror the slot read, errors included', () => {
  assert.deepEqual(
    handoffCriteriaFromText(JSON.stringify({ task: { acceptanceCriteria: ['a'] } })),
    {
      criteria: [{ id: 'AC-1', text: 'a' }],
    },
  );
  assert.deepEqual(handoffCriteriaFromText(null), { criteria: [] });
  assert.match(handoffCriteriaFromText('{ not json').error ?? '', /invalid inputs\/handoff\.json/);
  assert.match(
    handoffCriteriaFromText(JSON.stringify({ task: { acceptanceCriteria: 'one' } })).error ?? '',
    /must be an array/,
  );
});

test('coverage markdown counts the registered criteria, not the recorded rows', () => {
  const partial = { schemaVersion: 1 as const, criteria: [LEDGER.criteria[0]] };
  const rendered = acceptanceCoverageMarkdown(partial, [
    { id: 'AC-1', text: LEDGER.criteria[0].text },
    { id: 'AC-2', text: 'Not judged yet' },
  ]);
  assert.match(rendered ?? '', /Overall recipe coverage: 1\/2 ACs PROVEN/);
  assert.match(rendered ?? '', /NO VERDICT/);
});
