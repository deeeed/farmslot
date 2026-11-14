import assert from 'node:assert/strict';
import test from 'node:test';

import { codexNativeAdapter } from './codex.js';
import { readOnlyModes, registerHookPolicy } from './filesystem-policy.test-support.js';

registerHookPolicy(readOnlyModes[1]);

test('filesystem policy requires a known supported native version', () => {
  assert.equal(
    codexNativeAdapter.filesystemPolicyUnavailableReason!('codex-cli 0.154.0'),
    undefined,
  );
  assert.match(
    codexNativeAdapter.filesystemPolicyUnavailableReason!('codex-cli 0.153.0')!,
    /0.154.0/,
  );
  assert.match(codexNativeAdapter.filesystemPolicyUnavailableReason!('unversioned')!, /0.154.0/);
});
