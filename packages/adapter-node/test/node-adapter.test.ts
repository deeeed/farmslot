import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  type AdapterLaunchContext,
  createAdapterRegistry,
  type PlatformAdapter,
} from '@farmslot/adapter-sdk';

import {
  createNodeAdapter,
  HEADLESS_FORBIDDEN_FIELDS,
  type NodeAdapterConfig,
  yarnInstallCommand,
} from '../src/index.js';

const BASE: NodeAdapterConfig = {
  id: 'core',
  hints: {
    launch: 'host run <recipe>',
    relaunch: 'host verify',
    runtimeProbeRecovery: (target) => `host verify --target ${target}`,
  },
  actions: {
    manifestPath: () => '/manifests/core.json',
    semantic: [],
    cdpTarget: { transport: 'none', probePath: 'json/version' },
  },
  harness: {
    install: { entry: 'inject.sh', fallback: 'inject.sh' },
    cleanup: { entry: 'cleanup.sh', fallback: 'cleanup.sh' },
    verify: () => ({ error: 'not installed' }),
  },
};

function checkout(files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-node-surface-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

async function launchUsage(adapter: PlatformAdapter): Promise<[string, string]> {
  let args: [string, string] = ['', ''];
  const code = await adapter.launch({
    usage(message: string, userAction: string) {
      args = [message, userAction];
      return 2;
    },
  } as unknown as AdapterLaunchContext);
  assert.equal(code, 2);
  return args;
}

test('defaults: headless, no ports, logs, dev server or launch', async () => {
  const adapter = createNodeAdapter(BASE);
  assert.equal(adapter.id, 'core');
  assert.equal(adapter.sdkVersion, 1);
  assert.equal(adapter.headless, true);
  assert.equal(adapter.resolveSlotPorts('/x'), undefined);
  assert.deepEqual(adapter.logSources('/x'), []);
  assert.equal(adapter.appLogSource('/x'), null);
  assert.equal(adapter.devServer.label, 'dev-server');
  assert.equal(adapter.devServer.describe(), 'no dev server (headless)');
  assert.deepEqual(adapter.devServer.stop('/x'), {
    kind: 'headless',
    message: 'core is headless; no dev server runs for a core checkout',
    userAction: 'host verify',
  });
  assert.deepEqual(await launchUsage(adapter), [
    'core is headless; there is nothing to launch.',
    'host verify',
  ]);
  assert.deepEqual(adapter.runtimeContext, { forbiddenFields: HEADLESS_FORBIDDEN_FIELDS });
  assert.equal(adapter.detect, undefined);
  assert.equal(adapter.actions, BASE.actions);
  assert.equal(adapter.harness, BASE.harness);

  const registry = createAdapterRegistry();
  registry.register(adapter);
  assert.deepEqual(registry.list(), ['core']);
});

test('runtimeStatus reports dependency presence in the host wording', async () => {
  const adapter = createNodeAdapter({
    ...BASE,
    wording: { ready: 'Ready. Run recipes.', notReady: 'Not installed.' },
  });
  const empty = checkout();
  assert.deepEqual(await adapter.runtimeStatus(empty), {
    decision: 'install',
    reasonCode: 'deps-missing',
    reasons: ['Not installed.'],
    nextAction: yarnInstallCommand(empty),
    deps: 'missing',
  });

  const installed = checkout({ 'package.json': '{}', 'yarn.lock': '' });
  const marker = path.join(installed, 'node_modules/.yarn-state.yml');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, '');
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(marker, later, later);
  assert.deepEqual(await adapter.runtimeStatus(installed), {
    decision: 'ready',
    reasonCode: 'deps-present',
    reasons: ['Ready. Run recipes.'],
    nextAction: undefined,
    deps: 'current',
  });
});

test('runtimeStatus is not ready when the actions cannot find their runtime', async () => {
  let runner: string | null = null;
  const adapter = createNodeAdapter({
    ...BASE,
    wording: { ready: 'Ready.', notReady: 'Not ready.' },
    dependencies: { bins: ['tsx'], resolveBin: () => runner },
  });
  const installed = checkout({ 'package.json': '{}', 'yarn.lock': '' });
  const marker = path.join(installed, 'node_modules/.yarn-state.yml');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, '');
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(marker, later, later);

  // Installed but no tsx anywhere: doctor must say so, as run and call would refuse.
  assert.deepEqual(await adapter.runtimeStatus(installed), {
    decision: 'install',
    reasonCode: 'deps-incomplete',
    reasons: [
      'Not ready.',
      'core dependencies are incomplete (no tsx runtime found for the checkout).',
    ],
    nextAction: yarnInstallCommand(installed),
    deps: 'current',
  });
  assert.equal((await adapter.run?.dependencyBlock?.(installed, {}))?.code, 'CORE_DEPS_INCOMPLETE');

  runner = '/harness/node_modules/.bin/tsx';
  assert.equal((await adapter.runtimeStatus(installed)).decision, 'ready');
  assert.equal(await adapter.run?.dependencyBlock?.(installed, {}), null);
});

test('host overrides reach the surface', async () => {
  const detect = { files: (target: string) => target.endsWith('core') };
  const violationUserAction = () => 'fund the wallet';
  const adapter = createNodeAdapter({
    ...BASE,
    detect,
    wording: {
      devServerStop: { message: 'nothing runs', userAction: 'host run' },
      launch: { message: 'nothing to launch', userAction: 'host doctor' },
    },
    runtimeContext: { forbiddenFields: ['cdpPort'] },
    installCommand: (target) => `install ${target}`,
    run: { violationUserAction },
  });
  assert.equal(adapter.detect, detect);
  assert.deepEqual(adapter.devServer.stop('/x'), {
    kind: 'headless',
    message: 'nothing runs',
    userAction: 'host run',
  });
  assert.deepEqual(await launchUsage(adapter), ['nothing to launch', 'host doctor']);
  assert.deepEqual(adapter.runtimeContext, { forbiddenFields: ['cdpPort'] });
  assert.equal(adapter.run?.violationUserAction, violationUserAction);
  const empty = checkout();
  assert.equal((await adapter.runtimeStatus(empty)).nextAction, `install ${empty}`);
  assert.equal((await adapter.run?.dependencyBlock?.(empty, {}))?.userAction, `install ${empty}`);
});

test('run.dependencyBlock checks the host runtime deps when the run needs them', async () => {
  const seen: unknown[] = [];
  const adapter = createNodeAdapter({
    ...BASE,
    dependencies: {
      runtimeDeps: ['immer-absent'],
      requiredFor: (_target, use) => {
        seen.push(use.action);
        return use.action?.startsWith('acme.') ?? false;
      },
    },
  });
  const root = checkout({ 'node_modules/.bin/tsx': '' });
  assert.equal(await adapter.run?.dependencyBlock?.(root, { action: 'wait' }), null);
  assert.deepEqual(await adapter.run?.dependencyBlock?.(root, { action: 'acme.read' }), {
    code: 'CORE_DEPS_INCOMPLETE',
    message:
      'core dependencies are incomplete (cannot resolve immer-absent from the target checkout).',
    userAction: yarnInstallCommand(root),
  });
  assert.deepEqual(seen, ['wait', 'acme.read']);

  const host = async () => null;
  assert.equal(
    createNodeAdapter({ ...BASE, run: { dependencyBlock: host } }).run?.dependencyBlock,
    host,
  );
});

test('workspacePackages wire tsx live scripts unless the host set its own', async () => {
  const root = checkout({ 'packages/messenger/src/index.ts': '' });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-node-surface-tmp-'));
  const adapter = createNodeAdapter({
    ...BASE,
    workspacePackages: { '@acme/messenger': 'packages/messenger' },
  });
  const env = await adapter.actions.tsxLiveScripts?.env(root, temp);
  assert.equal(env?.TSX_TSCONFIG_PATH, path.join(temp, 'core-adapter.tsconfig.json'));
  assert.equal(adapter.actions.manifestPath(), '/manifests/core.json');

  const own = { env: async () => ({ OWN: '1' }) };
  const hosted = createNodeAdapter({
    ...BASE,
    actions: { ...BASE.actions, tsxLiveScripts: own },
    workspacePackages: { '@acme/messenger': 'packages/messenger' },
  });
  assert.equal(hosted.actions.tsxLiveScripts, own);
  assert.equal(createNodeAdapter(BASE).actions.tsxLiveScripts, undefined);
});

test('a host extends the adapter by spreading it', () => {
  interface HostAdapter extends PlatformAdapter {
    readiness: { mode(): string };
  }
  const registry = createAdapterRegistry<HostAdapter>();
  registry.register({ ...createNodeAdapter(BASE), readiness: { mode: () => 'headless' } });
  assert.equal(registry.get('core').readiness.mode(), 'headless');
  assert.equal(registry.get('core').headless, true);
});
