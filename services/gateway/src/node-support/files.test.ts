import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectSupportFiles, supportHash } from './files.js';

test('collectSupportFiles preserves binary bytes and executable mode', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'farmslot-support-'));
  const scriptPath = path.join(dir, 'helper.sh');
  const binaryPath = path.join(dir, 'payload.bin');
  await writeFile(scriptPath, '#!/bin/sh\necho ok\n', { mode: 0o755 });
  await writeFile(binaryPath, Buffer.from([0, 255, 1, 254]));

  const files = await collectSupportFiles(dir, 'scripts');
  const script = files.find((file) => file.relativePath === 'scripts/helper.sh');
  const binary = files.find((file) => file.relativePath === 'scripts/payload.bin');

  assert.equal(script?.mode, 0o755);
  assert.equal(
    binary?.sha256,
    createHash('sha256')
      .update(Buffer.from([0, 255, 1, 254]))
      .digest('hex'),
  );
  assert.equal(
    Buffer.from(script?.contentBase64 ?? '', 'base64').toString(),
    '#!/bin/sh\necho ok\n',
  );
  assert.deepEqual([...Buffer.from(binary?.contentBase64 ?? '', 'base64')], [0, 255, 1, 254]);
});

test('supportHash includes executable mode', () => {
  const base = {
    relativePath: 'scripts/helper.sh',
    contentBase64: Buffer.from('#!/bin/sh\n').toString('base64'),
    size: 10,
  };

  assert.notEqual(supportHash([{ ...base, mode: 0o644 }]), supportHash([{ ...base, mode: 0o755 }]));
});
