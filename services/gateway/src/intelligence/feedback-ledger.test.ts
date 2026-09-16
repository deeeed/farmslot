import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendFeedbackConsumptions,
  consumptionsBySourceKey,
  feedbackLedgerPath,
  readFeedbackLedger,
} from './feedback-ledger.js';

const ENTRY = {
  sourceKey: 'github.com/o/r#1:review-comment:5',
  candidateId: 'cand',
  revision: 'rev',
  destination: 'git@github.com:o/lib.git:review/antipatterns.md',
  rule: 'Some rule',
  recordedAt: '2026-09-16T00:00:00.000Z',
  source: 'approved-audit' as const,
};

test('ledger path prefers the explicit override, else the farmslot home state dir', () => {
  assert.equal(feedbackLedgerPath({ FARMSLOT_FEEDBACK_LEDGER: '/tmp/x.json' }), '/tmp/x.json');
  assert.equal(
    feedbackLedgerPath({ FARMSLOT_HOME: '/home/farm' }),
    path.join('/home/farm', 'state', 'feedback-ledger.json'),
  );
});

test('missing ledger reads empty; appends are idempotent per (candidate, destination, rule)', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'feedback-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'ledger.json');
  assert.deepEqual(await readFeedbackLedger(file), { version: 1, entries: [] });

  assert.equal((await appendFeedbackConsumptions([ENTRY, ENTRY], file)).length, 1);
  assert.equal((await appendFeedbackConsumptions([ENTRY], file)).length, 0);
  assert.equal(
    (await appendFeedbackConsumptions([{ ...ENTRY, rule: 'Another rule' }], file)).length,
    1,
  );
  const ledger = await readFeedbackLedger(file);
  assert.equal(ledger.entries.length, 2);
  assert.equal(consumptionsBySourceKey(ledger).get(ENTRY.sourceKey)?.length, 2);
});

test('a malformed ledger is an error, never silently treated as empty', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'feedback-ledger-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ledger.json');
  writeFileSync(file, JSON.stringify({ version: 2, entries: [] }));
  await assert.rejects(() => readFeedbackLedger(file), /version-1 ledger/);
  writeFileSync(file, JSON.stringify({ version: 1, entries: [{ sourceKey: 'x' }] }));
  await assert.rejects(() => readFeedbackLedger(file), /malformed entry/);
});
