import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPreferencesStore } from '../src/preferences.mjs';
import { desktopProfile } from '../src/profile.mjs';
import { assertTrustedSender, isAppPage, linkAction } from '../src/security.mjs';
import { validateDevelopmentSource, validateDevelopmentUrl } from '../src/ui-source.mjs';

test('only explicit loopback UI documents can receive desktop credentials', () => {
  for (const url of ['http://localhost:5175/', 'http://127.0.0.1:5174/cc/', 'http://[::1]:5174/'])
    assert.equal(validateDevelopmentUrl(url), url);
  for (const url of [
    'https://example.com/',
    'file:///tmp/index.html',
    'http://localhost.evil/',
    'http://user:secret@localhost:5174/',
    'http://localhost:5174/?token=x',
    'http://localhost:5174/#fleet',
    'http://localhost:5174/other',
  ])
    assert.throws(() => validateDevelopmentUrl(url), undefined, url);
  assert.throws(() => validateDevelopmentSource({ enabled: 'true' }));
  const origin = 'http://127.0.0.1:49100';
  const dev = 'http://localhost:5175/';
  const mainFrame = { url: `${dev}#fleet` };
  const webContents = { mainFrame };
  const window = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: mainFrame };
  assert.doesNotThrow(() => assertTrustedSender(event, window, origin, dev));
  assert.throws(() => assertTrustedSender(event, window, origin));
  assert.throws(() =>
    assertTrustedSender({ ...event, senderFrame: { ...mainFrame } }, window, origin, dev),
  );
  for (const url of ['http://localhost:5176/', `${dev}settings`, `${origin}/cc/`])
    assert.equal(isAppPage(url, origin, dev), false, url);
  assert.equal(isAppPage(`${origin}/settings`, origin, dev), true);
  assert.equal(linkAction('blob:http://localhost:5175/id', origin, null, dev), 'download');
  assert.equal(linkAction('blob:http://localhost:5176/id', origin, null, dev), 'deny');
});

test('profiles isolate identity and remember the source when falling back to bundled UI', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'farmslot-dev-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const prod = desktopProfile();
  const dev = desktopProfile('development');
  for (const key of ['name', 'scheme', 'icon']) assert.notEqual(prod[key], dev[key]);
  assert.throws(() => desktopProfile('invalid'));
  assert.equal(createPreferencesStore(directory).load().development.enabled, false);
  const store = createPreferencesStore(directory, true);
  assert.equal(store.load().development.enabled, true);
  store.save({ ...store.load(), development: { enabled: false, url: 'http://localhost:5175/' } });
  assert.deepEqual(createPreferencesStore(directory, true).load().development, {
    enabled: false,
    url: 'http://localhost:5175/',
  });
});
