import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  aggregateAgreementEntries,
  appendRunnerObservabilityAgreement,
  resetAgreementLogDirCacheForTests,
} from './observability-agreement-log.js';

test('appendRunnerObservabilityAgreement writes ndjson under configured dir', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'obs-agreement-'));
  t.after(() => {
    delete process.env.FARMSLOT_OBSERVABILITY_AGREEMENT_DIR;
    resetAgreementLogDirCacheForTests();
  });
  resetAgreementLogDirCacheForTests();
  process.env.FARMSLOT_OBSERVABILITY_AGREEMENT_DIR = dir;
  const entry = {
    slotId: 'runner-local-mm-1',
    runner: 'claude',
    target: 'dev:1',
    logPrefix: '[nudge]',
    paneBusy: false,
    hookBusy: true,
    hookActivity: 'composing' as const,
    hookSource: 'hook',
    hookConfidence: 'high',
    hookObservedAt: Date.now(),
    agreed: false,
    disagreementReason: 'hook-composing-pane-idle',
    timestamp: Date.now(),
  };
  await appendRunnerObservabilityAgreement(entry);
  const files = await readFile(
    path.join(dir, `agreement-${new Date(entry.timestamp).toISOString().slice(0, 10)}.ndjson`),
    'utf8',
  );
  assert.match(files, /runner-observability-agreement/);
  const agg = aggregateAgreementEntries([entry]);
  assert.equal(agg.disagreed, 1);
});

test('appendRunnerObservabilityAgreement persists ADR-032 inverted-log markers', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'obs-agreement-inv-'));
  t.after(() => {
    delete process.env.FARMSLOT_OBSERVABILITY_AGREEMENT_DIR;
    resetAgreementLogDirCacheForTests();
  });
  resetAgreementLogDirCacheForTests();
  process.env.FARMSLOT_OBSERVABILITY_AGREEMENT_DIR = dir;
  const ts = Date.parse('2026-07-16T00:00:00.000Z');
  const entry = {
    slotId: 'macwork-ff-3',
    runner: 'claude',
    target: 'ff-3:dev',
    logPrefix: '[nudge]',
    // Hook was unavailable → flag-off would have consulted the pane here; paneBusy is the
    // counterfactual pane-would-have-said.
    paneBusy: false,
    hookBusy: null,
    hookActivity: null,
    hookSource: null,
    hookConfidence: null,
    hookObservedAt: null,
    agreed: null,
    paneRetired: true,
    wouldConsultPane: true,
    timestamp: ts,
  };
  await appendRunnerObservabilityAgreement(entry);
  const raw = await readFile(path.join(dir, 'agreement-2026-07-16.ndjson'), 'utf8');
  const parsed = JSON.parse(raw.trim());
  assert.equal(parsed.paneRetired, true);
  assert.equal(parsed.wouldConsultPane, true);
  assert.equal(parsed.paneBusy, false);
  const agg = aggregateAgreementEntries([entry]);
  assert.equal(agg.hookUnavailable, 1);
  assert.equal(agg.wouldConsultPane, 1);
});

test('aggregateAgreementEntries counts wouldConsultPane across mixed entries', () => {
  const base = {
    slotId: 'macwork-ff-3',
    runner: 'claude',
    target: 'ff-3:dev',
    logPrefix: '[nudge]',
    hookSource: null,
    hookConfidence: null,
    hookObservedAt: null,
    timestamp: 1,
  };
  const agg = aggregateAgreementEntries([
    // Degraded hold recorded mid-loop: hook unavailable, would consult pane.
    {
      ...base,
      paneBusy: false,
      hookBusy: null,
      hookActivity: null,
      agreed: null,
      paneRetired: true,
      wouldConsultPane: true,
    },
    {
      ...base,
      paneBusy: true,
      hookBusy: null,
      hookActivity: null,
      agreed: null,
      paneRetired: true,
      wouldConsultPane: true,
    },
    // Authoritative decision under the flag: hook resolved, no pane consult.
    {
      ...base,
      paneBusy: true,
      hookBusy: true,
      hookActivity: 'tool-running' as const,
      agreed: true,
      paneRetired: true,
    },
  ]);
  assert.equal(agg.total, 3);
  assert.equal(agg.wouldConsultPane, 2);
  assert.equal(agg.hookUnavailable, 2);
  assert.equal(agg.agreed, 1);
});
