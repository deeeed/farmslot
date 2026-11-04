import assert from 'node:assert/strict';
import test from 'node:test';

import { litBindings, litText } from '../../testing/lit-text.js';

import { ProgressReadStatus } from './progress-read-status.js';

test('the shared progress row offers Retry only for a real failure', () => {
  const row = new ProgressReadStatus();
  let retries = 0;
  row.retry = () => retries++;
  assert.equal(litText(row.render()), '');
  row.notice = { kind: 'saved', text: 'Saved progress' };
  assert.doesNotMatch(litText(row.render()), /Retry/);
  row.notice = { kind: 'error', text: 'Could not read progress' };
  const rendered = row.render();
  assert.match(litText(rendered), /Could not read progress/);
  assert.match(litText(rendered), /Retry/);
  const click = litBindings(rendered, '@click=')[0];
  assert(typeof click === 'function');
  const event = new Event('click');
  click(event);
  assert.equal(retries, 1);
  assert.equal(event.cancelBubble, true, 'Retry must not activate the surrounding run row');
});
