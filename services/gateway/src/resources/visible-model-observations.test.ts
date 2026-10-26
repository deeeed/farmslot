import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Principal } from '@farmslot/protocol';
import type { ResourceKey } from '@farmslot/protocol/client-cache';

import { visibleModelsHome, writeVisibleModelFile } from '../runners/visible-models.js';
import { runWithSessionOriginator } from '../security/work-originator.js';

import { GatewayNativeObservations } from './native-observations.js';

const reader: Principal = {
  id: 'visible-model-reader',
  subject: { type: 'person', displayName: 'Reader' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};
const other: Principal = { ...reader, id: 'visible-model-other' };
const preferences = (model: string) => ({ version: 1 as const, byRunner: { pi: [model] } });

async function until(condition: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Visible-model notice did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('visible-model readers get generation-scoped owner profile keys from writers and external edits', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'visible-model-observations-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = root;
  const published: ResourceKey[] = [];
  const source = new GatewayNativeObservations((key) => published.push(key));
  const connection = {};
  t.after(() => {
    source.dispose();
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const ownerKey = { family: 'profiles', scope: 'owner', ownerId: reader.id };
  source.attachClient(connection, () => reader);
  runWithSessionOriginator(reader, () => writeVisibleModelFile(preferences('before-reader')));
  assert.deepEqual(published, []);

  // Arming the shared source is its first observation; a second read reuses that lease.
  source.observeVisibleModels(connection, reader);
  source.observeVisibleModels(connection, reader);
  assert.deepEqual(published, [ownerKey]);
  runWithSessionOriginator(reader, () => writeVisibleModelFile(preferences('writer')));
  assert.deepEqual(published, [ownerKey, ownerKey]);
  // A reused principal ID at another generation and another principal stay private.
  runWithSessionOriginator({ ...reader, generation: 1 }, () =>
    writeVisibleModelFile(preferences('other-generation')),
  );
  runWithSessionOriginator(other, () => writeVisibleModelFile(preferences('other-owner')));
  assert.deepEqual(published, [ownerKey, ownerKey]);

  const path = join(
    runWithSessionOriginator(reader, () => visibleModelsHome()),
    'runner-visible-models.json',
  );
  writeFileSync(`${path}.external`, JSON.stringify(preferences('external')));
  renameSync(`${path}.external`, path);
  await until(() => published.length === 3);
  assert.deepEqual(published[2], ownerKey);

  // Disconnect releases the lease; later edits publish nothing for this owner.
  source.detachClient(connection);
  writeFileSync(path, JSON.stringify(preferences('after-disconnect')));
  await new Promise((resolve) => setTimeout(resolve, 200));
  runWithSessionOriginator(reader, () => writeVisibleModelFile(preferences('writer-after')));
  assert.equal(published.length, 3);
});
