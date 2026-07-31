import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENT_ROLES, agentRoleWindow, isReviewerWindowName } from '@farmslot/protocol';

import { shouldKillAgentWindowName } from './release.js';

test('shouldKillAgentWindowName covers role windows and short reviewer tabs', () => {
  const roleWindowNames = new Set(
    AGENT_ROLES.map((role) => agentRoleWindow(role)).filter((name): name is string =>
      Boolean(name),
    ),
  );
  const excluded = new Set(['bugfix']);

  assert.equal(shouldKillAgentWindowName('dev', { roleWindowNames }), true);
  assert.equal(shouldKillAgentWindowName('self-review', { roleWindowNames }), true);
  assert.equal(shouldKillAgentWindowName('rev-codex', { roleWindowNames }), true);
  assert.equal(shouldKillAgentWindowName('rev1-claude', { roleWindowNames }), true);
  assert.equal(shouldKillAgentWindowName('review-fix', { roleWindowNames }), true);
  assert.equal(shouldKillAgentWindowName('review-fix-4', { roleWindowNames }), true);
  assert.equal(shouldKillAgentWindowName('worker', { roleWindowNames }), false);
  assert.equal(shouldKillAgentWindowName('notes', { roleWindowNames }), false);
  assert.equal(shouldKillAgentWindowName('bugfix', { roleWindowNames, excluded }), false);
  assert.equal(isReviewerWindowName('rev-codex'), true);
});
