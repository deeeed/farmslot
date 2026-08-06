import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveGatewayCredential } from './gateway-credential.js';

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
