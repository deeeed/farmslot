import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSmartBranch, ticketSlug } from './engine.js';

test('QA free-text titles produce safe branches without changing established eval identifiers', () => {
  assert.equal(ticketSlug('TAT-1234'), 'tat-1234');
  assert.equal(ticketSlug('owner/repo#42'), '42');
  assert.equal(ticketSlug('dataset.v1_case-2'), 'dataset.v1_case-2');
  assert.equal(ticketSlug('trial_' + 'a'.repeat(100)), 'trial_' + 'a'.repeat(100));
  assert.match(buildSmartBranch('qa', 'Core public testnet read-only QA'), /^[a-z0-9/-]+$/);
  assert.match(buildSmartBranch('qa', 'Daily $(touch /tmp/x); changes'), /^[a-z0-9/-]+$/);
  assert.match(buildSmartBranch('qa', '... / ...'), /task/);
  assert.equal(buildSmartBranch('eval', 'dataset.v1_case-2'), 'eval/dataset.v1_case-2');
});

test('QA task names use the same bounded safe slug while eval identifiers remain unchanged', () => {
  for (const title of ["Daily 'quoted' $(printf qa); changes", 'a'.repeat(400), '... / ...']) {
    assert.match(ticketSlug(title, 'qa'), /^[a-z0-9-]{1,80}$/);
  }
  assert.equal(ticketSlug('dataset.v1_case-2', 'eval'), 'dataset.v1_case-2');
});
