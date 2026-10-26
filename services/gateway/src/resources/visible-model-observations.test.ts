import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
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

// Real fs watchers: waits end on the actual event. The ceiling only reports a hang.
const HANG_GUARD_MS = 20_000;

/** macOS arms fs.watch asynchronously. Repeat a distinct real change until it is reported. */
async function untilReported(reported: () => boolean, change: (attempt: number) => void) {
  const deadline = Date.now() + HANG_GUARD_MS;
  for (let attempt = 0; !reported(); attempt++) {
    if (Date.now() > deadline) throw new Error('The real watcher never reported a change');
    change(attempt);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function untilPublished(published: readonly ResourceKey[], length: number): Promise<void> {
  const deadline = Date.now() + HANG_GUARD_MS;
  while (published.length < length) {
    if (Date.now() > deadline) throw new Error('Visible-model notice hung');
    await new Promise((resolve) => setImmediate(resolve));
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

  const home = runWithSessionOriginator(reader, () => visibleModelsHome());
  const path = join(home, 'runner-visible-models.json');
  const replace = (model: string) => {
    writeFileSync(`${path}.external`, JSON.stringify(preferences(model)));
    renameSync(`${path}.external`, path);
  };
  // Nothing else samples the lease from here, so each later key comes from the real watcher.
  await untilReported(
    () => published.length > 2,
    (attempt) => replace(`warm-${attempt}`),
  );
  const armed = published.length;
  replace('external');
  await untilPublished(published, armed + 1);
  assert.deepEqual(published.slice(2), Array(armed - 1).fill(ownerKey));

  // Disconnect releases the lease. A live barrier watcher on the same directory proves the
  // edit and later events reached this process without publishing the owner key.
  source.detachClient(connection);
  const seen = new Set<string>();
  const barrier = watch(home, (_event, name) => seen.add(String(name)));
  t.after(() => barrier.close());
  const marker = (name: string) =>
    untilReported(
      () => seen.has(name),
      (attempt) => writeFileSync(join(home, name), String(attempt)),
    );
  await marker('barrier-armed');
  const quiet = published.length;
  replace('after-disconnect');
  await marker('barrier-after-change');
  await new Promise((resolve) => setImmediate(resolve));
  runWithSessionOriginator(reader, () => writeVisibleModelFile(preferences('writer-after')));
  assert.equal(published.length, quiet);
});
