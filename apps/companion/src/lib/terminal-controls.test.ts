import assert from 'node:assert/strict';
import test from 'node:test';

import { TERMINAL_CONTROL_KEYS } from './terminal-controls';

test('terminal control keys include mobile TUI navigation sequences', () => {
  const dataByLabel = new Map(TERMINAL_CONTROL_KEYS.map((key) => [key.label, key.data]));

  assert.equal(dataByLabel.get('↑'), '\x1b[A');
  assert.equal(dataByLabel.get('↓'), '\x1b[B');
  assert.equal(dataByLabel.get('←'), '\x1b[D');
  assert.equal(dataByLabel.get('→'), '\x1b[C');
  assert.equal(dataByLabel.get('Tab'), '\x09');
  assert.equal(dataByLabel.get('⇧Tab'), '\x1b[Z');
  assert.equal(dataByLabel.get('^D'), '\x04');
});

test('terminal control keys keep interrupt marked dangerous', () => {
  assert.equal(TERMINAL_CONTROL_KEYS.find((key) => key.label === '^C')?.danger, true);
  assert.equal(TERMINAL_CONTROL_KEYS.find((key) => key.label === '^D')?.danger, true);
});
