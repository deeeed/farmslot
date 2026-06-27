import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  aggregateAgreementEntries,
  appendRunnerObservabilityAgreement,
  resetAgreementLogDirCacheForTests,
} from './observability-agreement-log.js';
import type { RunnerObservabilityAgreementEntry } from './observability-agreement.js';

function baseEntry(
  overrides: Partial<RunnerObservabilityAgreementEntry>,
): RunnerObservabilityAgreementEntry {
  return {
    slotId: 'gate-slot',
    runner: 'claude',
    target: 'worker',
    logPrefix: '[test]',
    paneBusy: false,
    hookBusy: false,
    hookActivity: 'idle',
    hookSource: 'hooks',
    hookConfidence: 'high',
    hookObservedAt: Date.now(),
    agreed: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

test('200-event agreement window meets Phase 1 exit threshold in synthetic harness', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obs-agreement-window-'));
  const prev = process.env.FARMSLOT_OBSERVABILITY_AGREEMENT_DIR;
  process.env.FARMSLOT_OBSERVABILITY_AGREEMENT_DIR = dir;
  resetAgreementLogDirCacheForTests();

  try {
    const total = 200;
    const disagreeEvery = 100;
    for (let i = 0; i < total; i += 1) {
      const agreed = i % disagreeEvery !== 0;
      await appendRunnerObservabilityAgreement(
        baseEntry({
          agreed,
          paneBusy: agreed ? false : true,
          hookBusy: false,
          disagreementReason: agreed ? undefined : 'pane-busy-hook-idle',
          timestamp: Date.now() + i,
        }),
      );
    }

    const files = await fs.readdir(dir);
    assert.ok(files.some((name) => name.startsWith('agreement-') && name.endsWith('.ndjson')));

    const raw = await fs.readFile(path.join(dir, files[0]!), 'utf-8');
    const rows = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as RunnerObservabilityAgreementEntry);
    assert.equal(rows.length, total);

    const aggregate = aggregateAgreementEntries(rows);
    const comparable = aggregate.agreed + aggregate.disagreed;
    const rate = comparable > 0 ? aggregate.agreed / comparable : 0;
    assert.equal(comparable, total);
    assert.ok(rate >= 0.98, `expected >=98% agreement, got ${rate}`);
  } finally {
    if (prev === undefined) delete process.env.FARMSLOT_OBSERVABILITY_AGREEMENT_DIR;
    else process.env.FARMSLOT_OBSERVABILITY_AGREEMENT_DIR = prev;
    resetAgreementLogDirCacheForTests();
    await fs.rm(dir, { recursive: true, force: true });
  }
});