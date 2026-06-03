import assert from 'node:assert/strict';
import test from 'node:test';

import { validateProposedAction } from './authority-channels.js';
test('Q9 fixture refresh is part of the LLM allowlist', () => {
  assert.deepEqual(validateProposedAction({ type: 'slot.fixtureRefresh' }), {
    ok: true,
    type: 'slot.fixtureRefresh',
  });
});
test('disallowed LLM action demotes to low-confidence proposal-only verdict', () => {
  const res = validateProposedAction({ type: 'shell.exec' });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /not allowed/);
});
