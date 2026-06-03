import assert from 'node:assert/strict';
import test from 'node:test';

import { redactToAllowlist } from './audit-fields.js';
test('redactToAllowlist keeps ADR-031 fields and drops free text', () => {
  const out = redactToAllowlist({
    id: 'a',
    timestamp: 't',
    decidedAt: 'd',
    runId: 'r',
    actor: 'auto-recovery',
    verdict: { category: 'infra', confidence: 'high', rationale: 'drop' },
    guards: [{ name: 'g', passed: true, reason: 'drop' }],
    outcome: 'applied',
    tier: 'deterministic',
    costUsd: 0,
    appliedAction: { type: 'tmux.send', tmuxKeys: 'x' },
  } as any);
  assert.equal(out.verdict.rationale, undefined);
  assert.equal((out.guards[0] as any).reason, undefined);
  assert.equal(out.appliedAction?.tmuxKeys, 'x');
});
test('redactToAllowlist removes extra nested appliedAction fields', () => {
  const out = redactToAllowlist({
    id: 'a',
    timestamp: 't',
    decidedAt: 'd',
    runId: 'r',
    actor: 'auto-recovery',
    verdict: { confidence: 'high' },
    guards: [],
    outcome: 'proposed',
    tier: 'deterministic',
    costUsd: 0,
    appliedAction: { type: 'tmux.send', tmuxKeys: 'x', command: 'rm -rf /' },
  } as any);
  assert.equal((out.appliedAction as any).command, undefined);
});
