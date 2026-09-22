import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readTriageFile, readTriagePolicy } from './policy.js';

test('triage defaults off and admission rejects undeclared settings or source origins', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'triage-policy-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = root;
  const file = path.join(root, 'triage-policy.json');
  try {
    assert.equal((await readTriagePolicy()).enabled, false);
    await writeFile(file, JSON.stringify({ enabled: false }));
    assert.equal((await readTriagePolicy()).enabled, false);
    await writeFile(file, JSON.stringify({ enabled: true, rawTerminalBuffer: 'unadmitted' }));
    await assert.rejects(readTriagePolicy(), /Invalid triage policy/);
    const policy = {
      enabled: true,
      projects: ['fixture'],
      receiptDirectory: root,
      maxCalls: 2,
      maxUsd: 0.01,
      price: {
        version: 1,
        provider: 'fixture',
        model: 'fixed',
        verifiedAt: new Date().toISOString(),
        source: 'https://example.test/prices',
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 0,
        maxRequestTokens: 65536,
      },
      approvals: [
        {
          runId: 'r1',
          project: 'fixture',
          step: 'validation',
          failureHash: 'a'.repeat(64),
          sources: [{ logId: 'fixture-log', digest: 'b'.repeat(64) }],
          origin: { kind: 'private', reference: 'unapproved' },
        },
      ],
    };
    await writeFile(file, JSON.stringify(policy));
    await assert.rejects(readTriagePolicy(), /Invalid triage source approval/);
    policy.approvals[0].origin = { kind: 'synthetic', reference: 'fixture:controlled-input' };
    await writeFile(file, JSON.stringify(policy));
    assert.equal((await readTriagePolicy()).enabled, true);
    await writeFile(file, 'x'.repeat(128 * 1024 + 1));
    await assert.rejects(readTriagePolicy(), /byte limit/);
    await writeFile(file, Buffer.from([0xff]));
    await assert.rejects(readTriageFile(file, 12), /encoded data/);
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    await rm(root, { recursive: true });
  }
});
