import assert from 'node:assert/strict';
import test from 'node:test';

import { loadTriageCorpus } from './corpus.js';
import { corpusIntegrityPassed } from './corpus-integrity.js';
import { CORPORA } from './corpus-lock.js';
import { triageMetrics } from './metrics.js';

test('v2 audit cannot lift v1 quarantine or admit an unknown hash', () => {
  assert.equal(corpusIntegrityPassed(CORPORA.v1.hash), false);
  assert.equal(corpusIntegrityPassed(CORPORA.v2.hash), true);
  assert.equal(corpusIntegrityPassed('0'.repeat(64)), false);
});

test('held-out correlation is visible and does not produce independence-based intervals', () => {
  const cases = loadTriageCorpus('v2').cases.filter((c) => c.split === 'held-out');
  const metrics = triageMetrics(cases, []);
  assert.equal(metrics.cases, 21);
  assert.equal(metrics.families, 16);
  assert.equal(metrics.familiesByLabel.external_service, 1);
  assert.equal(metrics.familiesByLabel.unclear, 1);
  assert.equal(metrics.accuracyInterval95, null);
  assert.equal(metrics.definitePrecisionInterval95, null);
  assert.equal(metrics.familyWeightedAccuracy, 0);
  const development = new Set(
    loadTriageCorpus('v2')
      .cases.filter((c) => c.split === 'development')
      .map((c) => c.group),
  );
  assert.ok(cases.every((c) => !development.has(c.group)));
});
