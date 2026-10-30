import assert from 'node:assert/strict';
import test from 'node:test';

import { RetainedNotice } from './retained-notice.js';

test('a resolved gate notice survives a missing observation within its exact owner and decision', () => {
  const notice = new RetainedNotice();
  const scope = 'owner-a/run-a/decision-a';
  assert.equal(notice.read(scope, undefined, true), undefined);
  assert.equal(
    notice.read(scope, 'Resolved at commit abc1234', true),
    'Resolved at commit abc1234',
  );
  assert.equal(notice.read(scope, undefined, true), 'Resolved at commit abc1234');
  assert.equal(notice.read('owner-a/run-a/decision-b', undefined, true), undefined);
  assert.equal(notice.read(scope, undefined, true), undefined);
  notice.read(scope, 'Resolved at commit abc1234', true);
  assert.equal(notice.read('owner-b/run-a/decision-a', undefined, true), undefined);
  notice.read(scope, 'Resolved at commit abc1234', true);
  assert.equal(notice.read(undefined, undefined, true), undefined);
  assert.equal(notice.read(scope, undefined, true), undefined);
});

test('a read error remains visible during retry and clears only on a successful read or a new query', () => {
  const notice = new RetainedNotice();
  const scope = 'owner/project-a/templates';
  notice.read(scope, 'Project source unavailable', false);
  assert.equal(notice.read(scope, undefined, true), 'Project source unavailable');
  assert.equal(notice.read(scope, undefined, false), undefined);
  notice.read(scope, 'Project source unavailable', false);
  assert.equal(notice.read('owner/project-b/templates', undefined, true), undefined);
});
