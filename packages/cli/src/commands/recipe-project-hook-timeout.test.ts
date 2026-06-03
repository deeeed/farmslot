import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRecipeProjectHookGatewayTimeoutMs } from './recipe-project-hook-timeout.js';

test('recipe project-hook run keeps the gateway request alive for the hook timeout', () => {
  assert.equal(resolveRecipeProjectHookGatewayTimeoutMs('30000', 240_000), 245_000);
});

test('recipe project-hook run preserves larger explicit gateway timeouts', () => {
  assert.equal(resolveRecipeProjectHookGatewayTimeoutMs('300000', 240_000), 300_000);
});

test('recipe project-hook run keeps the gateway request alive for the default hook timeout', () => {
  assert.equal(resolveRecipeProjectHookGatewayTimeoutMs(undefined), 65_000);
  assert.equal(resolveRecipeProjectHookGatewayTimeoutMs('30000'), 65_000);
});
