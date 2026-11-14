import assert from 'node:assert/strict';
import test from 'node:test';

import { acpAdapters, registerReplayIdentity } from './acp.test-support.js';
import { opencodeEnvironment } from './opencode.js';

registerReplayIdentity(acpAdapters[2]);

test('OpenCode asks before each tool only at the sandboxed tier', () => {
  for (const [safetyTier, permission] of [
    [undefined, '{"*":"ask"}'],
    ['sandboxed', '{"*":"ask"}'],
    // Other tiers keep OpenCode's own rules, as the tmux launch does.
    ['full-auto', undefined],
    ['dangerous', undefined],
  ] as const)
    assert.equal(
      opencodeEnvironment({ cwd: '/w', executable: 'opencode', safetyTier }).OPENCODE_PERMISSION,
      permission,
      String(safetyTier),
    );
});

test('an autonomous OpenCode run also denies the question tool, merged with the tier rule', () => {
  for (const [safetyTier, permission] of [
    ['sandboxed', { '*': 'ask', question: 'deny' }],
    ['full-auto', { question: 'deny' }],
  ] as const) {
    const environment = opencodeEnvironment({
      cwd: '/w',
      executable: 'opencode',
      safetyTier,
      modelQuestions: 'off',
    });
    assert.equal(environment.OPENCODE_PERMISSION, JSON.stringify(permission), safetyTier);
  }
});
