'use strict';

const assert = require('node:assert/strict');
const { execFile, execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it, mock } = require('node:test');

const { assertMatch, contains, messageContains } = require('./fixtures/match.cjs');

const resolver = require('../src/browser-resolver.cjs');

const FAKE_BROWSER = path.join(__dirname, 'fixtures/fake-cdp-browser.cjs');

let root;
const savedEnv = { ...process.env };

function fakeApp(name, bundleId, version) {
  const app = path.join(root, `${name}.app`);
  const executable = path.join(app, 'Contents/MacOS', name);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writePlist(app, bundleId, version);
  return executable;
}

function writePlist(app, bundleId, version) {
  fs.writeFileSync(
    path.join(app, 'Contents/Info.plist'),
    `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict></plist>
`,
  );
}

function crash() {
  return mock.fn(async () => ({
    ok: false,
    reason: 'exited during startup (SIGBUS)',
    transient: false,
    durationMs: 5,
  }));
}

// A mock that resolves each given value once, in order (vi.fn().mockResolvedValueOnce).
function resolvesInSequence(...values) {
  const fn = mock.fn();
  values.forEach((value, index) => fn.mock.mockImplementationOnce(async () => value, index));
  return fn;
}

function apps() {
  return {
    cft: fakeApp('Google Chrome for Testing', 'com.google.chrome.for.testing', '147.0.7727.15'),
    chrome: fakeApp('Google Chrome', 'com.google.Chrome', '154.0.8037.92'),
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-resolver-'));
  // Keep the host's own managed-Chrome policy out of the resolution under test.
  process.env.RECIPE_HARNESS_MANAGED_CHROME_PLISTS = '';
});

afterEach(() => {
  process.env = { ...savedEnv };
  fs.rmSync(root, { recursive: true, force: true });
});

describe('browser resolver', () => {
  it('falls back to branded Chrome over CDP when Chrome for Testing crashes at launch, and caches the crash', async () => {
    const { cft, chrome } = apps();
    const cachePath = path.join(root, 'cache.json');
    const probe = crash();
    const options = {
      env: {},
      cft: () => ({ executable: cft }),
      probe,
      cachePath,
      chromeCandidates: [chrome],
    };

    const first = await resolver.resolveBrowser(options);
    assertMatch(first, {
      bin: chrome,
      browser: 'google-chrome',
      version: '154.0.8037.92',
      extensionLoading: 'cdp-load-unpacked',
      source: 'auto',
      mode: 'auto',
      probe: {
        bin: cft,
        version: '147.0.7727.15',
        ok: false,
        transient: false,
        cached: false,
      },
    });
    assert.ok(first.fallbackReason.includes('SIGBUS'));

    const second = await resolver.resolveBrowser(options);
    assertMatch(second, { bin: chrome, probe: { cached: true } });
    assert.equal(probe.mock.calls.length, 1);
  });

  it('keeps Chrome for Testing with --load-extension where it launches', async () => {
    const { cft, chrome } = apps();
    const probe = mock.fn(async () => ({
      ok: true,
      reason: 'started and rendered',
      transient: false,
    }));
    const resolution = await resolver.resolveBrowser({
      env: {},
      cft: () => ({ executable: cft }),
      probe,
      cachePath: path.join(root, 'cache.json'),
      chromeCandidates: [chrome],
    });
    assertMatch(resolution, {
      bin: cft,
      browser: 'chrome-for-testing',
      extensionLoading: 'load-extension',
      probe: { ok: true },
    });
  });

  it('re-probes when the Chrome for Testing version changes', async () => {
    const { cft, chrome } = apps();
    const probe = resolvesInSequence(
      {
        ok: false,
        reason: 'exited during startup (SIGBUS)',
        transient: false,
      },
      { ok: true, reason: 'started and rendered', transient: false },
    );
    const options = {
      env: {},
      cft: () => ({ executable: cft }),
      probe,
      cachePath: path.join(root, 'cache.json'),
      chromeCandidates: [chrome],
    };

    assert.equal((await resolver.resolveBrowser(options)).bin, chrome);
    writePlist(
      path.join(root, 'Google Chrome for Testing.app'),
      'com.google.chrome.for.testing',
      '154.0.8037.92',
    );
    const updated = await resolver.resolveBrowser(options);
    assert.equal(probe.mock.calls.length, 2);
    assertMatch(updated, {
      bin: cft,
      probe: { version: '154.0.8037.92', ok: true, cached: false },
    });
  });

  it('keeps a transient probe failure only for its TTL, then probes again', async () => {
    const { cft, chrome } = apps();
    let clock = Date.parse('2026-10-01T10:00:00Z');
    const probe = resolvesInSequence(
      {
        ok: false,
        reason: 'renders no frames (requestAnimationFrame never fired) (2 attempts)',
        transient: true,
      },
      { ok: true, reason: 'started and rendered', transient: false },
    );
    const options = {
      env: {},
      cft: () => ({ executable: cft }),
      probe,
      cachePath: path.join(root, 'cache.json'),
      chromeCandidates: [chrome],
      now: () => new Date(clock),
    };

    const first = await resolver.resolveBrowser(options);
    assertMatch(first, {
      bin: chrome,
      probe: { transient: true, cached: false },
    });
    assert.equal(Date.parse(first.probe.expiresAt) - clock, resolver.TRANSIENT_VERDICT_TTL_MS);

    clock += 60_000;
    assertMatch(await resolver.resolveBrowser(options), {
      bin: chrome,
      probe: { transient: true, cached: true },
    });
    assert.equal(probe.mock.calls.length, 1);

    clock += resolver.TRANSIENT_VERDICT_TTL_MS;
    assertMatch(await resolver.resolveBrowser(options), {
      bin: cft,
      probe: { ok: true, transient: false },
    });
    assert.equal(probe.mock.calls.length, 2);
  });

  it('serializes concurrent probes for one cache key', async () => {
    const { cft, chrome } = apps();
    const probe = mock.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return {
        ok: false,
        reason: 'exited during startup (SIGBUS)',
        transient: false,
      };
    });
    const options = {
      env: {},
      cft: () => ({ executable: cft }),
      probe,
      cachePath: path.join(root, 'cache.json'),
      chromeCandidates: [chrome],
    };
    const results = await Promise.all([
      resolver.resolveBrowser(options),
      resolver.resolveBrowser(options),
      resolver.resolveBrowser(options),
    ]);
    assert.equal(probe.mock.calls.length, 1);
    assert.deepStrictEqual(
      results.map((result) => result.bin),
      [chrome, chrome, chrome],
    );
    assert.equal(results.filter((result) => result.probe.cached === false).length, 1);
    const [locks] = fs.readdirSync(root).filter((name) => name.endsWith('.locks'));
    // Each waiter took the lock in turn to re-read the cache; every ticket is released.
    const tickets = fs.readdirSync(path.join(root, locks));
    assert.equal(
      tickets
        .filter((name) => !name.endsWith('.released'))
        .every((name) => tickets.includes(`${name}.released`)),
      true,
    );
  });

  const ticketDir = (cachePath, key) => `${cachePath}.${key.slice(0, 16)}.locks`;
  const ticket = (dir, number, holder) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, String(number)),
      holder === undefined ? '' : JSON.stringify(holder),
    );
    return path.join(dir, String(number));
  };

  it('waits on a fresh unreadable ticket and takes over once it is old', async () => {
    const cachePath = path.join(root, 'cache.json');
    const key = 'a'.repeat(64);
    const first = ticket(ticketDir(cachePath, key), 1);
    await assert.rejects(
      resolver.withProbeLock(cachePath, key, async () => 'ran', {
        waitMs: 600,
      }),
      /Timed out waiting/u,
    );
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(first, old, old);
    assert.equal(
      await resolver.withProbeLock(cachePath, key, async () => 'ran', {
        waitMs: 600,
      }),
      'ran',
    );
    // The stale ticket is left in place; the new holder took the next one and released it.
    assert.deepStrictEqual(fs.readdirSync(ticketDir(cachePath, key)).sort(), [
      '1',
      '2',
      '2.released',
    ]);
  });

  it('never displaces a live holder that claimed the lock while another resolver judged the old one stale', async () => {
    const cachePath = path.join(root, 'cache.json');
    const key = 'b'.repeat(64);
    ticket(ticketDir(cachePath, key), 1, {
      pid: 2 ** 22 + 4321,
      at: Date.now(),
    });
    let active = 0;
    let overlap = 0;
    const order = [];
    const body = (name) => async () => {
      active += 1;
      overlap = Math.max(overlap, active);
      order.push(`${name} in`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      order.push(`${name} out`);
      active -= 1;
    };
    // A judges the dead holder's ticket free, then stalls before claiming;
    // B claims meanwhile and is still inside the lock when A resumes.
    let resumeA;
    const aStalled = new Promise((resolve) => {
      resumeA = resolve;
    });
    let bInside;
    const bEntered = new Promise((resolve) => {
      bInside = resolve;
    });
    let stalls = 0;
    const a = resolver.withProbeLock(cachePath, key, body('A'), {
      waitMs: 5000,
      beforeClaim: async () => {
        stalls += 1;
        if (stalls === 1) {
          await aStalled;
        }
      },
    });
    const b = resolver.withProbeLock(
      cachePath,
      key,
      async () => {
        bInside();
        await body('B')();
      },
      { waitMs: 5000 },
    );
    await bEntered;
    resumeA();
    await Promise.all([a, b]);
    assert.equal(overlap, 1);
    assert.deepStrictEqual(order, ['B in', 'B out', 'A in', 'A out']);
    assert.deepStrictEqual(fs.readdirSync(ticketDir(cachePath, key)).sort(), [
      '1',
      '2',
      '2.released',
      '3',
      '3.released',
    ]);
  });

  it('releases only its own ticket', async () => {
    const cachePath = path.join(root, 'cache.json');
    const key = 'c'.repeat(64);
    const dir = ticketDir(cachePath, key);
    await resolver.withProbeLock(cachePath, key, async () => {
      // A later holder (this one judged stale meanwhile) owns ticket 2.
      ticket(dir, 2, { pid: process.pid, at: Date.now() });
    });
    assert.equal(fs.existsSync(path.join(dir, '1.released')), true);
    assert.equal(fs.existsSync(path.join(dir, '2.released')), false);
  });

  it('never claims a ticket once its wait has expired, and releases every ticket it claims', async () => {
    const cachePath = path.join(root, 'cache.json');
    const key = 'd'.repeat(64);
    const dir = ticketDir(cachePath, key);
    ticket(dir, 1, { pid: 2 ** 22 + 4321, at: Date.now() });
    // The waiter finds ticket 1 free but resumes after its deadline.
    await assert.rejects(
      resolver.withProbeLock(cachePath, key, async () => 'ran', {
        waitMs: 200,
        beforeClaim: () => new Promise((resolve) => setTimeout(resolve, 300)),
      }),
      /Timed out waiting/u,
    );
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['1']);
    // A body that throws still releases its ticket; the next caller goes straight in.
    await assert.rejects(
      resolver.withProbeLock(cachePath, key, async () => {
        throw new Error('probe broke');
      }),
      messageContains('probe broke'),
    );
    assert.equal(fs.existsSync(path.join(dir, '2.released')), true);
    assert.equal(
      await resolver.withProbeLock(cachePath, key, async () => 'ran', {
        waitMs: 600,
      }),
      'ran',
    );
  });

  it(
    'treats a ticket whose pid now belongs to another process as free',
    { timeout: 30000 },
    async () => {
      const cachePath = path.join(root, 'cache.json');
      const key = 'e'.repeat(64);
      const dir = ticketDir(cachePath, key);
      const other = spawn('sleep', ['30'], { stdio: 'ignore' });
      try {
        const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(other.pid)], {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        }).trim();
        // The holder it names is alive and is the process that wrote the ticket: held.
        ticket(dir, 1, { pid: other.pid, at: Date.now(), started });
        await assert.rejects(
          resolver.withProbeLock(cachePath, key, async () => 'ran', {
            waitMs: 400,
          }),
          /Timed out waiting/u,
        );
        // Same pid, other start time: a reused pid, so the ticket is free.
        fs.writeFileSync(
          path.join(dir, '1'),
          JSON.stringify({
            pid: other.pid,
            at: Date.now(),
            started: 'Mon Jan  5 10:00:00 2026',
          }),
        );
        assert.equal(
          await resolver.withProbeLock(cachePath, key, async () => 'ran', {
            waitMs: 2000,
          }),
          'ran',
        );
      } finally {
        other.kill('SIGKILL');
      }
    },
  );

  it('never removes a ticket, however many probes ran', async () => {
    const cachePath = path.join(root, 'cache.json');
    const key = 'f'.repeat(64);
    const dir = ticketDir(cachePath, key);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    for (let number = 1; number <= 30; number += 1) {
      const file = ticket(dir, number, {
        pid: 2 ** 22 + 4321,
        at: old.getTime(),
      });
      // Ticket 3's holder crashed before releasing it.
      if (number !== 3) {
        fs.writeFileSync(`${file}.released`, '');
      }
    }
    await resolver.withProbeLock(cachePath, key, async () => 'ran');
    const left = fs.readdirSync(dir);
    assert.equal(left.filter((name) => /^\d+$/u.test(name)).length, 31);
    assert.equal(left.filter((name) => name.endsWith('.released')).length, 30);
    assert.ok(!left.includes('3.released'));
  });

  it(
    'reads the holder start time fresh on every judgement, within the lock budget and with 2s slack',
    { timeout: 30000 },
    async () => {
      const cachePath = path.join(root, 'cache.json');
      const key = '9'.repeat(64);
      const dir = ticketDir(cachePath, key);
      const other = spawn('sleep', ['30'], { stdio: 'ignore' });
      try {
        // Ticket 1: the live process that wrote it.
        let current = 'Mon Jan  5 10:00:00 2026';
        const budgets = [];
        const readStartTime = (_pid, budgetMs) => {
          if (budgetMs !== undefined) {
            budgets.push(budgetMs);
          }
          return current;
        };
        ticket(dir, 1, {
          pid: other.pid,
          at: Date.now(),
          started: 'Mon Jan  5 10:00:00 2026',
        });
        const waiter = resolver.withProbeLock(cachePath, key, async () => 'ran', {
          waitMs: 1500,
          readStartTime,
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        // Ticket 1 is released and ticket 2 is taken by a new process that reuses
        // the same pid (another start time, read 1s late as Linux lstart can be).
        fs.writeFileSync(path.join(dir, '1.released'), '');
        ticket(dir, 2, {
          pid: other.pid,
          at: Date.now(),
          started: 'Tue Jan  6 10:00:00 2026',
        });
        current = 'Tue Jan  6 10:00:01 2026';
        // A start time remembered from ticket 1 would call ticket 2 stale; a fresh read keeps it held.
        await assert.rejects(waiter, /Timed out waiting/u);
        assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['1', '1.released', '2']);
        assert.ok(budgets.length > 1);
        assert.equal(
          budgets.every((ms) => ms > 0 && ms <= 1500),
          true,
        );
      } finally {
        other.kill('SIGKILL');
      }
    },
  );

  it(
    'runs exactly one probe when processes break a stale lock together',
    { timeout: 60000 },
    async () => {
      const { cft, chrome } = apps();
      const cachePath = path.join(root, 'cache.json');
      const probes = path.join(root, 'probes.log');
      const version = resolver.browserVersion(cft);
      const key = resolver.probeCacheKey(cft, version, resolver.SPAWN, resolver.HEADLESS);
      ticket(ticketDir(cachePath, key), 1, {
        pid: 2 ** 22 + 4321,
        at: Date.now(),
      });
      const worker = path.join(__dirname, 'fixtures/probe-lock-worker.cjs');
      const runs = Array.from(
        { length: 4 },
        () =>
          new Promise((resolve, reject) => {
            execFile(process.execPath, [worker, cft, chrome, cachePath, probes], (error, stdout) =>
              error ? reject(error) : resolve(stdout.trim()),
            );
          }),
      );
      const results = await Promise.all(runs);
      assert.equal(fs.readFileSync(probes, 'utf8').trim().split('\n').length, 1);
      assert.deepStrictEqual(new Set(results), new Set([chrome]));
    },
  );

  it('probes the way the caller launches, in its display mode, and caches each separately', async () => {
    const { cft, chrome } = apps();
    const probe = mock.fn(async (_bin, { launchMethod }) =>
      launchMethod === resolver.LAUNCH_SERVICES
        ? { ok: true, reason: 'started and rendered', transient: false }
        : {
            ok: false,
            reason: 'exited during startup (SIGBUS)',
            transient: false,
          },
    );
    const base = {
      env: {},
      cft: () => ({ executable: cft }),
      probe,
      cachePath: path.join(root, 'cache.json'),
      chromeCandidates: [chrome],
    };
    const onMac = process.platform === 'darwin';

    const launchServices = await resolver.resolveBrowser({
      ...base,
      launchMethod: resolver.LAUNCH_SERVICES,
      display: resolver.HEADFUL,
    });
    const spawned = await resolver.resolveBrowser({
      ...base,
      launchMethod: resolver.SPAWN,
      display: resolver.HEADFUL,
    });
    await resolver.resolveBrowser({
      ...base,
      launchMethod: resolver.SPAWN,
      display: resolver.HEADLESS,
    });

    assert.deepStrictEqual(probe.mock.calls[0].arguments, [
      cft,
      {
        launchMethod: onMac ? resolver.LAUNCH_SERVICES : resolver.SPAWN,
        display: resolver.HEADFUL,
      },
    ]);
    if (onMac) {
      assertMatch(launchServices, {
        bin: cft,
        probe: {
          launchMethod: resolver.LAUNCH_SERVICES,
          display: resolver.HEADFUL,
          ok: true,
        },
      });
      assertMatch(spawned, {
        bin: chrome,
        probe: { launchMethod: resolver.SPAWN, ok: false },
      });
    } else {
      // Launch Services exists only on macOS: both requests are one spawn probe.
      assertMatch(spawned.probe, {
        launchMethod: resolver.SPAWN,
        cached: true,
      });
    }
    // Headful and headless are different probes.
    assert.equal(probe.mock.calls.length, onMac ? 3 : 2);
    assert.equal(
      Object.keys(resolver.readProbeCache(base.cachePath).entries).length,
      onMac ? 3 : 2,
    );
  });

  // Recorded-browser matrix for `auto` with an existing slot profile.
  // recorded: the browser the profile was created with; cft: the checkout's
  // current Chrome for Testing; verdict: what a probe of it returns (null:
  // must not probe); expect: the outcome.
  const OK = { ok: true, reason: 'started and rendered', transient: false };
  const DEAD = {
    ok: false,
    reason: 'exited during startup (SIGBUS)',
    transient: false,
  };
  const SLOW = {
    ok: false,
    reason: 'renders no frames (2 attempts)',
    transient: true,
  };
  const matrix = [
    {
      name: 'CfT profile follows a Playwright upgrade to the current build',
      recorded: 'cft-old',
      cft: 'cft-new',
      verdict: OK,
      expect: { bin: 'cft-new', source: 'auto-recorded' },
    },
    {
      name: 'CfT profile keeps CfT when the current build probes healthy',
      recorded: 'cft-new',
      cft: 'cft-new',
      verdict: OK,
      expect: {
        bin: 'cft-new',
        source: 'auto-recorded',
        selection: 'cft',
        recordedSelection: 'cft',
      },
    },
    {
      name: 'CfT profile keeps CfT when the probe only timed out',
      recorded: 'cft-new',
      cft: 'cft-new',
      verdict: SLOW,
      expect: {
        bin: 'cft-new',
        source: 'auto-recorded',
        warning: contains('keeps Chrome for Testing'),
      },
    },
    {
      name: 'CfT profile moves to Chrome once the build is proven to die',
      recorded: 'cft-new',
      cft: 'cft-new',
      verdict: DEAD,
      expect: {
        bin: 'chrome',
        source: 'auto',
        fallbackReason: contains('SIGBUS'),
      },
    },
    {
      name: 'CfT profile with a dead build and no Chrome is unlaunchable',
      recorded: 'cft-new',
      cft: 'cft-new',
      verdict: DEAD,
      noChrome: true,
      expect: { error: /BROWSER_UNLAUNCHABLE/u },
    },
    {
      name: 'CfT profile with CfT uninstalled keeps the install guidance',
      recorded: 'cft-new',
      cft: null,
      verdict: null,
      expect: { error: /Playwright Chromium is not installed/u },
    },
    {
      name: 'Chrome profile stays on Chrome when CfT is gone',
      recorded: 'chrome',
      cft: null,
      verdict: null,
      expect: { bin: 'chrome', source: 'auto-recorded' },
    },
    {
      name: 'Chrome profile stays on Chrome when CfT is healthy',
      recorded: 'chrome',
      cft: 'cft-new',
      verdict: null,
      expect: { bin: 'chrome', source: 'auto-recorded' },
    },
    {
      name: 'Chrome profile whose Chrome disappeared fails, never back to CfT',
      recorded: 'chrome-removed',
      cft: 'cft-new',
      verdict: null,
      expect: { error: /created with google-chrome .* no longer exists/u },
    },
    {
      name: 'explicit-path profile keeps that binary',
      recorded: 'custom',
      cft: 'cft-new',
      verdict: null,
      expect: { bin: 'custom', source: 'auto-recorded' },
    },
    {
      name: 'CfT chosen by RECIPE_HARNESS_CHROME_BIN stays that exact binary',
      recorded: 'cft-old-override',
      cft: 'cft-new',
      verdict: null,
      expect: { bin: 'cft-old', source: 'auto-recorded' },
    },
    {
      name: 'CfT given to the launcher as --chrome-bin stays that exact binary',
      recorded: 'cft-old-explicit',
      cft: 'cft-new',
      verdict: null,
      expect: { bin: 'cft-old', source: 'auto-recorded', selection: 'explicit' },
    },
  ];

  for (const { name, recorded, cft, verdict, noChrome, expect: expected } of matrix) {
    it(name, async () => {
      const bins = {
        'cft-old': fakeApp(
          'chromium-1217/Google Chrome for Testing',
          'com.google.chrome.for.testing',
          '147.0.7727.15',
        ),
        'cft-new': fakeApp(
          'chromium-1225/Google Chrome for Testing',
          'com.google.chrome.for.testing',
          '149.0.7800.10',
        ),
        chrome: fakeApp('Google Chrome', 'com.google.Chrome', '154.0.8037.92'),
        custom: fakeApp('Brave Browser', 'com.brave.Browser', '154.1.0.0'),
      };
      const records = {
        'cft-old': {
          bin: bins['cft-old'],
          browser: 'chrome-for-testing',
          mode: 'auto',
        },
        'cft-new': {
          bin: bins['cft-new'],
          browser: 'chrome-for-testing',
          mode: 'cft',
        },
        chrome: { bin: bins.chrome, browser: 'google-chrome', mode: 'auto' },
        'chrome-removed': {
          bin: path.join(root, 'gone/Google Chrome'),
          browser: 'google-chrome',
          mode: 'chrome',
        },
        custom: { bin: bins.custom, browser: 'other', mode: 'path' },
        'cft-old-override': {
          bin: bins['cft-old'],
          browser: 'chrome-for-testing',
          mode: 'override',
        },
        'cft-old-explicit': {
          bin: bins['cft-old'],
          browser: 'chrome-for-testing',
          mode: 'explicit',
          selection: 'explicit',
        },
      };
      const recordFile = path.join(root, 'browser-resolution.json');
      fs.writeFileSync(recordFile, JSON.stringify(records[recorded]));
      const probe = mock.fn(async () => verdict ?? OK);
      const options = {
        env: {},
        cft: () =>
          cft
            ? { executable: bins[cft] }
            : { error: '[recipe-harness] Playwright Chromium is not installed at /x' },
        probe,
        cachePath: path.join(root, 'cache.json'),
        chromeCandidates: noChrome ? [] : [bins.chrome],
        recorded: recordFile,
      };
      if (expected.error) {
        await assert.rejects(resolver.resolveBrowser(options), expected.error);
      } else {
        const { bin, ...rest } = expected;
        assertMatch(await resolver.resolveBrowser(options), {
          bin: bins[bin] ?? bin,
          ...rest,
          recordedFrom: recordFile,
        });
      }
      if (verdict === null) {
        assert.equal(probe.mock.calls.length, 0);
      } else {
        assert.equal(probe.mock.calls.length, 1);
      }
    });
  }

  it('keeps an explicitly chosen browser across repeated auto launches of its profile', async () => {
    const old = fakeApp(
      'chromium-1217/Google Chrome for Testing',
      'com.google.chrome.for.testing',
      '147.0.7727.15',
    );
    const current = fakeApp(
      'chromium-1225/Google Chrome for Testing',
      'com.google.chrome.for.testing',
      '149.0.7800.10',
    );
    const recordFile = path.join(root, 'browser-resolution.json');
    const probe = mock.fn(async () => ({
      ok: true,
      reason: 'started and rendered',
      transient: false,
    }));
    const base = {
      cft: () => ({ executable: current }),
      probe,
      cachePath: path.join(root, 'cache.json'),
      chromeCandidates: [],
    };
    for (const env of [{ RECIPE_HARNESS_CHROME_BIN: old }, { RECIPE_HARNESS_BROWSER: old }]) {
      let resolution = await resolver.resolveBrowser({ ...base, env });
      for (let launch = 0; launch < 3; launch += 1) {
        fs.writeFileSync(recordFile, JSON.stringify(resolution));
        resolution = await resolver.resolveBrowser({
          ...base,
          env: {},
          recorded: recordFile,
        });
        assertMatch(resolution, {
          bin: old,
          source: 'auto-recorded',
          selection: env.RECIPE_HARNESS_CHROME_BIN ? 'override' : 'path',
        });
      }
    }
    assert.equal(probe.mock.calls.length, 0);
  });

  it('records the Playwright build as Chrome for Testing by its source, so a Linux profile follows upgrades', async () => {
    const linuxBuild = (revision, version) => {
      const executable = path.join(root, `ms-playwright/chromium-${revision}/chrome-linux/chrome`);
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, `#!/bin/sh\necho Chromium ${version}\n`, {
        mode: 0o755,
      });
      return executable;
    };
    const old = linuxBuild('1217', '147.0.7727.15');
    const current = linuxBuild('1225', '149.0.7800.10');
    const probe = mock.fn(async () => ({
      ok: true,
      reason: 'started and rendered',
      transient: false,
    }));
    const base = {
      env: {},
      probe,
      cachePath: path.join(root, 'cache.json'),
      chromeCandidates: [],
    };
    const first = await resolver.resolveBrowser({
      ...base,
      cft: () => ({ executable: old }),
    });
    assertMatch(first, {
      bin: old,
      browser: 'chrome-for-testing',
      selection: 'auto',
      extensionLoading: 'load-extension',
    });
    const recordFile = path.join(root, 'browser-resolution.json');
    fs.writeFileSync(recordFile, JSON.stringify(first));
    assertMatch(
      await resolver.resolveBrowser({
        ...base,
        cft: () => ({ executable: current }),
        recorded: recordFile,
      }),
      {
        bin: current,
        browser: 'chrome-for-testing',
        source: 'auto-recorded',
        probe: { version: '149.0.7800.10' },
      },
    );
    assert.equal(probe.mock.calls.length, 2);
  });

  describe('on a Mac whose Google Chrome is managed by policy', () => {
    const FORCED = ['jdoahkhfkeipblhbhppmcbdgapeoaopa', 'glnpjglilkicbckjpbgcfkogebgllemb'];
    const managed = () => ({
      forcedExtensions: FORCED.map((id) => ({ id, name: null })),
      signinForced: false,
      sources: ['/Library/Managed Preferences/com.google.Chrome.plist'],
    });
    const OK = { ok: true, reason: 'started and rendered', transient: false };
    const base = (extra = {}) => {
      const { cft, chrome } = apps();
      return {
        cft,
        chrome,
        options: {
          env: {},
          cft: () => ({ executable: cft }),
          cachePath: path.join(root, 'cache.json'),
          chromeCandidates: [chrome],
          managedChrome: managed,
          ...extra,
        },
      };
    };

    it('uses Chrome for Testing and records why', async () => {
      const { cft, options } = base({ probe: mock.fn(async () => OK) });
      assertMatch(await resolver.resolveBrowser(options), {
        bin: cft,
        browser: 'chrome-for-testing',
        selection: 'auto',
        reason: 'managed-chrome',
        managedChrome: {
          forcedExtensions: [{ id: FORCED[0] }, { id: FORCED[1] }],
        },
      });
    });

    it('never falls back to the managed Chrome when Chrome for Testing dies or does not paint', async () => {
      for (const verdict of [
        {
          ok: false,
          reason: 'exited during startup (SIGBUS)',
          transient: false,
        },
        {
          ok: false,
          reason: 'renders no frames (2 attempts)',
          transient: true,
        },
      ]) {
        const { options } = base({
          probe: mock.fn(async () => verdict),
          cachePath: path.join(root, `cache-${verdict.transient}.json`),
        });
        await assert.rejects(
          resolver.resolveBrowser(options),
          /BROWSER_UNLAUNCHABLE: Google Chrome is managed by policy \(2 forced extensions: jdoahkhfkeipblhbhppmcbdgapeoaopa, glnpjglilkicbckjpbgcfkogebgllemb\).*RECIPE_HARNESS_BROWSER=chrome.*reduce the machine's load/su,
        );
      }
    });

    it("keeps today's fallback when Chrome is not managed", async () => {
      const { chrome, options } = base({
        probe: crash(),
        managedChrome: () => null,
      });
      assertMatch(await resolver.resolveBrowser(options), {
        bin: chrome,
        browser: 'google-chrome',
      });
    });

    it('still honours an explicit RECIPE_HARNESS_BROWSER=chrome', async () => {
      const { chrome, options } = base({
        env: { RECIPE_HARNESS_BROWSER: 'chrome' },
        probe: crash(),
      });
      assertMatch(await resolver.resolveBrowser(options), {
        bin: chrome,
        browser: 'google-chrome',
        selection: 'chrome',
      });
    });

    it('keeps a slot profile created on Google Chrome, with a warning to reset it, naming the forced extensions it saw', async () => {
      const { chrome, options } = base({ probe: crash() });
      const recordFile = path.join(root, 'browser-resolution.json');
      fs.writeFileSync(
        recordFile,
        JSON.stringify({
          bin: chrome,
          browser: 'google-chrome',
          selection: 'auto',
          launch: {
            otherExtensions: {
              policyPinned: [{ id: FORCED[0], name: 'JumpCloud Go' }],
            },
          },
        }),
      );
      const resolution = await resolver.resolveBrowser({
        ...options,
        recorded: recordFile,
      });
      assertMatch(resolution, {
        bin: chrome,
        source: 'auto-recorded',
        warning: contains('reset the slot profile'),
      });
      assert.deepStrictEqual(resolution.managedChrome.forcedExtensions, [
        { id: FORCED[0], name: 'JumpCloud Go' },
        { id: FORCED[1], name: null },
      ]);
    });

    it('reads forced extensions and forced sign-in from the managed preferences', () => {
      const policies = {
        '/m/com.google.Chrome.plist': {
          ExtensionInstallForcelist: [
            `${FORCED[0]};https://clients2.google.com/service/update2/crx`,
            'not-an-id',
          ],
          ExtensionSettings: {
            '*': { installation_mode: 'allowed' },
            [FORCED[1]]: { installation_mode: 'force_installed' },
            aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: { installation_mode: 'blocked' },
          },
        },
        '/m/user/com.google.Chrome.plist': { BrowserSignin: 2 },
      };
      const read = (options) =>
        resolver.readManagedChromePolicy({
          platform: 'darwin',
          plists: Object.keys(policies),
          exists: (file) => file in policies,
          readKey: (file, key) => policies[file][key],
          extensionName: (id) => (id === FORCED[1] ? 'Okta Browser Plugin' : null),
          ...options,
        });
      assert.deepStrictEqual(read(), {
        forcedExtensions: [
          { id: FORCED[1], name: 'Okta Browser Plugin' },
          { id: FORCED[0], name: null },
        ],
        signinForced: true,
        sources: Object.keys(policies),
      });
      assert.equal(read({ exists: () => false }), null);
      assert.equal(read({ platform: 'linux' }), null);
    });

    it(
      'reads each policy kind from a real plutil-written plist',
      { skip: process.platform !== 'darwin', timeout: 60000 },
      () => {
        const plist = (name, ...inserts) => {
          const file = path.join(root, `${name}.plist`);
          execFileSync('plutil', ['-create', 'xml1', file]);
          for (const insert of inserts) {
            execFileSync('plutil', ['-insert', ...insert, file]);
          }
          return file;
        };
        const read = (file) =>
          resolver.readManagedChromePolicy({
            plists: [file],
            extensionName: () => null,
          });
        const forcelist = plist('forcelist', [
          'ExtensionInstallForcelist',
          '-json',
          JSON.stringify([`${FORCED[0]};https://x`]),
        ]);
        assert.deepStrictEqual(read(forcelist), {
          forcedExtensions: [{ id: FORCED[0], name: null }],
          signinForced: false,
          sources: [forcelist],
        });
        const settings = plist('settings', [
          'ExtensionSettings',
          '-json',
          JSON.stringify({
            '*': { installation_mode: 'allowed' },
            [FORCED[1]]: { installation_mode: 'force_installed' },
          }),
        ]);
        assert.deepStrictEqual(read(settings), {
          forcedExtensions: [{ id: FORCED[1], name: null }],
          signinForced: false,
          sources: [settings],
        });
        // Scalars: plutil extracts these only as raw values, never as JSON.
        const browserSignin = plist('browser-signin', ['BrowserSignin', '-integer', '2']);
        assert.deepStrictEqual(read(browserSignin), {
          forcedExtensions: [],
          signinForced: true,
          sources: [browserSignin],
        });
        const forceSignin = plist('force-signin', ['ForceBrowserSignin', '-bool', 'true']);
        assert.deepStrictEqual(read(forceSignin), {
          forcedExtensions: [],
          signinForced: true,
          sources: [forceSignin],
        });
        const optionalSignin = plist(
          'optional-signin',
          ['BrowserSignin', '-integer', '1'],
          ['ForceBrowserSignin', '-bool', 'false'],
        );
        assert.equal(read(optionalSignin), null);
      },
    );
  });

  it('uses Chrome for Testing unprobed when RECIPE_HARNESS_BROWSER=cft', async () => {
    const { cft } = apps();
    const probe = crash();
    const resolution = await resolver.resolveBrowser({
      env: { RECIPE_HARNESS_BROWSER: 'cft' },
      cft: () => ({ executable: cft }),
      probe,
      cachePath: path.join(root, 'cache.json'),
      chromeCandidates: [],
    });
    assertMatch(resolution, {
      bin: cft,
      mode: 'cft',
      source: 'RECIPE_HARNESS_BROWSER',
      extensionLoading: 'load-extension',
    });
    assert.equal(resolution.probe, undefined);
    assert.equal(probe.mock.calls.length, 0);
  });

  it('keeps the approval-gated Playwright install error when Chrome for Testing is missing', async () => {
    const { chrome } = apps();
    await assert.rejects(
      resolver.resolveBrowser({
        env: {},
        cft: () => ({
          error: '[recipe-harness] Playwright Chromium is not installed at /x',
        }),
        probe: crash(),
        cachePath: path.join(root, 'cache.json'),
        chromeCandidates: [chrome],
      }),
      messageContains('Playwright Chromium is not installed'),
    );
  });

  it('honours RECIPE_HARNESS_CHROME_BIN verbatim without probing', async () => {
    const custom = fakeApp('Chromium', 'org.chromium.Chromium', '150.0.1.2');
    const cft = mock.fn();
    const probe = crash();
    const resolution = await resolver.resolveBrowser({
      env: {
        RECIPE_HARNESS_CHROME_BIN: custom,
        RECIPE_HARNESS_BROWSER: 'chrome',
      },
      cft,
      probe,
      cachePath: path.join(root, 'cache.json'),
      chromeCandidates: [],
    });
    assertMatch(resolution, {
      bin: custom,
      source: 'RECIPE_HARNESS_CHROME_BIN',
      mode: 'override',
      extensionLoading: 'load-extension',
    });
    assert.equal(cft.mock.calls.length, 0);
    assert.equal(probe.mock.calls.length, 0);
  });

  it('forces branded Chrome, or an explicit path, without probing', async () => {
    const { chrome } = apps();
    const cft = mock.fn();
    const base = {
      cft,
      probe: crash(),
      cachePath: path.join(root, 'cache.json'),
      chromeCandidates: [chrome],
    };
    assertMatch(
      await resolver.resolveBrowser({
        ...base,
        env: { RECIPE_HARNESS_BROWSER: 'chrome' },
      }),
      { bin: chrome, mode: 'chrome', extensionLoading: 'cdp-load-unpacked' },
    );
    assertMatch(
      await resolver.resolveBrowser({
        ...base,
        env: { RECIPE_HARNESS_BROWSER: chrome },
      }),
      { bin: chrome, mode: 'path', extensionLoading: 'cdp-load-unpacked' },
    );
    assert.equal(cft.mock.calls.length, 0);
    await assert.rejects(
      resolver.resolveBrowser({
        ...base,
        chromeCandidates: [],
        env: { RECIPE_HARNESS_BROWSER: 'chrome' },
      }),
      messageContains('Google Chrome is not installed'),
    );
    assert.throws(
      () => resolver.browserMode({ RECIPE_HARNESS_BROWSER: 'firefox' }),
      messageContains('auto, cft, chrome'),
    );
    assert.deepStrictEqual(
      resolver.brandedChromeCandidates({
        RECIPE_HARNESS_CHROME_CANDIDATES: ['/a', '/b'].join(path.delimiter),
      }),
      ['/a', '/b'],
    );
  });

  it('fails with an explicit unlaunchable marker when Chrome for Testing crashes and Chrome is absent', async () => {
    const { cft } = apps();
    await assert.rejects(
      resolver.resolveBrowser({
        env: {},
        cft: () => ({ executable: cft }),
        probe: crash(),
        cachePath: path.join(root, 'cache.json'),
        chromeCandidates: [path.join(root, 'missing')],
      }),
      messageContains(resolver.UNLAUNCHABLE_MARKER),
    );
  });

  it('never pairs CDP loading with --disable-extensions-except', () => {
    assert.deepStrictEqual(resolver.extensionLaunchArgs('/dist', 'load-extension'), [
      '--disable-extensions-except=/dist',
      '--load-extension=/dist',
    ]);
    const branded = resolver.extensionLaunchArgs('/dist', 'cdp-load-unpacked');
    assert.ok(branded.includes('--enable-unsafe-extension-debugging'));
    assert.ok(branded.includes('--load-extension=/dist'));
    assert.equal(
      branded.some((arg) => arg.startsWith('--disable-extensions-except')),
      false,
    );
    assert.equal(
      branded.some((arg) => arg.startsWith('--disable-features')),
      false,
    );
  });

  it('keys the probe cache without the hostname', () => {
    const { cft } = apps();
    const key = resolver.probeCacheKey(cft, '147', resolver.SPAWN, resolver.HEADLESS);
    const hostname = mock.method(os, 'hostname', () => 'renamed-host');
    assert.equal(resolver.probeCacheKey(cft, '147', resolver.SPAWN, resolver.HEADLESS), key);
    hostname.mock.restore();
    assert.notEqual(resolver.probeCacheKey(cft, '147', resolver.SPAWN, resolver.HEADFUL), key);
  });
});

describe('probeLaunch against a fake browser', () => {
  const fast = { settleMs: 300, startupMs: 4000 };

  function profilesLeft() {
    try {
      return execFileSync('pgrep', ['-f', 'farmslot-browser-probe-'], {
        encoding: 'utf8',
      }).trim();
    } catch {
      // pgrep exits non-zero when nothing matches: no profile is left.
      return '';
    }
  }

  it(
    'accepts a browser that answers DevTools, paints and stays up',
    { timeout: 30000 },
    async () => {
      process.env.FAKE_CDP_MODE = 'ok';
      const verdict = await resolver.probeLaunch(FAKE_BROWSER, fast);
      assertMatch(verdict, {
        ok: true,
        transient: false,
        reason: 'started and rendered',
        launchMethod: 'spawn',
        display: 'headless',
      });
    },
  );

  it('records a crash as a property of the binary', { timeout: 30000 }, async () => {
    process.env.FAKE_CDP_MODE = 'crash';
    const verdict = await resolver.probeLaunch(FAKE_BROWSER, fast);
    assertMatch(verdict, { ok: false, transient: false });
    assert.match(verdict.reason, /exited during startup \(SIGBUS\)/u);
  });

  it(
    'treats a browser that never paints as transient, after retrying',
    { timeout: 40000 },
    async () => {
      process.env.FAKE_CDP_MODE = 'noframes';
      const verdict = await resolver.probeLaunch(FAKE_BROWSER, {
        ...fast,
        renderAttempts: 2,
      });
      assertMatch(verdict, { ok: false, transient: true });
      assert.ok(verdict.reason.includes('requestAnimationFrame never fired) (2 attempts)'));
      assert.equal(profilesLeft(), '');
    },
  );

  it(
    'keeps a live browser whose DevTools stops answering transient',
    { timeout: 30000 },
    async () => {
      process.env.FAKE_CDP_MODE = 'unlisten';
      const verdict = await resolver.probeLaunch(FAKE_BROWSER, fast);
      assertMatch(verdict, {
        ok: false,
        transient: true,
        reason: 'DevTools stopped answering after the settle',
      });
      assert.equal(profilesLeft(), '');
    },
  );

  it(
    'treats a browser that never opens DevTools as transient and stops it',
    { timeout: 30000 },
    async () => {
      process.env.FAKE_CDP_MODE = 'silent';
      const verdict = await resolver.probeLaunch(FAKE_BROWSER, {
        ...fast,
        startupMs: 1500,
      });
      assertMatch(verdict, { ok: false, transient: true });
      assert.ok(verdict.reason.includes('no DevTools endpoint within 1500ms'));
      assert.equal(profilesLeft(), '');
    },
  );

  // The caller runs in its own process group, like a hook under the node agent,
  // whose timeout sends SIGTERM to that group (SIGKILL 5s later).
  function probingCaller(script, env = {}) {
    const caller = spawn(
      process.execPath,
      [
        '-e',
        `const resolver = require(${JSON.stringify(require.resolve('../src/browser-resolver.cjs'))});
${script}
resolver.probeLaunch(${JSON.stringify(FAKE_BROWSER)}, { startupMs: 20000 }).then((verdict) => {
  process.stdout.write(JSON.stringify(verdict));
});`,
      ],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, FAKE_CDP_MODE: 'silent', ...env },
      },
    );
    let stdout = '';
    caller.stdout.on('data', (chunk) => (stdout += chunk));
    const exited = new Promise((resolve) =>
      caller.on('exit', (code, signal) => resolve({ code, signal, stdout })),
    );
    return { caller, exited };
  }

  // The probe browser is the caller's child until the caller dies.
  function browserOf(callerPid) {
    try {
      const pid = Number(execFileSync('pgrep', ['-P', String(callerPid)], { encoding: 'utf8' }));
      const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
      });
      const profile = /--user-data-dir=(\S+)/u.exec(command)?.[1];
      return profile ? { pid, profile } : null;
    } catch {
      // pgrep and ps exit non-zero while no child is running yet.
      return null;
    }
  }

  function running(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  }

  async function waitFor(check, ms = 10000) {
    const deadline = Date.now() + ms;
    let value;
    while (!(value = check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the probe browser');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return value;
  }

  it(
    'stops the browser when a group SIGTERM ends the caller mid-probe',
    { timeout: 30000 },
    async () => {
      const { caller, exited } = probingCaller('');
      const browser = await waitFor(() => browserOf(caller.pid));
      process.kill(-caller.pid, 'SIGTERM');
      try {
        assertMatch(await exited, { signal: 'SIGTERM' });
        assert.equal(running(browser.pid), false, 'the probe browser outlived its caller');
        assert.equal(fs.existsSync(browser.profile), false);
      } finally {
        if (running(browser.pid)) process.kill(browser.pid, 'SIGKILL');
      }
    },
  );

  it(
    'reaps the browser of a caller killed outright on the next probe',
    { timeout: 30000 },
    async () => {
      const { caller, exited } = probingCaller('');
      const browser = await waitFor(() => browserOf(caller.pid));
      process.kill(-caller.pid, 'SIGKILL');
      await exited;
      try {
        assert.equal(running(browser.pid), true, 'SIGKILL leaves the browser running');
        process.env.FAKE_CDP_MODE = 'ok';
        await resolver.probeLaunch(FAKE_BROWSER, fast);
        await waitFor(() => !running(browser.pid), 3000);
        assert.equal(fs.existsSync(browser.profile), false);
      } finally {
        // Never leave the fake behind when the reaper fails.
        if (running(browser.pid)) process.kill(browser.pid, 'SIGKILL');
      }
    },
  );

  it(
    'keeps a probe stopped under a host signal handler transient',
    { timeout: 30000 },
    async () => {
      const { caller, exited } = probingCaller("process.on('SIGTERM', () => {});");
      const browser = await waitFor(() => browserOf(caller.pid));
      process.kill(caller.pid, 'SIGTERM');
      const { code, stdout } = await exited;
      assert.equal(code, 0, 'the host decides the exit');
      assertMatch(JSON.parse(stdout), {
        ok: false,
        transient: true,
        reason: 'probe stopped by its caller',
      });
      assert.equal(running(browser.pid), false);
    },
  );

  it('removes its signal handlers once overlapping probes finish', { timeout: 30000 }, async () => {
    const before = ['SIGTERM', 'SIGINT', 'SIGHUP', 'exit'].map((event) =>
      process.listenerCount(event),
    );
    process.env.FAKE_CDP_MODE = 'ok';
    const first = resolver.probeLaunch(FAKE_BROWSER, fast);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await Promise.all([first, resolver.probeLaunch(FAKE_BROWSER, fast)]);
    await resolver.probeLaunch(FAKE_BROWSER, fast);
    assert.deepEqual(
      ['SIGTERM', 'SIGINT', 'SIGHUP', 'exit'].map((event) => process.listenerCount(event)),
      before,
    );
  });

  it('lets a host once-handler finish its own shutdown', { timeout: 30000 }, async () => {
    const { caller, exited } = probingCaller(
      "process.once('SIGTERM', () => setTimeout(() => { process.stdout.write('host-done|'); process.exit(0); }, 300));",
    );
    const browser = await waitFor(() => browserOf(caller.pid));
    process.kill(caller.pid, 'SIGTERM');
    const { code, stdout } = await exited;
    assert.equal(code, 0);
    assert.ok(stdout.includes('host-done|'), stdout);
    assert.equal(running(browser.pid), false);
  });

  it('launches nothing when stopped before the browser starts', { timeout: 30000 }, async () => {
    const host = () => {};
    process.on('SIGTERM', host);
    try {
      process.env.FAKE_CDP_MODE = 'ok';
      const probe = resolver.probeLaunch(FAKE_BROWSER, fast);
      process.emit('SIGTERM', 'SIGTERM');
      assertMatch(await probe, {
        ok: false,
        transient: true,
        reason: 'probe stopped by its caller',
      });
    } finally {
      process.off('SIGTERM', host);
    }
  });

  it("leaves another user's orphaned probe profile alone", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-'));
    const dead = spawnSync('true').pid;
    const foreign = path.join(tmp, `farmslot-browser-probe-${dead}-abc`);
    const mine = path.join(tmp, `farmslot-browser-probe-${dead}-def`);
    fs.mkdirSync(foreign);
    fs.mkdirSync(mine);
    const realLstat = fs.lstatSync;
    const lstat = mock.method(fs, 'lstatSync', (file, ...rest) =>
      file === foreign
        ? { ...realLstat(file, ...rest), uid: process.getuid() + 1 }
        : realLstat(file, ...rest),
    );
    try {
      resolver.reapOrphanedProbes(tmp);
      assert.equal(fs.existsSync(foreign), true);
      assert.equal(fs.existsSync(mine), false);
    } finally {
      lstat.mock.restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
