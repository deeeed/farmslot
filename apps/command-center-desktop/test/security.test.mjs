import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertTrustedSender, isAppPage, linkAction } from '../src/security.mjs';

const origin = 'http://127.0.0.1:49152';

test('IPC requires the app window main frame and exact app origin', () => {
  const mainFrame = { url: `${origin}/cc/#fleet` };
  const webContents = { mainFrame };
  const window = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: mainFrame };
  assert.doesNotThrow(() => assertTrustedSender(event, window, origin));
  assert.throws(() =>
    assertTrustedSender({ ...event, senderFrame: { url: mainFrame.url } }, window, origin),
  );
  assert.throws(() => assertTrustedSender({ ...event, sender: {} }, window, origin));
  mainFrame.url = 'http://127.0.0.1:49153/cc/';
  assert.throws(() => assertTrustedSender(event, window, origin));
  mainFrame.url = `${origin}/cc/assets/untrusted.html`;
  assert.throws(() => assertTrustedSender(event, window, origin));
  assert.equal(isAppPage(`${origin}/settings`, origin), true);
  assert.equal(isAppPage('not a url', origin), false);
});

test('only ordinary web links leave the app; gateway artifacts download inside it', () => {
  const connection = { url: 'wss://gateway.example/ws' };
  assert.equal(linkAction('https://example.com/path', origin, connection), 'external');
  assert.equal(
    linkAction('https://gateway.example/api/run-artifact?token=secret', origin, connection),
    'download',
  );
  assert.equal(linkAction(`blob:${origin}/example`, origin, connection), 'download');
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'farmslot://run',
    'https://user:pass@example.com',
    `${origin}/settings.js`,
    'blob:https://example.com/a',
  ]) {
    assert.equal(linkAction(url, origin, connection), 'deny', url);
  }
});

test('existing notifications and clipboard permissions require the app main frame', async () => {
  const { allowsPermission } = await import('../src/security.mjs');
  const contents = {};
  const window = { webContents: contents, isDestroyed: () => false };
  const details = { isMainFrame: true, requestingUrl: `${origin}/cc/` };
  for (const permission of ['notifications', 'clipboard-read', 'clipboard-sanitized-write']) {
    assert.equal(allowsPermission(window, contents, permission, details, origin), true);
    assert.equal(
      allowsPermission(window, contents, permission, { ...details, isMainFrame: false }, origin),
      false,
    );
    assert.equal(allowsPermission(window, {}, permission, details, origin), false);
    assert.equal(
      allowsPermission(
        window,
        contents,
        permission,
        { ...details, requestingUrl: 'https://attacker.example/cc/' },
        origin,
      ),
      false,
    );
  }
  assert.equal(allowsPermission(window, contents, 'media', details, origin), false);
});

test('preload navigation changes only a Command Center fragment', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const listeners = new Map();
  const location = { pathname: '/cc/', hash: '#fleet' };
  runInNewContext(readFileSync(new URL('../src/preload.cjs', import.meta.url), 'utf8'), {
    location,
    require: (name) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld() {} },
        ipcRenderer: { on: (channel, callback) => listeners.set(channel, callback) },
      };
    },
  });
  const navigate = listeners.get('desktop:navigate');
  navigate({}, '#runs?run=example');
  assert.equal(location.hash, '#runs?run=example');
  navigate({}, 'https://another.example');
  assert.equal(location.hash, '#runs?run=example');
  location.pathname = '/settings';
  navigate({}, '#slot/runner-1');
  assert.equal(location.hash, '#runs?run=example');
});
