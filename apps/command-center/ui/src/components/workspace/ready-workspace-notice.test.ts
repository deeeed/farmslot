import assert from 'node:assert/strict';
import test from 'node:test';

import { litText } from '../../testing/lit-text.js';
import { RetainedNotice } from '../shared/retained-notice.js';

import {
  readyResolvedNotice,
  renderReadyResolvedBanner,
} from './ready-workspace-package-renderers.js';

test('a missing observation retains the whole notice; a current unresolved decision clears it', () => {
  const notice = new RetainedNotice();
  const scope = 'owner/run/decision';
  const message = readyResolvedNotice({ headSha: 'abcdef0123456789' }, '2026-10-30T00:00:00Z');
  assert.ok(message);
  notice.read(scope, message, true);
  const retained = notice.read(scope, undefined, true);
  const rendered = litText(renderReadyResolvedBanner({ message: retained }));
  assert.match(rendered, /2026-10-30T00:00:00Z at commit abcdef0/);
  assert.doesNotMatch(rendered, /1111111|resolved undefined/);
  assert.equal(notice.read(scope, undefined, false), undefined);
  assert.equal(notice.read('owner/run/other-decision', undefined, true), undefined);
});

test('an unresolved gate has the same notice row, with saved-read text instead of an invented resolution', () => {
  const ready = litText(renderReadyResolvedBanner({}));
  const saved = litText(renderReadyResolvedBanner({ savedMessage: 'Saved gate · 5s ago' }));
  assert.match(ready, /rdy-notice-slot/);
  assert.match(saved, /rdy-notice-slot/);
  assert.match(saved, /Saved gate · 5s ago/);
  assert.doesNotMatch(ready + saved, /Decision resolved|undefined/);
});
