import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildNodeSupportPublishCommand } from './publish-command.js';

const command = buildNodeSupportPublishCommand({
  incomingDir: '/tmp/farmslot-node/support/.incoming/hash.abc123',
  manifestPath: '~/farmslot-node/support/hash/manifest.json',
  supportDir: '~/farmslot-node/support/hash',
  supportHash: 'hash',
});

test('node support publish command is valid bash', () => {
  const result = spawnSync('bash', ['-n', '-c', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('node support publish command is valid zsh when available', () => {
  const result = spawnSync('zsh', ['-n', '-c', command], { encoding: 'utf8' });
  if (result.error && 'code' in result.error && result.error.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
});

test('node support publish command separates fi from cleanup', () => {
  assert.doesNotMatch(command, /\bfi rmdir\b/);
});
