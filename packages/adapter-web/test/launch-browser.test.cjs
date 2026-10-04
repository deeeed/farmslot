'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, afterEach, before, describe, it } = require('node:test');

const { cdpListenerPids } = require('../src/browser-cdp.cjs');
const { runtimeIdentityPath, validationPortQuarantinePath } = require('../src/chrome-args.cjs');
const { extensionIdFromExtensionDir } = require('../src/extension-id.cjs');
const { homeTabsToClose, launchBrowser } = require('../src/launch-browser.cjs');

const FAKE_BROWSER = path.join(__dirname, 'fixtures/fake-cdp-browser.cjs');

let root;
let chromeBin;
let extensionDir;
const ports = [];

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => {
        ports.push(port);
        resolve(port);
      });
    });
  });
}

function options(runtimeDir, port, extra = {}) {
  return {
    cdpPort: port,
    chromeBin,
    profile: path.join(runtimeDir, 'profile'),
    extensionDir,
    runtimeDir,
    chromeLog: path.join(runtimeDir, 'logs/chrome.log'),
    chromePid: path.join(runtimeDir, 'logs/chrome.pid'),
    focusSettleMs: 0,
    log: () => {},
    ...extra,
  };
}

function runtime(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-web-launch-')));
  // The fake browser serves CDP; this wrapper answers --version like Chrome.
  chromeBin = path.join(root, 'bin/chrome');
  fs.mkdirSync(path.dirname(chromeBin), { recursive: true });
  fs.writeFileSync(
    chromeBin,
    `#!/bin/bash\n[ "\${1:-}" = "--version" ] && { echo "Chromium 147.0.0.0"; exit 0; }\nprintf '%s\\n' "$*" >> "${root}/argv.log"\nexec "${process.execPath}" "${FAKE_BROWSER}" "$@"\n`,
    { mode: 0o755 },
  );
  extensionDir = path.join(root, 'ext/dist');
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(
    path.join(extensionDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'fixture',
      version: '1.0.0',
      key: 'Zml4dHVyZS1rZXk=',
    }),
  );
  // Keep the operator's frontmost app out of these tests.
  process.env.FARMSLOT_FOCUS_HOLD = '0';
});

afterEach(() => {
  for (const port of ports.splice(0))
    fs.rmSync(validationPortQuarantinePath(port), { force: true });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('homeTabsToClose', () => {
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const home = (id, title) => ({
    id,
    type: 'page',
    url: `chrome-extension://${extensionId}/home.html#x`,
    title,
  });

  it('keeps the slot-titled home tab and closes other homes and blank pages', () => {
    const targets = [
      home('h1', 'Product'),
      home('h2', 'slot-a — Product'),
      { id: 'b1', type: 'page', url: 'about:blank' },
      { id: 'n1', type: 'page', url: 'chrome://newtab/' },
      { id: 'o1', type: 'page', url: 'https://example.test/' },
      { id: 'w1', type: 'service_worker', url: `chrome-extension://${extensionId}/home.html` },
    ];
    const closed = homeTabsToClose(targets, {
      extensionId,
      homePage: 'home.html',
      defaultTitle: 'Product',
    });
    assert.deepEqual(
      closed.map((target) => target.id),
      ['h1', 'b1', 'n1'],
    );
  });

  it('keeps the first home tab when every title is the default', () => {
    const closed = homeTabsToClose([home('h1', 'Product'), home('h2', 'Product')], {
      extensionId,
      homePage: 'home.html',
      defaultTitle: 'Product',
    });
    assert.deepEqual(
      closed.map((target) => target.id),
      ['h2'],
    );
  });

  it('closes nothing when the extension has no home tab', () => {
    const targets = [{ id: 'b1', type: 'page', url: 'about:blank' }, home('h1', 'Product')];
    assert.deepEqual(homeTabsToClose(targets, { extensionId: 'other', homePage: 'home.html' }), []);
  });
});

describe('launchBrowser', () => {
  it('rejects invalid options before touching anything', async () => {
    const dir = runtime('invalid');
    const port = await freePort();
    assert.throws(() => launchBrowser({ ...options(dir, 0) }), /Invalid --cdp-port/u);
    assert.throws(
      () => launchBrowser({ ...options(dir, port), chromeBin: '' }),
      /Missing --chrome-bin/u,
    );
    assert.throws(
      () => launchBrowser({ ...options(dir, port), profile: os.homedir(), stopOnly: true }),
      /shared or default browser profile/u,
    );
    assert.equal(fs.existsSync(path.join(dir, 'logs')), false);
  });

  it('refuses to reset a profile outside the runtime dir', async () => {
    const dir = runtime('reset');
    const personal = path.join(root, 'personal');
    fs.mkdirSync(personal, { recursive: true });
    fs.writeFileSync(path.join(personal, 'sentinel'), 'keep');
    const port = await freePort();
    assert.throws(
      () =>
        launchBrowser({
          ...options(dir, port),
          profile: personal,
          stopOnly: true,
          resetProfile: true,
        }),
      /Refusing to reset --profile/u,
    );
    assert.equal(fs.readFileSync(path.join(personal, 'sentinel'), 'utf8'), 'keep');
  });

  it('launches an owned browser, records it, and holds the caller lock for the whole launch', async () => {
    const dir = runtime('launch');
    const port = await freePort();
    const lockEvents = [];
    const result = launchBrowser(
      options(dir, port, {
        homePage: 'home.html',
        acquireRuntimeLock: (runtimeDir) => {
          lockEvents.push(`acquire ${runtimeDir}`);
          // Released only after the launch has recorded its browser.
          return () =>
            lockEvents.push(
              `release pid-file=${fs.existsSync(path.join(runtimeDir, 'logs/chrome.pid'))} identity=${fs.existsSync(runtimeIdentityPath(runtimeDir))}`,
            );
        },
      }),
    );
    try {
      assert.equal(result.stopped, false);
      assert.deepEqual(lockEvents, [`acquire ${dir}`, 'release pid-file=true identity=true']);
      assert.equal(fs.readFileSync(path.join(dir, 'logs/chrome.pid'), 'utf8'), `${result.pid}\n`);
      assert.deepEqual(cdpListenerPids(port), [result.pid]);
      const resolution = JSON.parse(
        fs.readFileSync(path.join(dir, 'browser-resolution.json'), 'utf8'),
      );
      assert.equal(resolution.launch.pid, result.pid);
      assert.equal(resolution.launch.cdpPort, port);
      assert.equal(resolution.mode, 'explicit');
      assert.ok(fs.existsSync(runtimeIdentityPath(dir)));
      const argv = fs.readFileSync(path.join(root, 'argv.log'), 'utf8');
      assert.ok(argv.includes(`--user-data-dir=${path.join(dir, 'profile')}`));
      assert.ok(argv.includes(`--load-extension=${extensionDir}`));
      // Not a macOS .app bundle, so the home page is the first tab on the command line.
      assert.ok(
        argv.includes(`chrome-extension://${extensionIdFromExtensionDir(extensionDir)}/home.html`),
      );
    } finally {
      launchBrowser(options(dir, port, { stopOnly: true }));
    }
    assert.deepEqual(cdpListenerPids(port), []);
  });

  it('refuses a CDP port held by a process it did not launch, and releases the caller lock', async () => {
    const dir = runtime('foreign');
    const port = await freePort();
    const server = net.createServer();
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    let released = false;
    try {
      assert.throws(
        () =>
          launchBrowser(
            options(dir, port, {
              acquireRuntimeLock: () => () => {
                released = true;
              },
            }),
          ),
        (error) =>
          error.message.includes(`Refusing to launch on CDP port ${port}`) &&
          error.message.includes(`pid ${process.pid}`),
      );
      assert.equal(released, true);
    } finally {
      server.close();
    }
  });

  it('names the caller rerun command in failure hints, else a generic rerun', async () => {
    const dir = runtime('hint');
    const port = await freePort();
    // A directory where the runtime identity file goes makes invalidating it fail.
    fs.mkdirSync(path.join(runtimeIdentityPath(dir), 'blocker'), { recursive: true });
    assert.throws(
      () => launchBrowser(options(dir, port, { rerunCommand: 'host launch --build' })),
      /Failed to invalidate Extension runtime identity[\s\S]*then rerun: host launch --build$/u,
    );
    assert.throws(() => launchBrowser(options(dir, port)), /then rerun the launch$/u);
  });

  it('treats a browser loading an extension under the caller owner root as its own', async () => {
    const first = runtime('owner-a');
    const second = runtime('owner-b');
    const port = await freePort();
    const launched = launchBrowser(options(first, port));
    try {
      // Another profile on the same port: foreign unless the owner root proves it ours.
      assert.throws(
        () => launchBrowser(options(second, port, { stopOnly: true })),
        /Refusing to launch/u,
      );
      const result = launchBrowser(
        options(second, port, {
          stopOnly: true,
          extensionOwnerRoot: (dir) =>
            dir.startsWith(path.join(root, 'ext')) ? path.join(root, 'ext') : null,
        }),
      );
      assert.deepEqual(result, { stopped: true });
      assert.deepEqual(cdpListenerPids(port), []);
    } finally {
      if (cdpListenerPids(port).includes(launched.pid))
        launchBrowser(options(first, port, { stopOnly: true }));
    }
  });
});
