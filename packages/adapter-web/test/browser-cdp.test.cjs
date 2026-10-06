'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it, mock } = require('node:test');

const { WebSocketServer } = require('ws');

const cdp = require('../src/browser-cdp.cjs');
const { assertMatch, contains, errorMatches, messageContains } = require('./fixtures/match.cjs');

const FAKE_BROWSER = path.join(__dirname, 'fixtures/fake-cdp-browser.cjs');
const WALLET_ID = 'hebhblbkkdabgoldnojllkipeoacjioc';
// Real lsof can take tens of seconds on a heavily loaded host.
const LSOF_BUDGET = 60000;

let root;
const cleanups = [];

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// A browser endpoint whose socket handler is supplied by the test.
async function fakeEndpoint(onMessage) {
  const server = http.createServer((req, res) => {
    res.end(
      JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/x`,
      }),
    );
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) =>
    socket.on('message', (raw) => onMessage(JSON.parse(String(raw)), socket)),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close();
        server.close(resolve);
      }),
  );
  return server.address().port;
}

async function startFakeBrowser(mode, profile, extraEnv = {}) {
  const port = await freePort();
  const log = path.join(root, `cdp-${mode}.log`);
  const child = spawn(
    process.execPath,
    [FAKE_BROWSER, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`],
    {
      env: {
        ...process.env,
        FAKE_CDP_MODE: mode,
        FAKE_CDP_LOG: log,
        ...extraEnv,
      },
      stdio: 'ignore',
    },
  );
  cleanups.push(() => child.kill('SIGKILL'));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return {
    port,
    child,
    log,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
  };
}

function unpackedDist() {
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  // Any base64 key; the expected id is derived from it.
  fs.writeFileSync(
    path.join(dist, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      key: Buffer.from('wallet-key').toString('base64'),
    }),
  );
  return dist;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-cdp-'));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('connectBrowserCdp', () => {
  it('fails pending commands as soon as the browser hangs up', async () => {
    const port = await fakeEndpoint((_message, socket) => socket.terminate());
    const client = await cdp.connectBrowserCdp(port, { timeoutMs: 3000 });
    const started = Date.now();
    await assert.rejects(client.send('Target.getTargets', {}), /socket closed/u);
    assert.ok(Date.now() - started < 2000);
    await assert.rejects(client.send('Target.getTargets', {}), /socket closed/u);
  });

  it('bounds every command with a deadline', async () => {
    const port = await fakeEndpoint(() => {});
    const client = await cdp.connectBrowserCdp(port, {
      timeoutMs: 3000,
      commandTimeoutMs: 200,
    });
    await assert.rejects(
      client.send('Target.getTargets', {}),
      errorMatches({ code: 'CDP_TIMEOUT' }),
    );
    await assert.rejects(
      client.send('Runtime.evaluate', {}, 'session', 100),
      messageContains('Runtime.evaluate did not answer within 100ms'),
    );
    client.close();
  });

  it('holds a stalled WebSocket handshake to the caller deadline', async () => {
    // Answers /json/version, then never completes the WebSocket upgrade.
    const server = http.createServer((req, res) => {
      res.end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/x`,
        }),
      );
    });
    const stalled = [];
    server.on('upgrade', (_req, socket) => stalled.push(socket));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          for (const socket of stalled) {
            socket.destroy();
          }
          server.closeAllConnections?.();
          server.close(resolve);
        }),
    );
    const started = Date.now();
    await assert.rejects(
      cdp.connectBrowserCdp(server.address().port, { timeoutMs: 100 }),
      errorMatches({ code: 'CDP_TIMEOUT' }),
    );
    assert.ok(Date.now() - started < 400);
  });

  it('gives up on a port with no browser', async () => {
    await assert.rejects(
      cdp.connectBrowserCdp(await freePort(), { timeoutMs: 500 }),
      /No browser CDP endpoint/u,
    );
  });

  it('delivers CDP events to onEvent subscribers until they unsubscribe', async () => {
    const port = await fakeEndpoint((message, socket) => {
      socket.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: {} } }));
      socket.send(
        JSON.stringify({ method: 'Network.requestWillBeSent', params: {}, sessionId: 'S1' }),
      );
      socket.send(JSON.stringify({ method: 'Inspector.detached' }));
      socket.send(JSON.stringify({ id: message.id, result: { ok: true } }));
    });
    const client = await cdp.connectBrowserCdp(port, { timeoutMs: 3000 });
    const events = [];
    const unsubscribe = client.onEvent((event) => events.push(event));
    assert.deepEqual(await client.send('Target.getTargets', {}), { ok: true });
    assert.deepEqual(events, [
      { method: 'Target.targetCreated', params: { targetInfo: {} } },
      { method: 'Network.requestWillBeSent', params: {}, sessionId: 'S1' },
      { method: 'Inspector.detached', params: {} },
    ]);
    unsubscribe();
    await client.send('Target.getTargets', {});
    assert.equal(events.length, 3);
    client.close();
  });

  it('calls onClose once when the browser hangs up, and on close()', async () => {
    const port = await fakeEndpoint((_message, socket) => socket.terminate());
    const client = await cdp.connectBrowserCdp(port, { timeoutMs: 3000 });
    let closes = 0;
    const closed = new Promise((resolve) =>
      client.onClose(() => {
        closes += 1;
        resolve();
      }),
    );
    await assert.rejects(client.send('Target.getTargets', {}), /socket closed/u);
    await closed;
    assert.equal(closes, 1);

    const quiet = await fakeEndpoint(() => {});
    const other = await cdp.connectBrowserCdp(quiet, { timeoutMs: 3000 });
    const ownClose = new Promise((resolve) => other.onClose(resolve));
    const unsubscribed = other.onClose(() => assert.fail('unsubscribed handler ran'));
    unsubscribed();
    other.close();
    await ownClose;
  });

  it('runs onClose at once on a closed client, and takes no event handler', async () => {
    const port = await fakeEndpoint((_message, socket) => socket.terminate());
    const client = await cdp.connectBrowserCdp(port, { timeoutMs: 3000 });
    const closed = new Promise((resolve) => client.onClose(resolve));
    await assert.rejects(client.send('Target.getTargets', {}), /socket closed/u);
    await closed;

    let lateCloses = 0;
    const offClose = client.onClose(() => {
      lateCloses += 1;
    });
    assert.equal(lateCloses, 1);
    offClose();
    const offEvent = client.onEvent(() => assert.fail('a closed client delivered an event'));
    assert.equal(typeof offEvent, 'function');
    offEvent();

    // Closed by the caller: the socket may not have reported its close yet.
    const quiet = await fakeEndpoint(() => {});
    const other = await cdp.connectBrowserCdp(quiet, { timeoutMs: 3000 });
    other.close();
    let ranAtOnce = false;
    other.onClose(() => {
      ranAtOnce = true;
    });
    assert.equal(ranAtOnce, true);
  });
});

describe('CDP target lists', () => {
  it('normalizes Target.getTargets and /json entries, and drops incomplete ones', () => {
    const target = { targetId: 'T1', type: 'page', url: 'chrome-extension://abc/home.html' };
    assert.deepEqual(cdp.asBrowserCdpTarget({ ...target, attached: true }), target);
    assert.deepEqual(cdp.asBrowserCdpTarget({ id: 'T1', type: 'page', url: target.url }), target);
    assert.equal(cdp.asBrowserCdpTarget({ id: 'T1', type: 'page' }), null);
    assert.equal(cdp.asBrowserCdpTarget(null), null);
    assert.equal(cdp.asBrowserCdpTarget([target]), null);
  });

  it('takes the extension id from the first extension target', () => {
    assert.equal(
      cdp.extensionIdFromCdpTargets([
        { targetId: 'P', type: 'page', url: 'https://example.com/' },
        { targetId: 'X', type: 'page', url: 'not a url' },
        { targetId: 'W', type: 'service_worker', url: 'chrome-extension://abc/sw.js' },
        { targetId: 'O', type: 'page', url: 'chrome-extension://def/home.html' },
      ]),
      'abc',
    );
    assert.equal(
      cdp.extensionIdFromCdpTargets([{ id: 'P', type: 'page', url: 'about:blank' }]),
      null,
    );
    assert.equal(cdp.extensionIdFromCdpTargets(undefined), null);
  });
});

describe('CDP port ownership', () => {
  const EARLIER = 'Mon Jan  5 10:00:00 2026';
  // `ps -o lstart` as the harness runs it (LC_ALL=C, TZ=UTC).
  const lstartUtc = (date) => {
    const [weekday, day, month, year, time] = date.toUTCString().replace(',', '').split(' ');
    return `${weekday} ${month} ${String(Number(day)).padStart(2, ' ')} ${time} ${year}`;
  };
  // lsof/ps stand-ins: listeners on the port, start times per pid, and the
  // profile files each pid holds open (default: its own profile, if given).
  const exec =
    ({ listeners = [], started = {}, open = {}, lsofMissing = false } = {}) =>
    (command, args) => {
      if (command === 'lsof') {
        if (lsofMissing) {
          throw Object.assign(new Error('spawn lsof ENOENT'), {
            code: 'ENOENT',
          });
        }
        if (args.includes('-p')) {
          return (open[args[args.indexOf('-p') + 1]] ?? []).map((file) => `n${file}`).join('\n');
        }
        if (listeners.length === 0) {
          throw Object.assign(new Error('none'), { status: 1 });
        }
        return listeners.join('\n');
      }
      return started[args.at(-1)] ?? '';
    };
  // A profile directory held by `pid`, like Chrome's process singleton.
  const heldProfile = (name, pid, { host = os.hostname() } = {}) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(`${host}-${pid}`, path.join(dir, 'SingletonLock'));
    return dir;
  };
  const inside = (dir) => [path.join(fs.realpathSync(dir), 'Default', 'History')];

  it('accepts only the process that holds this exact profile', () => {
    const profile = heldProfile('slot', 41);
    assert.deepStrictEqual(
      cdp.cdpOwner(9222, `${profile}/`, {
        exec: exec({
          listeners: ['41'],
          started: { 41: EARLIER },
          open: { 41: inside(profile) },
        }),
      }),
      {
        pid: 41,
        startedAt: EARLIER,
        profile: fs.realpathSync(profile),
        cdpPort: 9222,
      },
    );
    assert.throws(
      () =>
        cdp.cdpOwner(9222, profile, {
          exec: exec({ listeners: ['42'], started: { 42: 'x' } }),
        }),
      /held by pid 42, but the browser holding .* is pid 41/u,
    );
    assert.throws(
      () =>
        cdp.cdpOwner(9222, profile, {
          exec: exec({ listeners: ['41', '42'], started: { 41: 'x' } }),
        }),
      /refusing/u,
    );
    assert.throws(() => cdp.cdpOwner(9222, profile, { exec: exec({}) }), /No process listens/u);
  });

  it('refuses a browser whose profile only starts with, or extends, the slot profile', () => {
    const slot = path.join(root, 'slot');
    fs.mkdirSync(slot);
    heldProfile('slot foreign', 51);
    heldProfile('slot-other', 52);
    for (const pid of ['51', '52']) {
      assert.throws(
        () =>
          cdp.cdpOwner(9222, slot, {
            exec: exec({ listeners: [pid], started: { [pid]: 'x' } }),
          }),
        /No browser holds the profile .*slot \(no SingletonLock\)/u,
      );
    }
  });

  it('refuses a port whose owner changed after the check', () => {
    const profile = heldProfile('slot', 41);
    const owner = cdp.cdpOwner(9222, profile, {
      exec: exec({
        listeners: ['41'],
        started: { 41: EARLIER },
        open: { 41: inside(profile) },
      }),
    });
    assert.throws(
      () =>
        cdp.assertSameOwner(owner, {
          exec: exec({
            listeners: ['41'],
            started: { 41: 'Mon Jan  5 10:00:01 2026' },
            open: { 41: inside(profile) },
          }),
        }),
      /changed hands/u,
    );
  });

  it('refuses a stale SingletonLock whose pid now belongs to another process', () => {
    const profile = heldProfile('slot', 41);
    const lock = path.join(profile, 'SingletonLock');
    // The browser that wrote the lock died; pid 41 was reused an hour later.
    const written = new Date(Date.now() - 3600_000);
    fs.lutimesSync(lock, written, written);
    const reusedStart = lstartUtc(new Date(Date.now() - 60_000));
    assert.throws(
      () =>
        cdp.cdpOwner(9222, profile, {
          exec: exec({
            listeners: ['41'],
            started: { 41: reusedStart },
            open: { 41: inside(profile) },
          }),
        }),
      /started after the SingletonLock .* reused pid/u,
    );
    // Started early enough, but holds nothing inside the profile.
    assert.throws(
      () =>
        cdp.cdpOwner(9222, profile, {
          exec: exec({
            listeners: ['41'],
            started: { 41: EARLIER },
            open: { 41: [path.join(root, 'elsewhere', 'History')] },
          }),
        }),
      /has no file open in/u,
    );
    // A lock written on another machine (shared home directory).
    const remote = heldProfile('remote-slot', 41, { host: 'other-host' });
    assert.throws(
      () =>
        cdp.cdpOwner(9222, remote, {
          exec: exec({
            listeners: ['41'],
            started: { 41: EARLIER },
            open: { 41: inside(remote) },
          }),
        }),
      /names host other-host/u,
    );
  });

  it(
    'never loads into a live foreign browser that reuses the pid of a stale SingletonLock',
    { timeout: 150000 },
    async () => {
      const fake = await startFakeBrowser('ok', path.join(root, 'someone-else'));
      const slot = heldProfile('slot', fake.child.pid);
      const written = new Date(Date.now() - 3600_000);
      fs.lutimesSync(path.join(slot, 'SingletonLock'), written, written);
      await assert.rejects(
        cdp.loadUnpackedOverPort(fake.port, unpackedDist(), {
          profile: slot,
          timeoutMs: LSOF_BUDGET,
        }),
        /reused pid/u,
      );
      // Lock written after the foreign browser started: still not the profile's holder.
      fs.lutimesSync(path.join(slot, 'SingletonLock'), new Date(), new Date());
      await assert.rejects(
        cdp.loadUnpackedOverPort(fake.port, unpackedDist(), {
          profile: slot,
          timeoutMs: LSOF_BUDGET,
        }),
        /has no file open in/u,
      );
      assert.ok(!fake.calls().includes('Extensions.loadUnpacked'));
    },
  );

  it('waits for a settling browser only within its budget, and refuses a foreign one at once', () => {
    const profile = heldProfile('slot', 41);
    let started = Date.now();
    // Nothing listens yet: settling, retried until the budget is spent.
    assert.throws(
      () => cdp.waitForCdpOwner(9222, profile, { timeoutMs: 500, exec: exec({}) }),
      /No process listens|did not prove/u,
    );
    assert.ok(Date.now() - started < 1500);
    // Another process holds the port: refused without waiting.
    started = Date.now();
    assert.throws(
      () =>
        cdp.waitForCdpOwner(9222, profile, {
          timeoutMs: 10000,
          exec: exec({ listeners: ['42'] }),
        }),
      /held by pid 42/u,
    );
    assert.ok(Date.now() - started < 1000);
    // Becomes ready on the third attempt.
    let attempts = 0;
    const settlingThenReady = (command, args) => {
      if (command === 'lsof' && !args.includes('-p')) {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error('none'), { status: 1 });
        }
        return '41';
      }
      return exec({
        listeners: ['41'],
        started: { 41: EARLIER },
        open: { 41: inside(profile) },
      })(command, args);
    };
    assertMatch(
      cdp.waitForCdpOwner(9222, profile, {
        timeoutMs: 5000,
        exec: settlingThenReady,
      }),
      { pid: 41 },
    );
  });

  it('bounds the ownership subprocesses by the caller budget', () => {
    const profile = heldProfile('slot', 41);
    const budgets = [];
    // lsof that runs until its timeout kills it, like a heavily loaded host.
    const slowLsof = (command, args, { timeoutMs }) => {
      budgets.push(timeoutMs);
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        /* busy */
      }
      throw Object.assign(new Error('killed'), { signal: 'SIGTERM' });
    };
    const started = Date.now();
    assert.throws(
      () => cdp.cdpOwner(9222, profile, { exec: slowLsof, timeoutMs: 300 }),
      /ran out of its time budget/u,
    );
    assert.ok(Date.now() - started < 1000);
    assert.equal(
      budgets.every((ms) => ms <= 300),
      true,
    );
  });

  it('fails clearly when lsof is missing instead of reading the port as free', () => {
    assert.throws(
      () => cdp.cdpListenerPids(9222, exec({ lsofMissing: true })),
      /lsof is required/u,
    );
  });

  it(
    'never loads into a browser swapped in after the ownership check',
    { timeout: 150000 },
    async () => {
      const calls = [];
      const port = await fakeEndpoint((message, socket) => {
        calls.push(message.method);
        socket.send(JSON.stringify({ id: message.id, result: {} }));
      });
      const profile = heldProfile('slot', 41);
      let checks = 0;
      const swapping = (command, args) => {
        if (command === 'lsof') {
          return args.includes('-p') ? `n${inside(profile)[0]}` : '41';
        }
        checks += 1;
        return checks === 1 ? EARLIER : 'Mon Jan  5 10:00:01 2026';
      };
      await assert.rejects(
        cdp.loadUnpackedOverPort(port, unpackedDist(), {
          profile,
          exec: swapping,
          timeoutMs: 5000,
        }),
        /changed hands/u,
      );
      assert.ok(!calls.includes('Extensions.loadUnpacked'));
    },
  );
});

describe('loadUnpackedExtension', () => {
  const dist = '/dist/chrome';

  it('retries loadUnpacked within its deadline and waits for the extension worker', async () => {
    let loads = 0;
    let polls = 0;
    const send = mock.fn(async (method) => {
      if (method === 'Extensions.loadUnpacked') {
        loads += 1;
        if (loads === 1) {
          throw new Error('Method not available yet');
        }
        return { id: WALLET_ID };
      }
      polls += 1;
      return {
        targetInfos:
          polls < 2
            ? []
            : [
                {
                  type: 'service_worker',
                  url: `chrome-extension://${WALLET_ID}/service-worker.js`,
                },
              ],
      };
    });
    assert.deepStrictEqual(
      await cdp.loadUnpackedExtension(send, dist, {
        expectedId: WALLET_ID,
        timeoutMs: 10000,
      }),
      { id: WALLET_ID },
    );
    const loadCall = send.mock.calls.find(
      (call) => call.arguments[0] === 'Extensions.loadUnpacked',
    );
    assert.ok(loadCall);
    assert.equal(loadCall.arguments.length, 4);
    assert.deepStrictEqual(loadCall.arguments.slice(0, 3), [
      'Extensions.loadUnpacked',
      { path: dist },
      undefined,
    ]);
    assert.equal(typeof loadCall.arguments[3], 'number');
    assert.equal(loads, 2);
  });

  it('rejects an id that does not match the manifest key', async () => {
    const send = mock.fn(async () => ({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }));
    await assert.rejects(
      cdp.loadUnpackedExtension(send, dist, {
        expectedId: WALLET_ID,
        timeoutMs: 2000,
      }),
      messageContains('manifest key gives'),
    );
  });

  it('derives the expected id from the manifest key with the shared helper', () => {
    const extensionIds = require('../src/extension-id.cjs');
    const dir = unpackedDist();
    assert.equal(cdp.expectedExtensionId(dir), extensionIds.extensionIdFromExtensionDir(dir));
  });
});

describe('loadUnpackedOverPort', () => {
  it(
    'refuses a CDP port held by a browser with another profile, before any command',
    { timeout: 150000 },
    async () => {
      const fake = await startFakeBrowser('ok', path.join(root, 'someone-else'));
      await assert.rejects(
        cdp.loadUnpackedOverPort(fake.port, unpackedDist(), {
          profile: path.join(root, 'slot-profile'),
          timeoutMs: LSOF_BUDGET,
        }),
        /No browser holds the profile .*slot-profile/u,
      );
      assert.equal(fake.calls(), '');
    },
  );

  it(
    'loads into the owned browser, audits extensions and opens the start page',
    { timeout: 150000 },
    async () => {
      const profile = path.join(root, 'slot-profile');
      const dist = unpackedDist();
      const id = cdp.expectedExtensionId(dist);
      const fake = await startFakeBrowser('ok', profile, {
        FAKE_CDP_EXTENSION_ID: id,
      });
      assertMatch(
        await cdp.loadUnpackedOverPort(fake.port, dist, {
          profile,
          url: `chrome-extension://${id}/home.html`,
          timeoutMs: LSOF_BUDGET,
        }),
        {
          id,
          otherExtensions: { disabled: [], policyPinned: [] },
          owner: { pid: fake.child.pid },
        },
      );
      const calls = fake.calls();
      assert.ok(calls.includes(`Extensions.loadUnpacked {"path":"${dist}"}`));
      // Isolation (a background tab) runs before the start page is navigated.
      assert.ok(
        calls.includes('Target.createTarget {"url":"chrome://extensions/","background":true}'),
      );
      assert.ok(calls.includes(`Page.navigate {"url":"chrome-extension://${id}/home.html"}`));
      assert.ok(calls.indexOf('Target.createTarget') < calls.indexOf('Page.navigate'));
    },
  );

  it(
    'disables other user extensions in the slot profile and records policy-pinned ones',
    { timeout: 150000 },
    async () => {
      const profile = path.join(root, 'slot-profile');
      const dist = unpackedDist();
      const id = cdp.expectedExtensionId(dist);
      const sideloaded = await startFakeBrowser('foreign', profile, {
        FAKE_CDP_EXTENSION_ID: id,
      });
      assertMatch(
        await cdp.loadUnpackedOverPort(sideloaded.port, dist, {
          profile,
          timeoutMs: LSOF_BUDGET,
        }),
        {
          id,
          otherExtensions: {
            disabled: [
              {
                id: 'cjpalhdlnbpafiamejdnhcphjbkeiagm',
                name: 'Sideloaded',
                location: 'THIRD_PARTY',
              },
            ],
            policyPinned: [],
          },
        },
      );
      sideloaded.child.kill('SIGKILL');

      const pinned = await startFakeBrowser('policy', path.join(root, 'slot-profile-2'), {
        FAKE_CDP_EXTENSION_ID: id,
      });
      assertMatch(
        await cdp.loadUnpackedOverPort(pinned.port, dist, {
          profile: path.join(root, 'slot-profile-2'),
          timeoutMs: LSOF_BUDGET,
        }),
        {
          otherExtensions: {
            disabled: [],
            policyPinned: [
              {
                id: 'glnpjglilkicbckjpbgcfkogebgllemb',
                name: 'Okta Browser Plugin',
              },
            ],
          },
        },
      );
    },
  );

  it(
    'in a browser without a window: opens a blank background window, isolates, then navigates',
    { timeout: 150000 },
    async () => {
      const profile = path.join(root, 'slot-profile');
      const dist = unpackedDist();
      const id = cdp.expectedExtensionId(dist);
      const fake = await startFakeBrowser('foreign', profile, {
        FAKE_CDP_EXTENSION_ID: id,
        FAKE_CDP_WINDOWLESS: '1',
      });
      assertMatch(
        await cdp.loadUnpackedOverPort(fake.port, dist, {
          profile,
          url: 'https://dapp.example/',
          timeoutMs: LSOF_BUDGET,
        }),
        {
          id,
          otherExtensions: {
            disabled: [{ id: 'cjpalhdlnbpafiamejdnhcphjbkeiagm' }],
          },
        },
      );
      const calls = fake.calls().split('\n');
      const at = (prefix) => calls.findIndex((line) => line.startsWith(prefix));
      const firstWindow = at(
        'Target.createTarget {"url":"about:blank","newWindow":true,"background":true}',
      );
      const isolationTab = at(
        'Target.createTarget {"url":"chrome://extensions/","background":true}',
      );
      const disabled = at('Runtime.callFunctionOn');
      const navigated = at('Page.navigate {"url":"https://dapp.example/"}');
      assert.equal(
        [firstWindow, isolationTab, disabled, navigated].every((index) => index >= 0),
        true,
      );
      // The dapp loads only after the sideloaded extension was disabled.
      assert.ok(firstWindow < isolationTab);
      assert.ok(disabled < navigated);
    },
  );

  it(
    'fails the load when a browser without a window cannot open one',
    { timeout: 150000 },
    async () => {
      const profile = path.join(root, 'slot-profile');
      const dist = unpackedDist();
      const fake = await startFakeBrowser('ok', profile, {
        FAKE_CDP_EXTENSION_ID: cdp.expectedExtensionId(dist),
        FAKE_CDP_WINDOWLESS: '1',
        FAKE_CDP_REJECT_WINDOW: '1',
      });
      await assert.rejects(
        cdp.loadUnpackedOverPort(fake.port, dist, {
          profile,
          url: 'https://dapp.example/',
          timeoutMs: LSOF_BUDGET,
        }),
        /Failed to open a new window/u,
      );
      assert.ok(!fake.calls().includes('Page.navigate'));
    },
  );

  it('fails when another user extension stays enabled', { timeout: 150000 }, async () => {
    const profile = path.join(root, 'slot-profile');
    const dist = unpackedDist();
    const fake = await startFakeBrowser('stuck', profile, {
      FAKE_CDP_EXTENSION_ID: cdp.expectedExtensionId(dist),
    });
    await assert.rejects(
      cdp.loadUnpackedOverPort(fake.port, dist, {
        profile,
        timeoutMs: LSOF_BUDGET,
      }),
      /keeps user extensions besides the loaded extension enabled: cjpalhdlnbpafiamejdnhcphjbkeiagm \(Sideloaded, THIRD_PARTY\)/u,
    );
  });

  it('holds the whole load to one deadline', { timeout: 150000 }, async () => {
    const profile = path.join(root, 'slot-profile');
    const dist = unpackedDist();
    // The fake never answers Runtime.evaluate, so isolation stalls: whatever
    // step the budget runs out in, the load fails at the budget, not later.
    const fake = await startFakeBrowser('noframes', profile, {
      FAKE_CDP_EXTENSION_ID: cdp.expectedExtensionId(dist),
    });
    const started = Date.now();
    await assert.rejects(
      cdp.loadUnpackedOverPort(fake.port, dist, { profile, timeoutMs: 3000 }),
      errorMatches({ code: 'CDP_TIMEOUT' }),
    );
    assert.ok(Date.now() - started < 3000 + 2000);
  });

  it(
    'fails a stalled WebSocket handshake within the load budget, naming the step',
    { timeout: 150000 },
    async () => {
      const server = http.createServer((req, res) => {
        res.end(
          JSON.stringify({
            webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/x`,
          }),
        );
      });
      const stalled = [];
      server.on('upgrade', (_req, socket) => stalled.push(socket));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      cleanups.push(
        () =>
          new Promise((resolve) => {
            for (const socket of stalled) {
              socket.destroy();
            }
            server.closeAllConnections?.();
            server.close(resolve);
          }),
      );
      const profile = path.join(root, 'slot');
      fs.mkdirSync(profile);
      fs.symlinkSync(`${os.hostname()}-41`, path.join(profile, 'SingletonLock'));
      const owned = (command, args) => {
        if (command === 'lsof') {
          return args.includes('-p') ? `n${fs.realpathSync(profile)}/Local State` : '41';
        }
        return 'Mon Jan  5 10:00:00 2026';
      };
      const started = Date.now();
      await assert.rejects(
        cdp.loadUnpackedOverPort(server.address().port, unpackedDist(), {
          profile,
          exec: owned,
          timeoutMs: 300,
        }),
        errorMatches({ code: 'CDP_TIMEOUT', message: contains('connecting') }),
      );
      assert.ok(Date.now() - started < 800);
    },
  );

  it('requires the owning profile', { timeout: 150000 }, async () => {
    await assert.rejects(
      cdp.loadUnpackedOverPort(9, unpackedDist(), {}),
      /requires the slot profile/u,
    );
  });
});

describe('placeWindow', () => {
  it('restores the window, then moves it', async () => {
    const calls = [];
    const send = async (method, params) => {
      calls.push([method, params]);
      return method === 'Browser.getWindowForTarget' ? { windowId: 7 } : {};
    };
    const bounds = { left: 200, top: 150, width: 1200, height: 800 };
    assert.equal(await cdp.placeWindow(send, 'T1', bounds), 7);
    assert.deepEqual(calls, [
      ['Browser.getWindowForTarget', { targetId: 'T1' }],
      ['Browser.setWindowBounds', { windowId: 7, bounds: { windowState: 'normal' } }],
      ['Browser.setWindowBounds', { windowId: 7, bounds }],
    ]);
  });
});
