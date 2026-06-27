import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  aggregateAgreementEntries,
  appendRunnerObservabilityAgreement,
} from './observability-agreement-log.js';

test('appendRunnerObservabilityAgreement writes ndjson under configured dir', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'obs-agreement-'));
  t.after(() => {
    process.env.FARMSLOT_OBSERVABILITY_AGREEMENT_DIR = undefined;
  });
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
