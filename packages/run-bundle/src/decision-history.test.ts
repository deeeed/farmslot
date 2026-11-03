import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mergeDecisionHistoryFile } from './decision-history.js';

test('history merge keeps target bytes and compares incoming rows by exact line', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'history-merge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const existing = '{ "id": "same" }\n{"id":"target"}\n{"id":"target"}\n';
  const incoming = '{"id":"same"}\n{"id":"new"}\n{"id":"new"}\n{"id":"target"}\n';
  const expected = existing + '{"id":"same"}\n{"id":"new"}\n{"id":"new"}\n';
  writeFileSync(source, incoming);
  writeFileSync(target, existing);
  assert.equal(mergeDecisionHistoryFile(source, target, { dryRun: true }), 6);
  assert.equal(readFileSync(target, 'utf8'), existing);
  assert.equal(mergeDecisionHistoryFile(source, target), 6);
  assert.equal(readFileSync(target, 'utf8'), expected);
  assert.equal(mergeDecisionHistoryFile(source, target), 6);
  assert.equal(readFileSync(target, 'utf8'), expected);
  assert.equal(readFileSync(source, 'utf8'), incoming);
});

for (const side of ['source', 'target', 'both'] as const) {
  test(`history merge uses complete lines with a torn ${side} tail`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'history-torn-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    const incoming = '{"id":"incoming"}\n' + (side !== 'target' ? '{"id":' : '');
    writeFileSync(source, incoming);
    writeFileSync(target, '{"id":"target"}\n' + (side !== 'source' ? '{"id":' : ''));
    assert.equal(mergeDecisionHistoryFile(source, target), 2);
    assert.equal(readFileSync(target, 'utf8'), '{"id":"target"}\n{"id":"incoming"}\n');
    assert.equal(readFileSync(source, 'utf8'), incoming);
  });
}
