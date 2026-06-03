import assert from 'node:assert/strict';
import test from 'node:test';

import { decisionPayloadKind } from './decision-payload-model.js';

test('decisionPayloadKind narrows unknown decision payloads without casts', () => {
  assert.equal(decisionPayloadKind({ kind: 'ready' }), 'ready');
  assert.equal(decisionPayloadKind({ kind: 123 }), undefined);
  assert.equal(decisionPayloadKind(null), undefined);
});
