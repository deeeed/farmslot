import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildNodeSupportPublishCommand,
  buildNodeSupportVerifyCommand,
} from './publish-command.js';

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

test('node support publish command cannot hang on a stale or held lock', () => {
  // Reclaims a lock abandoned by a dead prepare...
  assert.match(command, /-mmin \+5/);
  // ...and bails loudly instead of looping forever on a live one.
  assert.match(command, /node support lock timeout/);
  assert.match(command, /-gt 600/);
});

test('node support verify command is valid bash', () => {
  const verifyCommand = buildNodeSupportVerifyCommand({
    manifestPath: '~/farmslot-node/support/hash/manifest.json',
    supportDir: '~/farmslot-node/support/hash',
    files: [
      {
        relativePath: 'scripts/helper.sh',
        sha256: 'a'.repeat(64),
        mode: 0o755,
        size: 12,
      },
    ],
  });
  const result = spawnSync('bash', ['-n', '-c', verifyCommand], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
