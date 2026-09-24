#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const frozen = {
  'cases.v1.json': 'c880fb613b2e0d4dbd98d9117021be7493ef55e427a6f68c81994732f5a4208b',
  'labels.v1.json': '5ffe2f6754dd6c9981419f82a8839762e925270c12f1e166cc2f094c16eb1f8b',
  'cases.v2.json': '2d922bb707564cda110b69db37752b84216e99f73e120518542a7a661b4e7d18',
  'labels.v2.json': 'f32c5d367ed71ceae38b8aec883f6cb94780206fe8021d38916c6b133d6223c9',
};
const load = (name) => {
  const bytes = readFileSync(new URL(name, import.meta.url));
  const actual = createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    actual,
    frozen[name],
    `${name} changed; version the corpus before another candidate call`,
  );
  return JSON.parse(bytes);
};
load('cases.v1.json');
load('labels.v1.json');
const { version, cases } = load('cases.v2.json');
const { version: labelVersion, labels } = load('labels.v2.json');
assert.equal(version, 2);
assert.equal(labelVersion, 2);
assert.equal(cases.length, 14);
assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
assert.equal(new Set(labels.map((entry) => entry.id)).size, labels.length);
assert.equal(labels.length, 12);
const labeled = new Map(labels.map((entry) => [entry.id, entry]));
for (const entry of cases) {
  assert.match(entry.criterionId, /^AC-[1-9]\d*$/);
  assert.ok(entry.criterion.trim());
  assert.ok(entry.evidence.length > 0);
  assert.equal(new Set(entry.evidence.map((item) => item.id)).size, entry.evidence.length);
  for (const item of entry.evidence) assert.ok(item.id && item.text.trim());
  if (entry.split === 'excluded') {
    assert.ok(['visual', 'mixed'].includes(entry.proofMode));
    assert.equal(labeled.has(entry.id), false);
  } else {
    assert.equal(entry.proofMode, 'state');
    assert.ok(['development', 'held-out'].includes(entry.split));
    assert.ok(
      ['supported', 'contradicted', 'insufficient'].includes(labeled.get(entry.id)?.expected),
    );
  }
}
for (const label of labels) assert.ok(cases.some((entry) => entry.id === label.id));
for (const split of ['development', 'held-out']) {
  for (const answer of ['supported', 'contradicted', 'insufficient']) {
    const count = cases.filter(
      (entry) => entry.split === split && labeled.get(entry.id)?.expected === answer,
    ).length;
    assert.equal(count, split === 'development' ? 1 : 3, `${split}/${answer} count`);
  }
}
assert.ok(
  cases.every((entry) => entry.criterionId === 'AC-1'),
  'criterion ids must not leak labels',
);
console.log('Frozen AC corpus v2: 3 development, 9 held-out, 2 excluded; 12 labels matched');
