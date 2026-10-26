import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { Principal } from '@farmslot/protocol';

import {
  changedNativeCatalogKeys,
  type NativeCatalogChange,
  nativeCatalogChanges,
  type NativeCatalogInterest,
} from '../resources/native-catalog-changes.js';
import { runWithSessionOriginator } from '../security/work-originator.js';

import { KNOWN_RUNNERS } from './registry.js';
import {
  describeVisibleModels,
  observeNativeCatalogPreferences,
  observeVisibleModelPreferences,
  readVisibleModelFile,
  visibleModelPreferenceChanges,
  visibleModelsHome,
  writeVisibleModelFile,
} from './visible-models.js';

const ownerA: Principal = {
  id: 'catalog-owner-a',
  subject: { type: 'person', displayName: 'A' },
  roles: [],
};
const ownerB: Principal = { ...ownerA, id: 'catalog-owner-b' };
const runner = Object.values(KNOWN_RUNNERS).find(
  (definition) => definition.nativeTransport && definition.nativeChoices,
)!.id;
const file = (model: string) => ({ version: 1 as const, byRunner: { [runner]: [model] } });
const interest = (ownerId: string, method = 'native.session.catalog'): NativeCatalogInterest => ({
  method,
  key: { family: 'native-session', scope: 'owner', ownerId },
  readerGeneration: 0,
});

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'native-catalog-models-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

function nextOwnerChange(
  ownerId: string,
  reason: 'updated' | 'failed' | 'recovered',
  changes = nativeCatalogChanges,
) {
  let stop: () => void = () => undefined;
  let timer!: ReturnType<typeof setTimeout>;
  const promise = new Promise<NativeCatalogChange>((resolve, reject) => {
    stop = changes.subscribe((change) => {
      if (change.scope !== 'owner' || change.ownerId !== ownerId || change.reason !== reason)
        return;
      clearTimeout(timer);
      stop();
      resolve(change);
    });
    timer = setTimeout(() => {
      stop();
      reject(new Error('Preference source notice did not arrive'));
    }, 750);
  });
  return {
    promise,
    cancel() {
      clearTimeout(timer);
      stop();
    },
  };
}

test('durable visible-model writer notifies only its actual reader-private catalog alias', (t) => {
  setup(t);
  const aliases: string[] = [];
  const stop = nativeCatalogChanges.subscribe((change) => {
    if (change.scope === 'owner' && change.ownerId === ownerA.id)
      assert.deepEqual(
        runWithSessionOriginator(ownerA, () => readVisibleModelFile()).byRunner,
        file('model-a').byRunner,
      );
    aliases.push(
      ...changedNativeCatalogKeys(change, [
        interest(ownerA.id),
        interest(ownerB.id),
        interest('list-only', 'native.session.list'),
      ]).map((key) => key.ownerId),
    );
  });
  t.after(stop);
  runWithSessionOriginator(ownerA, () => writeVisibleModelFile(file('model-a')));
  assert.deepEqual(aliases, [ownerA.id]);
  // Unchanged native projection, other runner updates and JSON shape differences stay quiet.
  runWithSessionOriginator(ownerA, () => {
    writeVisibleModelFile(file('model-a'));
    writeVisibleModelFile({
      ...file('model-a'),
      byRunner: { [runner]: ['model-a'], unrelated: ['other'] },
    });
  });
  assert.deepEqual(aliases, [ownerA.id]);
});

test('explicit customized homes retain ordinary read/write behavior without misattributing a catalog', (t) => {
  const root = setup(t);
  const home = join(root, 'custom-home');
  const notices: NativeCatalogChange[] = [];
  const stop = nativeCatalogChanges.subscribe((change) => notices.push(change));
  t.after(stop);
  runWithSessionOriginator(ownerA, () => writeVisibleModelFile(file('custom'), home));
  assert.deepEqual(readVisibleModelFile(home).byRunner, file('custom').byRunner);
  assert.deepEqual(notices, []);
});

test('shared owning watcher observes actual external replace/removal and explicit failure/recovery', async (t) => {
  setup(t);
  const home = runWithSessionOriginator(ownerA, () => visibleModelsHome());
  runWithSessionOriginator(ownerA, () => writeVisibleModelFile(file('initial')));
  const lease = runWithSessionOriginator(ownerA, () => observeNativeCatalogPreferences());
  t.after(() => lease.dispose());
  lease.sample();
  const path = join(home, 'runner-visible-models.json');

  let next = nextOwnerChange(ownerA.id, 'updated');
  try {
    writeFileSync(`${path}.external`, JSON.stringify(file('external')));
    renameSync(`${path}.external`, path);
    await next.promise;
  } finally {
    next.cancel();
  }
  assert.equal(lease.sample().ready, true);

  next = nextOwnerChange(ownerA.id, 'updated');
  try {
    unlinkSync(path);
    await next.promise;
  } finally {
    next.cancel();
  }
  assert.deepEqual(readVisibleModelFile(home), { version: 1, byRunner: {} });

  next = nextOwnerChange(ownerA.id, 'failed');
  try {
    mkdirSync(path); // Real filesystem read failure, not a mocked source receipt.
    await next.promise;
  } finally {
    next.cancel();
  }
  assert.throws(() => lease.sample(), { code: 'NATIVE_SOURCE_UNAVAILABLE' });

  next = nextOwnerChange(ownerA.id, 'recovered');
  try {
    rmSync(path, { recursive: true });
    writeFileSync(path, JSON.stringify(file('recovered')));
    await next.promise;
  } finally {
    next.cancel();
  }
  assert.equal(lease.sample().ready, true);
});

test('several observers share a source and last release closes it; writer/watch duplicate stays quiet', (t) => {
  setup(t);
  const first = runWithSessionOriginator(ownerA, () => observeNativeCatalogPreferences());
  const second = runWithSessionOriginator(ownerA, () => observeNativeCatalogPreferences());
  t.after(() => {
    first.dispose();
    second.dispose();
  });
  const before = first.sample();
  assert.equal(second.sample().incarnation, before.incarnation);
  const notices: NativeCatalogChange[] = [];
  const stop = nativeCatalogChanges.subscribe((change) => notices.push(change));
  t.after(stop);
  runWithSessionOriginator(ownerA, () => writeVisibleModelFile(file('one-commit')));
  const after = second.sample();
  second.sample();
  assert.equal(notices.length, 1);
  const preferencePath = runWithSessionOriginator(ownerA, () =>
    join(visibleModelsHome(), 'runner-visible-models.json'),
  );
  writeFileSync(preferencePath, JSON.stringify(file('one-commit'), null, 4));
  second.sample();
  writeFileSync(
    join(
      runWithSessionOriginator(ownerA, () => visibleModelsHome()),
      'unrelated.txt',
    ),
    'unrelated',
  );
  second.sample();
  assert.equal(notices.length, 1);
  assert.ok(after.revision > before.revision);
  first.dispose();
  assert.equal(second.sample().ready, true);
  second.dispose();
  assert.throws(() => second.sample(), { code: 'AUTH_FORBIDDEN' });
  const replacement = runWithSessionOriginator(ownerA, () => observeNativeCatalogPreferences());
  try {
    assert.notEqual(replacement.sample().incarnation, before.incarnation);
  } finally {
    replacement.dispose();
  }
});

test('alias selection is catalog-only, owner/generation-specific, and global pool notices reach catalogs', () => {
  const interests = [
    interest(ownerA.id),
    interest(ownerB.id),
    interest('only-list', 'native.session.list'),
  ];
  assert.deepEqual(
    changedNativeCatalogKeys(
      { scope: 'owner', ownerId: ownerA.id, ownerGeneration: 0, reason: 'updated' },
      interests,
    ),
    [interest(ownerA.id).key],
  );
  assert.deepEqual(
    changedNativeCatalogKeys(
      { scope: 'owner', ownerId: ownerA.id, ownerGeneration: 1, reason: 'updated' },
      interests,
    ),
    [],
  );
  assert.deepEqual(changedNativeCatalogKeys({ scope: 'all', reason: 'catalog' }, interests), [
    interest(ownerA.id).key,
    interest(ownerB.id).key,
  ]);
});

test('unexpected notification authorization errors propagate after the real file commit', (t) => {
  setup(t);
  const stop = nativeCatalogChanges.subscribe(() => {
    throw new Error('Unexpected authorization fault');
  });
  t.after(stop);
  assert.throws(
    () => runWithSessionOriginator(ownerA, () => writeVisibleModelFile(file('committed'))),
    /Unexpected authorization fault/,
  );
  const path = runWithSessionOriginator(ownerA, () =>
    join(visibleModelsHome(), 'runner-visible-models.json'),
  );
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), file('committed'));
});

test('full visible-model preferences notify non-native runner writes and external edits per owner generation', async (t) => {
  setup(t);
  const nonNative = Object.values(KNOWN_RUNNERS).find(
    (definition) => !definition.nativeTransport && definition.modelCatalog,
  )!.id;
  const preferences = (models: string[], defaultModel?: string) => ({
    version: 1 as const,
    byRunner: { [nonNative]: models },
    ...(defaultModel ? { defaults: { [nonNative]: defaultModel } } : {}),
  });
  const native: NativeCatalogChange[] = [];
  const visible: NativeCatalogChange[] = [];
  const stops = [
    nativeCatalogChanges.subscribe((change) => native.push(change)),
    visibleModelPreferenceChanges.subscribe((change) => visible.push(change)),
  ];
  t.after(() => stops.forEach((stop) => stop()));

  runWithSessionOriginator(ownerA, () =>
    writeVisibleModelFile(preferences(['anthropic/claude-opus-5'])),
  );
  runWithSessionOriginator({ ...ownerA, generation: 2 }, () =>
    writeVisibleModelFile(preferences(['anthropic/claude-opus-5', 'anthropic/claude-sonnet-5'])),
  );
  assert.deepEqual(native, []);
  assert.deepEqual(
    visible.map((change) => change.scope === 'owner' && [change.ownerId, change.ownerGeneration]),
    [
      [ownerA.id, 0],
      [ownerA.id, 2],
    ],
  );
  const home = runWithSessionOriginator(ownerA, () => visibleModelsHome());
  const retained = describeVisibleModels(nonNative, 'anthropic/claude-haiku-4-5', home);
  assert.equal(retained.retainedModel, 'anthropic/claude-haiku-4-5');

  const lease = runWithSessionOriginator(ownerA, () => observeVisibleModelPreferences());
  t.after(() => lease.dispose());
  lease.sample();
  const path = join(home, 'runner-visible-models.json');
  let next = nextOwnerChange(ownerA.id, 'updated', visibleModelPreferenceChanges);
  try {
    writeFileSync(`${path}.external`, JSON.stringify(preferences([], 'anthropic/claude-opus-5')));
    renameSync(`${path}.external`, path);
    await next.promise;
  } finally {
    next.cancel();
  }
  assert.deepEqual(native, []);
  assert.equal(
    describeVisibleModels(nonNative, undefined, home).defaultModel,
    'anthropic/claude-opus-5',
  );

  next = nextOwnerChange(ownerA.id, 'failed', visibleModelPreferenceChanges);
  try {
    writeFileSync(path, '{');
    await next.promise;
  } finally {
    next.cancel();
  }
  next = nextOwnerChange(ownerA.id, 'recovered', visibleModelPreferenceChanges);
  try {
    writeFileSync(path, JSON.stringify(preferences(['anthropic/claude-opus-5'])));
    await next.promise;
  } finally {
    next.cancel();
  }
  assert.equal(lease.sample().ready, true);
  assert.ok(visible.every((change) => change.scope === 'owner' && change.ownerId === ownerA.id));
  lease.dispose();
  assert.throws(() => lease.sample(), /Visible model preference connection ended/);
});
