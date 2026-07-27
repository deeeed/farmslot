import assert from 'node:assert/strict';
import test from 'node:test';

import { statusTone } from './planning-badges.js';

test('work in flight outranks work merely available', () => {
  // `ready` was the only positive status, so an idle item was the loudest badge
  // on the board while `running` fell through to the muted default — an item
  // waiting to be picked up read as more urgent than one being worked on.
  assert.equal(statusTone('running'), 'active');
  assert.equal(statusTone('dispatching'), 'active');
  assert.equal(statusTone('queued'), 'active');
  assert.notEqual(statusTone('running'), 'default');
});

test('failure still outranks everything', () => {
  assert.equal(statusTone('failed'), 'danger');
  assert.equal(statusTone('needs-attention'), 'danger');
});

test('available work stays positive and finished work stays muted', () => {
  assert.equal(statusTone('ready'), 'positive');
  assert.equal(statusTone('refined'), 'positive');
  assert.equal(statusTone('promoted'), 'positive');
  assert.equal(statusTone('done'), 'default');
  assert.equal(statusTone('candidate'), 'default');
  assert.equal(statusTone('archived'), 'default');
});
