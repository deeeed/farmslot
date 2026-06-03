import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTerminalKey, selectPtyKey } from './terminal.js';

test('parseTerminalKey preserves colon-bearing context ids', () => {
  assert.deepEqual(parseTerminalKey('runner-browser-4:ctx:review:1'), {
    slotId: 'runner-browser-4',
    contextId: 'ctx:review:1',
  });
});

test('parseTerminalKey maps role context ids to roles', () => {
  assert.deepEqual(parseTerminalKey('runner-browser-4:review'), {
    slotId: 'runner-browser-4',
    role: 'review',
    contextId: 'review',
  });
});

test('selectPtyKey does not route role-scoped input into the bare-slot PTY', () => {
  const active = new Set(['runner-browser-4']);
  assert.equal(
    selectPtyKey('runner-browser-4', 'runner-browser-4:self-review', (key) => active.has(key)),
    null,
  );
});

test('selectPtyKey preserves legacy slot PTY routing for unscoped terminals', () => {
  const active = new Set(['runner-browser-4']);
  assert.equal(
    selectPtyKey('runner-browser-4', 'runner-browser-4', (key) => active.has(key)),
    'runner-browser-4',
  );
});

test('selectPtyKey prefers the resolved role key when present', () => {
  const active = new Set(['runner-browser-4', 'runner-browser-4:self-review']);
  assert.equal(
    selectPtyKey('runner-browser-4', 'runner-browser-4:self-review', (key) => active.has(key)),
    'runner-browser-4:self-review',
  );
});
