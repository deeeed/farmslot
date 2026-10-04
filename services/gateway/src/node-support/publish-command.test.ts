import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
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

test('node support verify accepts an intact bundle and rejects any drift', async (t) => {
  // Executed for real: the command is what stands between a half-written
  // bundle and a hook running from it.
  const { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, unlinkSync } =
    await import('node:fs');
  const { createHash } = await import('node:crypto');
  const os = await import('node:os');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'node-support-verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'manifest.json'), '{}');
  mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
  const contents: Record<string, [string, number]> = {
    'scripts/a.sh': ['echo a\n', 0o755],
    "scripts/lib/it's.mjs": ['export {}\n', 0o644],
  };
  const files = Object.entries(contents).map(([relativePath, [body, mode]]) => {
    writeFileSync(path.join(dir, relativePath), body);
    chmodSync(path.join(dir, relativePath), mode);
    return {
      relativePath,
      sha256: createHash('sha256').update(body).digest('hex'),
      mode,
      size: Buffer.byteLength(body),
    };
  });
  const verify = () =>
    spawnSync(
      'bash',
      [
        '-c',
        buildNodeSupportVerifyCommand({
          manifestPath: path.join(dir, 'manifest.json'),
          supportDir: dir,
          files,
        }),
      ],
      { encoding: 'utf8', timeout: 10_000 },
    ).status;

  assert.equal(verify(), 0, 'intact bundle verifies');
  chmodSync(path.join(dir, 'scripts/a.sh'), 0o644);
  assert.notEqual(verify(), 0, 'mode drift is caught');
  chmodSync(path.join(dir, 'scripts/a.sh'), 0o755);
  writeFileSync(path.join(dir, 'scripts/a.sh'), 'echo b\n');
  assert.notEqual(verify(), 0, 'content drift is caught');
  unlinkSync(path.join(dir, 'scripts/a.sh'));
  assert.notEqual(verify(), 0, 'a missing file is caught');
});
