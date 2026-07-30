import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

import {
  CdpSession,
  jsonGet,
  probeCdpCompositorInteractivity,
  retryJsonGet,
} from '../src/runtime/cdp.js';
import type { RuntimeDecisionReport } from '../src/runtime/decision-types.js';
import {
  dependencyVersionSatisfies,
  depsCheck,
  depsFingerprint,
  recordDepsBaseline,
  writeDecisionState,
} from '../src/runtime/deps-readiness.js';
import {
  analyzeBundleLog,
  evaluatePersistentBundleError,
  moduleExistsInNodeModules,
  supersededErrorCapture,
} from '../src/runtime/log-analysis.js';
import { orchestrateRuntimeUp } from '../src/runtime/orchestrate-up.js';

test('dependency version checks support npm semver ranges', () => {
  assert.equal(dependencyVersionSatisfies('1.2.3', '1.2.3'), true);
  assert.equal(dependencyVersionSatisfies('1.3.0', '^1.2.3'), true);
  assert.equal(dependencyVersionSatisfies('2.0.0', '^1.2.3'), false);
  assert.equal(dependencyVersionSatisfies('1.2.9', '~1.2.3'), true);
  assert.equal(dependencyVersionSatisfies('1.3.0', '~1.2.3'), false);
  assert.equal(dependencyVersionSatisfies('2.4.0', '>=2 <3'), true);
  assert.equal(dependencyVersionSatisfies('not-a-version', '^1.2.3'), false);
  assert.equal(dependencyVersionSatisfies('1.2.3', 'not-a-range'), false);
  assert.equal(dependencyVersionSatisfies('1.2.3', ''), false);
});

test('CDP compositor probe requires advancing frames and sane hit testing', async () => {
  const readyCalls: string[] = [];
  const ready = await probeCdpCompositorInteractivity({
    async call(method) {
      readyCalls.push(method);
      return {
        result: {
          value: {
            frameAdvanced: true,
            interactiveTargetFound: true,
            hitTestOk: true,
          },
        },
      };
    },
  });
  assert.deepEqual(ready, {
    status: 'ready',
    frameAdvanced: true,
    interactiveTargetFound: true,
    hitTestOk: true,
  });
  assert.deepEqual(readyCalls, ['Runtime.evaluate']);

  const obscured = await probeCdpCompositorInteractivity({
    async call() {
      return {
        result: {
          value: {
            frameAdvanced: true,
            interactiveTargetFound: true,
            hitTestOk: false,
          },
        },
      };
    },
  });
  assert.equal(obscured.status, 'not-interactive');
  assert.match(obscured.reason ?? '', /hit testing/u);
});

test('CDP session connection timeout rejects a stalled WebSocket upgrade', async () => {
  const server = createServer();
  let upgradedSocket: import('node:net').Socket | undefined;
  server.on('upgrade', (_request, socket) => {
    upgradedSocket = socket;
    socket.write('HTTP/1.1 101 Switching Protocols\r\n');
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  try {
    await assert.rejects(
      CdpSession.connect(`ws://127.0.0.1:${address.port}/devtools/page/stalled`, {
        timeoutMs: 100,
      }),
      /CDP connection timed out after 100ms/u,
    );
    assert(upgradedSocket, 'the server should receive the stalled WebSocket upgrade');
    const termination = await new Promise<'end' | 'close' | 'error'>((resolve, reject) => {
      if (upgradedSocket.readableEnded) return resolve('end');
      if (upgradedSocket.destroyed) return resolve('close');
      const cleanup = () => {
        clearTimeout(timer);
        upgradedSocket?.off('end', onEnd);
        upgradedSocket?.off('close', onClose);
        upgradedSocket?.off('error', onError);
      };
      const onEnd = () => {
        cleanup();
        resolve('end');
      };
      const onClose = () => {
        cleanup();
        resolve('close');
      };
      const onError = () => {
        cleanup();
        resolve('error');
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('the timed-out CDP client did not terminate its stalled handshake'));
      }, 500);
      upgradedSocket.once('end', onEnd);
      upgradedSocket.once('close', onClose);
      upgradedSocket.once('error', onError);
    });
    assert.match(termination, /^(?:end|close|error)$/u);
  } finally {
    upgradedSocket?.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('CDP JSON discovery timeout aborts a stalled HTTP response', async () => {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/json/list`;

  try {
    await assert.rejects(
      jsonGet(url, { timeoutMs: 100 }),
      new RegExp(`GET ${url} timed out after 100ms\\.`),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('CDP JSON retry does not sleep beyond its total deadline', async () => {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/json/list`;
  const startedAt = Date.now();

  try {
    await assert.rejects(
      retryJsonGet(url, { timeoutMs: 100, intervalMs: 1_000 }),
      /did not succeed within 100ms/u,
    );
    assert(
      Date.now() - startedAt < 300,
      'retryJsonGet should not sleep its retry interval after the total deadline',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('CDP compositor probe reports a frame timeout as suspended', async () => {
  const report = await probeCdpCompositorInteractivity(
    {
      async call() {
        return new Promise(() => undefined);
      },
    },
    5,
  );
  assert.equal(report.status, 'suspended');
  assert.match(report.reason ?? '', /did not advance/u);
});

test('CDP compositor probe propagates transport and evaluation failures', async () => {
  await assert.rejects(
    probeCdpCompositorInteractivity({
      async call() {
        throw new Error('WebSocket disconnected');
      },
    }),
    /WebSocket disconnected/u,
  );

  await assert.rejects(
    probeCdpCompositorInteractivity({
      async call() {
        return {
          exceptionDetails: {
            text: 'Evaluation failed',
          },
        };
      },
    }),
    /Evaluation failed/u,
  );
});

test('CDP compositor probe accepts a hittable modal control after an occluded candidate', async () => {
  let frame = 0;
  let now = 0;
  const occluded = {
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 20,
      bottom: 20,
      width: 20,
      height: 20,
    }),
    contains: () => false,
  };
  const modalControl = {
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({
      left: 30,
      top: 0,
      right: 50,
      bottom: 20,
      width: 20,
      height: 20,
    }),
    contains: () => false,
  };
  const overlay = {};
  const report = await probeCdpCompositorInteractivity({
    async call(_method, params) {
      const value = await vm.runInNewContext(String(params?.expression), {
        Promise,
        performance: { now: () => ++now },
        requestAnimationFrame: (callback: (timestamp: number) => void) => callback(++frame),
        document: {
          querySelectorAll: () => [occluded, modalControl],
          elementFromPoint: (x: number) => (x < 30 ? overlay : modalControl),
        },
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
        innerWidth: 100,
        innerHeight: 100,
      });
      return { result: { value } };
    },
  });
  assert.equal(report.status, 'ready');
  assert.equal(report.interactiveTargetFound, true);
  assert.equal(report.hitTestOk, true);
});

test('CDP compositor probe retries scuttled requestAnimationFrame access in an isolated world', async () => {
  let now = 0;
  let frame = 0;
  const target = {
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({
      left: 10,
      top: 10,
      right: 30,
      bottom: 30,
      width: 20,
      height: 20,
    }),
    contains: () => false,
  };
  const sandbox = {
    Promise,
    performance: { now: () => ++now },
    requestAnimationFrame: (callback: (timestamp: number) => void) => callback(++frame),
    document: {
      querySelectorAll: () => [target],
      elementFromPoint: () => target,
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    innerWidth: 100,
    innerHeight: 100,
  };
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

  const report = await probeCdpCompositorInteractivity({
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate' && params?.contextId === undefined) {
        return {
          exceptionDetails: {
            exception: {
              description:
                'LavaMoat - property "requestAnimationFrame" of globalThis is inaccessible under scuttling mode.',
            },
          },
        };
      }
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main-frame' } } };
      }
      if (method === 'Page.createIsolatedWorld') {
        assert.equal(params?.frameId, 'main-frame');
        assert.equal(params?.worldName, 'farmslot-compositor-probe');
        return { executionContextId: 42 };
      }
      assert.equal(method, 'Runtime.evaluate');
      assert.equal(params?.contextId, 42);
      const value = await vm.runInNewContext(String(params?.expression), sandbox);
      return { result: { value } };
    },
  });

  assert.equal(report.status, 'ready');
  assert.equal(report.frameAdvanced, true);
  assert.equal(report.interactiveTargetFound, true);
  assert.equal(report.hitTestOk, true);
  assert.deepEqual(
    calls.map(({ method }) => method),
    ['Runtime.evaluate', 'Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate'],
  );
});

test('depsCheck reports missing install markers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-deps-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"stub"}\n');
    const check = depsCheck(root);
    assert.equal(check.status, 'missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('depsCheck requires node_modules state for the node-modules linker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-deps-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"stub"}\n');
    await writeFile(path.join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
    await mkdir(path.join(root, '.yarn'), { recursive: true });
    await writeFile(path.join(root, '.yarn/install-state.gz'), 'stale install marker\n');

    const check = depsCheck(root);
    assert.equal(check.installed, false);
    assert.equal(check.status, 'missing');

    await rm(path.join(root, '.yarnrc.yml'));
    const unknownLinker = depsCheck(root);
    assert.equal(unknownLinker.installed, false);
    assert.equal(unknownLinker.status, 'missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('depsCheck uses node_modules state as the authoritative node-modules freshness marker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-deps-'));
  try {
    const lockfile = path.join(root, 'yarn.lock');
    const nodeModulesState = path.join(root, 'node_modules/.yarn-state.yml');
    const yarnInstallState = path.join(root, '.yarn/install-state.gz');
    await writeFile(path.join(root, 'package.json'), '{"name":"stub"}\n');
    await writeFile(path.join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
    await writeFile(lockfile, '# lock\n');
    await mkdir(path.dirname(nodeModulesState), { recursive: true });
    await mkdir(path.dirname(yarnInstallState), { recursive: true });
    await writeFile(nodeModulesState, 'stale node_modules\n');
    await writeFile(yarnInstallState, 'newer yarn metadata\n');

    const staleAt = new Date(Date.now() - 10_000);
    const inputAt = new Date(Date.now());
    const misleadingAt = new Date(Date.now() + 10_000);
    await utimes(nodeModulesState, staleAt, staleAt);
    await utimes(lockfile, inputAt, inputAt);
    await utimes(yarnInstallState, misleadingAt, misleadingAt);

    const check = depsCheck(root);
    assert.equal(check.status, 'stale');
    assert.equal(check.hasBaseline, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('depsCheck ignores leftover node_modules state for the pnp linker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-deps-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"stub"}\n');
    await writeFile(path.join(root, '.yarnrc.yml'), 'nodeLinker: pnp\n');
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await writeFile(path.join(root, 'node_modules/.yarn-state.yml'), 'leftover\n');

    const check = depsCheck(root);
    assert.equal(check.status, 'missing');
    assert.equal(check.installed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('depsCheck requires the pnp runtime loader, not Yarn install cache metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-deps-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"stub"}\n');
    await writeFile(path.join(root, '.yarnrc.yml'), 'nodeLinker: pnp\n');
    await mkdir(path.join(root, '.yarn'), { recursive: true });
    await writeFile(path.join(root, '.yarn/install-state.gz'), 'install cache\n');

    const missingLoader = depsCheck(root);
    assert.equal(missingLoader.installed, false);
    assert.equal(missingLoader.status, 'missing');

    await writeFile(path.join(root, '.pnp.cjs'), 'module.exports = {};\n');
    await rm(path.join(root, '.yarn/install-state.gz'));
    const installed = depsCheck(root);
    assert.equal(installed.installed, true);
    assert.equal(installed.status, 'current');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('depsCheck uses pnp install metadata only for freshness', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-deps-'));
  try {
    const lockfile = path.join(root, 'yarn.lock');
    const loader = path.join(root, '.pnp.cjs');
    const installState = path.join(root, '.yarn/install-state.gz');
    await writeFile(path.join(root, 'package.json'), '{"name":"stub"}\n');
    await writeFile(path.join(root, '.yarnrc.yml'), 'nodeLinker: pnp\n');
    await writeFile(lockfile, '# lock\n');
    await writeFile(loader, 'module.exports = {};\n');
    await mkdir(path.dirname(installState), { recursive: true });
    await writeFile(installState, 'install cache\n');

    const staleAt = new Date(Date.now() - 10_000);
    const inputAt = new Date(Date.now());
    await utimes(loader, staleAt, staleAt);
    await utimes(installState, staleAt, staleAt);
    await utimes(lockfile, inputAt, inputAt);
    assert.equal(depsCheck(root).status, 'stale');

    const installedAt = new Date(Date.now() + 5_000);
    await utimes(installState, installedAt, installedAt);
    assert.equal(depsCheck(root).status, 'current');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('depsCheck ignores legacy baselines not certified by a dependency install', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-deps-'));
  try {
    const lockfile = path.join(root, 'yarn.lock');
    const installState = path.join(root, 'node_modules/.yarn-state.yml');
    await writeFile(path.join(root, 'package.json'), '{"name":"stub"}\n');
    await writeFile(path.join(root, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
    await writeFile(lockfile, '# lock\n');
    await mkdir(path.dirname(installState), { recursive: true });
    await writeFile(installState, 'stale install\n');

    writeDecisionState(root, 'deps-state.json', { fingerprint: depsFingerprint(root) });

    const staleAt = new Date(Date.now() - 10_000);
    const inputAt = new Date(Date.now());
    await utimes(installState, staleAt, staleAt);
    await utimes(lockfile, inputAt, inputAt);

    const check = depsCheck(root);
    assert.equal(check.status, 'stale');
    assert.equal(check.hasBaseline, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('depsCheck records and compares baseline fingerprint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-deps-'));
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"stub"}\n');
    await writeFile(path.join(root, 'yarn.lock'), '# lock\n');
    await mkdir(path.join(root, 'node_modules/.yarn'), { recursive: true });
    await writeFile(path.join(root, 'node_modules/.yarn-state.yml'), 'install\n');
    recordDepsBaseline(root);
    assert.equal(depsCheck(root).status, 'current');
    await writeFile(path.join(root, 'yarn.lock'), '# lock\n# bump\n');
    const changedInputAt = new Date(Date.now() + 1_000);
    await utimes(path.join(root, 'yarn.lock'), changedInputAt, changedInputAt);
    assert.equal(depsCheck(root).status, 'stale');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('depsCheck trusts install markers newer than a stale baseline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-deps-'));
  try {
    const packageJson = path.join(root, 'package.json');
    const lockfile = path.join(root, 'yarn.lock');
    const installState = path.join(root, 'node_modules/.yarn-state.yml');
    await writeFile(packageJson, '{"name":"stub"}\n');
    await writeFile(lockfile, '# lock\n');
    await mkdir(path.dirname(installState), { recursive: true });
    await writeFile(installState, 'install\n');
    recordDepsBaseline(root);

    await writeFile(lockfile, '# lock\n# bump\n');
    const staleInstallAt = new Date(Date.now() - 10_000);
    const changedInputAt = new Date(Date.now());
    await utimes(installState, staleInstallAt, staleInstallAt);
    await utimes(lockfile, changedInputAt, changedInputAt);
    assert.equal(depsCheck(root).status, 'stale');

    const installedAt = new Date(Date.now() + 5_000);
    await utimes(installState, installedAt, installedAt);
    assert.equal(depsCheck(root).status, 'current');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('moduleExistsInNodeModules requires package.json', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-mod-'));
  try {
    await mkdir(path.join(root, 'node_modules/hollow'), { recursive: true });
    assert.equal(moduleExistsInNodeModules(root, 'hollow'), false);
    await writeFile(path.join(root, 'node_modules/hollow/package.json'), '{}\n');
    assert.equal(moduleExistsInNodeModules(root, 'hollow'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('analyzeBundleLog scopes unresolved cites after last bundle ok', () => {
  const log = [
    'error: Bundling failed',
    'Error: Unable to resolve "still-missing" from "app/old.ts"',
    'iOS Bundled 99ms index.js (1 module)',
    'error: Bundling failed',
    'SyntaxError: Unexpected token',
  ].join('\n');
  const analysis = analyzeBundleLog({
    target: '/tmp/stub',
    logText: log,
    errorPattern: /Bundling failed|Unable to resolve /u,
    okPattern: /Bundled \d+ms|iOS Bundled/u,
  });
  assert.equal(analysis.status, 'errors');
  assert.equal(analysis.reason, 'bundle-error');
});

test('supersededErrorCapture ignores stale native errors after bundle ok', () => {
  const log = [
    ' ERROR  [runtime not ready]: HybridObject "NitroFetch" - It has not yet been registered',
    'iOS Bundled 99ms index.js (1 module)',
  ].join('\n');
  const stale = supersededErrorCapture(log, {
    errorPattern: /HybridObject "([^"]+)" - It has not yet been registered/u,
    okPattern: /Bundled \d+ms|iOS Bundled/u,
  });
  assert.equal(stale, null);
});

test('orchestrateRuntimeUp installs once then relaunches', async () => {
  let decideCalls = 0;
  const reports: RuntimeDecisionReport[] = [
    { decision: 'install', reasonCode: 'deps-missing', detail: 'missing markers' },
    { decision: 'launch', reasonCode: 'metro-down', detail: 'metro not listening' },
  ];
  const installed: string[] = [];
  const launched: string[] = [];
  const result = await orchestrateRuntimeUp({
    decide: async () => {
      const report = reports[decideCalls++] ?? reports[reports.length - 1]!;
      return report;
    },
    onInstall: async () => {
      installed.push('install');
    },
    onLaunch: async (report) => {
      launched.push(report.decision);
    },
    onReady: async () => {
      throw new Error('unexpected ready');
    },
  });
  assert.deepEqual(installed, ['install']);
  assert.deepEqual(launched, ['launch']);
  assert.equal(result.exitDecision, 'launch');
});

test('orchestrateRuntimeUp fails when install does not resolve', async () => {
  await assert.rejects(
    () =>
      orchestrateRuntimeUp({
        decide: async () => ({
          decision: 'install',
          reasonCode: 'deps-missing',
          detail: 'still missing',
        }),
        onInstall: async () => {},
        onLaunch: async () => {},
        onReady: async () => {},
        installAttempted: { value: true },
      }),
    /install did not resolve runtime/,
  );
});

test('evaluatePersistentBundleError blocks on repeated excerpt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rh-bundle-'));
  try {
    const first = evaluatePersistentBundleError(root, 'SyntaxError: broken');
    assert.equal(first.blocked, false);
    const second = evaluatePersistentBundleError(root, 'SyntaxError: broken');
    assert.equal(second.blocked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
