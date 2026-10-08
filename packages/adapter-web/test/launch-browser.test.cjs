'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, afterEach, before, describe, it } = require('node:test');

const { cdpListenerPids } = require('../src/browser-cdp.cjs');
const {
  hasDetachedLaunchUnproven,
  runtimeIdentityPath,
  validationPortQuarantinePath,
} = require('../src/chrome-args.cjs');
const { extensionIdFromExtensionDir } = require('../src/extension-id.cjs');
const { homeTabsToClose, launchBrowser } = require('../src/launch-browser.cjs');
const { profileProcessPids } = require('../src/validation-process-ownership.cjs');

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
    const progress = [];
    const result = launchBrowser(
      options(dir, port, {
        homePage: 'home.html',
        progress: (update) => progress.push(update),
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
      // The caller's stage handle hears what the launch is waiting for.
      assert.deepEqual(progress[0], { message: 'starting the browser' });
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

  it('stops waiting for the CDP listener once the launched browser has exited', async () => {
    const dir = runtime('exited');
    const port = await freePort();
    process.env.FAKE_CDP_MODE = 'crash';
    const started = Date.now();
    try {
      assert.throws(
        () => launchBrowser(options(dir, port)),
        /did not expose an owned CDP listener on 127\.0\.0\.1:\d+: the browser exited\. Next: inspect /u,
      );
    } finally {
      delete process.env.FAKE_CDP_MODE;
    }
    // The full wait is 30 s; an exit is confirmed within about a second.
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
    assert.equal(fs.existsSync(path.join(dir, 'logs/chrome.pid')), false);
    // Ownership was never proven, so the launch stays quarantined.
    assert.equal(hasDetachedLaunchUnproven(path.join(dir, 'profile')), true);
  });

  it('refuses once a process it did not launch takes the port during the wait', async () => {
    const dir = runtime('foreign-late');
    const port = await freePort();
    let foreign = null;
    // A browser that never listens, and a foreign listener that binds the port
    // after the pre-launch ownership check. It exits with this test process.
    const startForeign = ({ message }) => {
      if (message !== 'starting the browser' || foreign) return;
      foreign = spawn(
        process.execPath,
        [
          '-e',
          `require('net').createServer().listen(${port}, '127.0.0.1');
           setInterval(() => { try { process.kill(${process.pid}, 0); } catch { process.exit(0); } }, 200);
           setTimeout(() => process.exit(0), 20000);`,
        ],
        { stdio: 'ignore' },
      );
    };
    process.env.FAKE_CDP_MODE = 'silent';
    const started = Date.now();
    try {
      assert.throws(
        () => launchBrowser(options(dir, port, { progress: startForeign })),
        (error) =>
          error.message.includes(`Refusing to launch on CDP port ${port}`) &&
          error.message.includes(`pid ${foreign.pid}`),
      );
      assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
      // The foreign listener is left alone; the browser this launch started is
      // stopped, and nothing stays quarantined, so a free port works next time.
      assert.deepEqual(cdpListenerPids(port), [foreign.pid]);
      assert.deepEqual(profileProcessPids(path.join(dir, 'profile')), []);
      assert.equal(hasDetachedLaunchUnproven(path.join(dir, 'profile')), false);
      assert.equal(fs.existsSync(validationPortQuarantinePath(port)), false);
    } finally {
      delete process.env.FAKE_CDP_MODE;
      foreign?.kill('SIGKILL');
    }
  });

  it('stops the browser it started when lsof fails during the wait', async () => {
    const dir = runtime('lsof-fails');
    const port = await freePort();
    // An lsof that answers the pre-launch check, then fails.
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'lsof'),
      `#!/bin/bash\n[ -e "${bin}/used" ] && exit 2\ntouch "${bin}/used"\nexec /usr/sbin/lsof "$@"\n`,
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    process.env.FAKE_CDP_MODE = 'silent';
    try {
      assert.throws(() => launchBrowser(options(dir, port)), /lsof could not inspect CDP port/u);
    } finally {
      process.env.PATH = savedPath;
      delete process.env.FAKE_CDP_MODE;
    }
    assert.deepEqual(profileProcessPids(path.join(dir, 'profile')), []);
    assert.equal(hasDetachedLaunchUnproven(path.join(dir, 'profile')), true);
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

  it('names the rerun command when the extension does not load over CDP, and stops the browser', async () => {
    const dir = runtime('cdp-load');
    const port = await freePort();
    // A resolver record for this binary that selects CDP loading (branded Chrome).
    const record = path.join(dir, 'resolver.json');
    fs.writeFileSync(
      record,
      JSON.stringify({ bin: chromeBin, browser: 'chrome', extensionLoading: 'cdp-load-unpacked' }),
    );
    process.env.FAKE_CDP_MODE = 'wrong-id';
    try {
      assert.throws(
        () =>
          launchBrowser(
            options(dir, port, { browserResolution: record, rerunCommand: 'host launch' }),
          ),
        /did not load over CDP[\s\S]*set RECIPE_HARNESS_BROWSER=cft to use Chrome for Testing, then rerun: host launch$/u,
      );
    } finally {
      delete process.env.FAKE_CDP_MODE;
    }
    assert.deepEqual(cdpListenerPids(port), []);
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
