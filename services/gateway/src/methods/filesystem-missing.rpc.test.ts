import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import type { FsReadResult } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const fixture = await import('../run-engine/run-recovery-fixture.js');
after(fixture.close);

test('authenticated file reads distinguish an uncaptured file from a refused path', async () => {
  const file = await fixture.rpc<FsReadResult>('fs.read', {
    slotId: fixture.slotId,
    path: 'worker.txt',
  });
  assert.equal(file.content, 'published work\n');
  await assert.rejects(
    fixture.rpc('fs.read', { slotId: fixture.slotId, path: 'artifacts/uncaptured-result.json' }),
    { code: 'FS_NOT_FOUND' },
  );
  await assert.rejects(
    fixture.rpc('fs.read', { slotId: fixture.slotId, path: '../outside' }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code !== 'FS_NOT_FOUND',
  );
});
