import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isDeterministicAuthRejection, resolveGatewayCredential } from './gateway-credential.js';

test('gateway credential is re-read from the node env file on every reconnect lookup', () => {
  const root = mkdtempSync(join(tmpdir(), 'farmslot-node-credential-'));
  const nested = join(root, 'services', 'node');
  mkdirSync(nested, { recursive: true });
  const path = join(root, '.env.local-auth');
  writeFileSync(path, 'FARMSLOT_NODE_TOKEN=first\n');
  assert.deepEqual(resolveGatewayCredential({}, nested), { token: 'first' });

  writeFileSync(path, 'FARMSLOT_NODE_TOKEN=second\n');
  assert.deepEqual(resolveGatewayCredential({}, nested), { token: 'second' });
});

test('rewritten node env credential outranks stale inherited launch credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'farmslot-node-credential-stale-env-'));
  const nested = join(root, 'services', 'node');
  mkdirSync(nested, { recursive: true });
  const path = join(root, '.env.local-auth');
  const launchedEnv = {
    FARMSLOT_NODE_TOKEN: 'stale-node-token',
    FARMSLOT_GATEWAY_TOKEN: 'stale-gateway-token',
  };

  writeFileSync(path, 'FARMSLOT_NODE_TOKEN=first-file-token\n');
  assert.deepEqual(resolveGatewayCredential(launchedEnv, nested), { token: 'first-file-token' });

  writeFileSync(path, 'FARMSLOT_NODE_TOKEN=rotated-file-token\n');
  assert.deepEqual(resolveGatewayCredential(launchedEnv, nested), { token: 'rotated-file-token' });
});

test('deterministic auth rejections back off; transport errors do not', () => {
  // Post-ADR-051 node-subject rejection and outright auth failures cannot be
  // fixed by retrying faster.
  assert.equal(
    isDeterministicAuthRejection(
      'auth.connect with clientKind node requires a node-subject principal',
    ),
    true,
  );
  assert.equal(
    isDeterministicAuthRejection(
      'Gateway authentication failed: invalid credentials. Retry after 30s.',
    ),
    true,
  );
  // Transport-class failures keep the normal reconnect climb.
  assert.equal(isDeterministicAuthRejection('Gateway WebSocket is not open'), false);
  assert.equal(isDeterministicAuthRejection('read ECONNRESET'), false);
  assert.equal(isDeterministicAuthRejection('Internal gateway error'), false);
});
