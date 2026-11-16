import assert from 'node:assert/strict';
import test from 'node:test';

import { litText } from '../../testing/lit-text.js';

import { RunChecklistProgress } from './run-checklist-progress.js';

test('acknowledgement is visible before the checklist read and uses a 24-hour clock', () => {
  const element = new RunChecklistProgress();
  element.acknowledgedAt = '2026-11-16T01:02:03Z';
  const text = litText(element.render());
  assert.match(text, /Worker acknowledged/);
  assert.match(text, /\d{2}:\d{2}:\d{2}/);
  assert.match(text, /datetime=2026-11-16T01:02:03Z/);
  assert.doesNotMatch(text, /AM|PM|1\//);
  element.acknowledgedAt = undefined;
  assert.doesNotMatch(litText(element.render()), /Worker acknowledged/);
});
