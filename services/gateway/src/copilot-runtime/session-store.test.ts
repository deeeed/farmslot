import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { dangerousLaunchBinding } from './authorization.js';
import { CopilotRuntimeStore, type PersistedCopilotRuntime } from './session-store.js';
import { testCheckout, testWorkload } from './test-helpers.js';

function record(home: string): PersistedCopilotRuntime {
  const checkout = testCheckout('/operator/farmslot');
  return {
    schemaVersion: 1,
    transcriptOffset: 17,
    session: {
      runtimeId: 'gateway-copilot',
      status: 'running',
      tmuxTarget: 'farmslot-copilot:agent.0',
      transcriptId: 'global',
      runner: 'cursor',
      model: 'test-model',
      safetyTier: 'sandboxed',
      checkout,
      workload: testWorkload(true),
      lastDelivery: {
        id: 'delivery',
        state: 'accepted',
        requestedAt: '2026-08-12T00:00:00.000Z',
      },
      updatedAt: '2026-08-12T00:00:00.000Z',
      dangerousLaunch: dangerousLaunchBinding({
        checkout,
        runner: 'cursor',
        model: 'test-model',
      }),
    },
    launchCommandHash: `hash-${home.length}`,
  };
}

test('runtime store persists atomically under FARMSLOT_HOME', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-store-'));
  const store = new CopilotRuntimeStore(home);
  await store.save(record(home));
  assert.equal((await store.load())?.session.runtimeId, 'gateway-copilot');
  assert.equal(path.dirname(store.dir), home);
  assert.equal((await readdir(store.dir)).some((name) => name.includes('.tmp.')), false);
});

test('audit stream is append-only and redacts raw credentials', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'copilot-audit-'));
  const store = new CopilotRuntimeStore(home);
  const base = {
    id: 'one',
    ts: '2026-08-12T00:00:00.000Z',
    action: 'send' as const,
    runtimeId: 'gateway-copilot',
    safetyTier: 'sandboxed',
    checkout: '/operator/farmslot',
    branch: 'feat/test',
    head: 'abc',
  };
  await store.appendAudit({
    ...base,
    detail: { authorization: 'Bearer ghp_12345678901234567890' },
  });
  await store.appendAudit({ ...base, id: 'two', action: 'stop' });
  const content = await readFile(store.auditPath, 'utf8');
  assert.equal(content.trim().split('\n').length, 2);
  assert.doesNotMatch(content, /ghp_/);
  assert.match(content, /\[REDACTED\]/);
});
