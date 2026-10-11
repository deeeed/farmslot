import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ProjectConfig } from '@farmslot/protocol';

import { harnessAdapters } from '../src/harness/adapters.js';
import {
  booleanOption,
  type CommandContract,
  optionalValueOption,
  valueOption,
} from '../src/harness/command-contract.js';
import { recipeConformanceIdentity } from '../src/harness/conformance.js';
import { harnessContext } from '../src/harness/context-state.js';
import { sourceSnapshot } from '../src/harness/execution-provenance.js';
import { harnessHost } from '../src/harness/host.js';
import { recipeOutputRoots } from '../src/harness/paths.js';
import { withProjectRecipeHost } from '../src/harness/project-host.js';

function fixture(t: TestContext, cleanup = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-host-')));
  if (cleanup) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'provider.mjs'),
    `
    import fs from 'node:fs';
    export function createProvider(context) {
      if (context.options.factoryLog) fs.appendFileSync(context.options.factoryLog, JSON.stringify(context.options) + '\\n');
      process.env.GOAL3_SCOPE_TEST = context.options.scope;
      return {
        runtime: {
          id: 'headless', sdkVersion: 1, headless: true,
          runtimeStatus: async () => ({decision:'ready', reasons:[]}),
          resolveSlotPorts() {}, logSources: () => [], appLogSource: () => null,
          devServer: {}, hints: {}, harness: {}, runtimeContext: {},
          launch: async () => { throw new Error('unexpected launch'); },
          actions: {manifestPath: () => '', semantic: [], cdpTarget: {transport:'none'}},
        },
        cancel: async () => {
          if (context.options.hookLog) fs.appendFileSync(context.options.hookLog, 'cancel\\n');
          if (context.options.cancelFail) throw new Error('cancellation failed');
        },
        finalize: async () => {
          if (context.options.hookLog) fs.appendFileSync(context.options.hookLog, 'finalize\\n');
          process.env.GOAL3_SCOPE_TEST = 'finalizing';
          if (context.options.finalizeFail) throw new Error('finalization failed');
        },
      };
    }
  `,
  );
  const config = {
    name: 'example',
    paths: { runtimeDir: 'runtime', artifactDir: 'artifacts' },
    recipe: { adapter: 'headless', provider: { module: 'provider.mjs' } },
  } as ProjectConfig;
  return { cwd: root, tokens: [], projects: [{ config, root }], command: 'doctor' };
}

const invocationContract: CommandContract = {
  options: {
    '--plan': booleanOption(),
    '--record-video': optionalValueOption(),
    '--target': valueOption(),
  },
  positionals: [{ label: 'recipe' }],
  minimumPositionals: 1,
};

function commandFixture(t: TestContext) {
  const options = fixture(t);
  const file = path.join(options.cwd, 'provider.mjs');
  fs.appendFileSync(
    file,
    `
    export const providerCommands = [{name:'run',example:'run smoke',contract:{options:{
      '--consent-file':{kind:'value'}, '--sandbox':{kind:'boolean'}
    }}}];
  `,
  );
  const factoryLog = path.join(options.cwd, 'artifacts/factory.jsonl');
  fs.mkdirSync(path.dirname(factoryLog));
  return { ...options, command: 'run', options: { factoryLog } };
}

test('provider grammar rejects execution typos before constructing the provider', async (t) => {
  const options = commandFixture(t);
  for (const [argv, code] of [
    [['smoke', '--plna'], 'CLI_UNKNOWN_OPTION'],
    [['smoke', '--consent-file', '--plan'], 'CLI_MISSING_OPTION_VALUE'],
  ] as const) {
    await assert.rejects(
      withProjectRecipeHost(
        {
          ...options,
          invocation: { contract: invocationContract, argv },
        },
        async () => assert.fail('Invalid command reached the handler'),
      ),
      { code },
    );
    assert.equal(fs.existsSync(options.options.factoryLog), false);
  }
});

test('provider factory and shared handler receive the same parsed domain options and bound target', async (t) => {
  const options = commandFixture(t);
  await withProjectRecipeHost(
    {
      ...options,
      options: { ...options.options, plan: true, recordVideo: true },
      invocation: {
        contract: invocationContract,
        argv: [
          'smoke',
          '--consent-file',
          'consent.json',
          '--sandbox',
          '--plan',
          '--record-video',
          '--target',
          '/tmp/unbound',
        ],
      },
    },
    async (host) => {
      assert.equal(harnessHost().name, 'farmslot recipe');
      const factory = JSON.parse(fs.readFileSync(options.options.factoryLog, 'utf8'));
      assert.equal(factory.target, options.cwd);
      assert.equal(factory.consentFile, 'consent.json');
      assert.equal(factory.sandbox, true);
      assert.equal(factory.plan, true);
      assert.equal(factory.recordVideo, 'full-run');
      assert.equal(host.cli.consentFile, factory.consentFile);
      assert.equal(host.cli.sandbox, true);
      assert.equal(host.cli.target, options.cwd);
      assert.equal(host.cli.recordVideo, 'full-run');
      assert.equal(host.invocation?.options, host.cli);
      assert.deepEqual(host.invocation?.positional, ['smoke']);
      assert.equal(host.signal, undefined);
    },
  );
});

test('read-only run modes do not acquire an execution signal', async (t) => {
  const options = fixture(t);
  for (const flag of ['plan', 'list', 'describe', 'help']) {
    await withProjectRecipeHost(
      { ...options, command: 'run', options: { [flag]: true } },
      async (host) => {
        assert.equal(host.signal, undefined);
      },
    );
  }
});

for (const cancelFail of [false, true]) {
  test(`host awaits cancellation and finalizes once when cancellation ${cancelFail ? 'fails' : 'succeeds'}`, async (t) => {
    const options = fixture(t);
    const signalOwner = new AbortController();
    const hookLog = path.join(options.cwd, 'artifacts/hooks.log');
    fs.mkdirSync(path.dirname(hookLog));
    const operation = withProjectRecipeHost(
      {
        ...options,
        command: 'run',
        signal: signalOwner.signal,
        options: { scope: 'inside', hookLog, cancelFail },
      },
      async (host) => {
        assert.equal(host.signal, signalOwner.signal);
        signalOwner.abort('SIGTERM');
        await host.finalize();
        await host.finalize();
      },
    );
    if (cancelFail) await assert.rejects(operation, /cancellation failed/u);
    else await operation;
    assert.deepEqual(fs.readFileSync(hookLog, 'utf8').trim().split('\n'), ['cancel', 'finalize']);
  });
}

test('host awaits cancellation that starts during finalization', async (t) => {
  const options = fixture(t);
  const signalOwner = new AbortController();
  const events: string[] = [];
  await withProjectRecipeHost(
    { ...options, command: 'run', signal: signalOwner.signal },
    async ({ provider, finalize }) => {
      provider.cancel = async () => {
        await Promise.resolve();
        events.push('cancelled');
      };
      provider.finalize = async () => {
        signalOwner.abort('SIGTERM');
        events.push('finalized');
      };
      await finalize();
      assert.deepEqual(events, ['finalized', 'cancelled']);
    },
  );
  assert.deepEqual(events, ['finalized', 'cancelled']);
});

test('host restores caller state after callback and finalization failures', async (t) => {
  const options = fixture(t);
  const previous = {
    env: process.env.GOAL3_SCOPE_TEST,
    runtimeDir: process.env.RECIPE_RUNTIME_DIR,
    host: harnessHost(),
    context: harnessContext(),
    adapters: harnessAdapters(),
  };
  await assert.rejects(
    withProjectRecipeHost({ ...options, options: { scope: 'inside' } }, async ({ context }) => {
      assert.equal(process.env.GOAL3_SCOPE_TEST, 'inside');
      assert.equal(harnessContext(), context);
      throw new Error('callback failed');
    }),
    /callback failed/u,
  );
  await assert.rejects(
    withProjectRecipeHost(
      { ...options, options: { scope: 'inside', finalizeFail: true } },
      async () => {},
    ),
    /finalization failed/u,
  );
  assert.equal(process.env.GOAL3_SCOPE_TEST, previous.env);
  assert.equal(process.env.RECIPE_RUNTIME_DIR, previous.runtimeDir);
  assert.deepEqual(harnessHost(), previous.host);
  assert.equal(harnessContext(), previous.context);
  assert.equal(harnessAdapters(), previous.adapters);
});

test('host preserves both invocation and finalization failures', async (t) => {
  const options = fixture(t);
  await assert.rejects(
    withProjectRecipeHost(
      {
        ...options,
        options: { finalizeFail: true },
      },
      async () => {
        throw new Error('invocation failed');
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((failure) => failure.message),
        ['invocation failed', 'finalization failed'],
      );
      return true;
    },
  );
});

test('overlapping project hosts wait for the active invocation before changing state', async (t) => {
  const options = fixture(t);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const observed: string[] = [];
  const first = withProjectRecipeHost({ ...options, options: { scope: 'first' } }, async () => {
    observed.push(process.env.GOAL3_SCOPE_TEST!);
    started();
    await gate;
    observed.push(process.env.GOAL3_SCOPE_TEST!);
  });
  await firstStarted;
  const second = withProjectRecipeHost({ ...options, options: { scope: 'second' } }, async () => {
    observed.push(process.env.GOAL3_SCOPE_TEST!);
  });
  try {
    await Promise.resolve();
    assert.deepEqual(observed, ['first']);
  } finally {
    release();
  }
  await Promise.all([first, second]);
  assert.deepEqual(observed, ['first', 'first', 'second']);
});

test('recipe runtime defaults and overrides stay separate from farm state', async (t) => {
  const previous = process.env.RECIPE_RUNTIME_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.RECIPE_RUNTIME_DIR;
    else process.env.RECIPE_RUNTIME_DIR = previous;
  });
  for (const [env, flag, expected] of [
    [undefined, undefined, 'temp/recipe/runtime'],
    ['env-runtime', undefined, 'env-runtime'],
    ['env-runtime', 'flag-runtime', 'flag-runtime'],
  ]) {
    const options = fixture(t);
    if (env === undefined) delete process.env.RECIPE_RUNTIME_DIR;
    else process.env.RECIPE_RUNTIME_DIR = env;
    const file = path.join(options.cwd, expected!, 'agentic-runtime.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ repoRoot: options.cwd, project: 'example' }));
    await withProjectRecipeHost(
      {
        ...options,
        tokens: flag ? ['--runtime-dir', flag] : [],
        options: {},
      },
      async ({ context, cli }) => {
        assert.equal(context.runtimeConfigPath, file);
        assert.equal(context.project?.runtimeDir, expected);
        assert.equal(context.project?.farmRuntimeDir, 'runtime');
        assert.equal(cli.runtimeDir, expected);
        assert.equal(process.env.RECIPE_RUNTIME_DIR, expected);
      },
    );
  }
});

test('app output exclusions use the checkout farm paths and preserve library provenance', async (t) => {
  const options = fixture(t);
  const config = options.projects[0]!.config;
  config.apps = ['apps/ui'];
  fs.mkdirSync(path.join(options.cwd, 'apps/ui'), { recursive: true });
  const library = path.join(options.cwd, 'team');
  fs.mkdirSync(library);
  config.recipe!.libraries = [{ name: 'team', source: 'team', owner: 'team' }];
  await withProjectRecipeHost(
    { ...options, tokens: ['--app', 'apps/ui'] },
    async ({ context, cli, librarySources }) => {
      const binding = context.project!;
      assert.equal(cli.artifactsDir, path.join(binding.checkoutRoot, 'artifacts'));
      const exclusions = recipeOutputRoots(context.target.value, binding);
      const before = sourceSnapshot(options.cwd, undefined, exclusions);
      for (const root of exclusions) {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'state'), 'runtime state');
      }
      assert.deepEqual(sourceSnapshot(options.cwd, undefined, exclusions), before);
      assert.deepEqual(librarySources[0]?.provenance, binding.libraries[0]?.provenance);
      fs.writeFileSync(
        path.join(options.cwd, 'implementation.mjs'),
        'export const changed = true;',
      );
      assert.notEqual(
        sourceSnapshot(options.cwd, undefined, exclusions).sourceFingerprint,
        before.sourceFingerprint,
      );
    },
  );
});

test('app runtime targeting and its config identity come from the selected app', async (t) => {
  const options = fixture(t);
  options.projects[0]!.config.apps = ['apps/ui'];
  execFileSync('git', ['init', '-q', options.cwd]);
  const app = path.join(options.cwd, 'apps/ui');
  for (const [root, slotId, watcherPort] of [
    [options.cwd, 'root-slot', 8111],
    [app, 'app-slot', 8222],
  ] as const) {
    const file = path.join(root, 'temp/recipe/runtime/agentic-runtime.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ repoRoot: root, project: 'example', slotId, watcherPort }),
    );
  }
  await withProjectRecipeHost({ ...options, tokens: ['--app', 'apps/ui'] }, async ({ context }) => {
    assert.equal(
      context.runtimeConfigPath,
      path.join(app, 'temp/recipe/runtime/agentic-runtime.json'),
    );
    assert.equal(context.slot?.value, 'app-slot');
    assert.equal(context.slot?.value && context.slot.ports.watcherPort, 8222);
  });
});

test('checkout library provenance excludes doctor output across repeated hosts', async (t) => {
  const options = fixture(t);
  execFileSync('git', ['init', '-q', options.cwd]);
  execFileSync('git', ['-C', options.cwd, 'add', '.']);
  execFileSync('git', [
    '-C',
    options.cwd,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'Fixture',
  ]);
  const invocation = { ...options, tokens: ['--library', `team=${options.cwd}`] };
  let before: unknown;
  await withProjectRecipeHost(invocation, async ({ librarySources, cli }) => {
    before = librarySources[0]!.provenance;
    assert.equal(librarySources[0]!.provenance?.dirty, false);
    fs.mkdirSync(String(cli.artifactsDir), { recursive: true });
    fs.writeFileSync(path.join(String(cli.artifactsDir), 'conformance-report.json'), '{}');
  });
  await withProjectRecipeHost(invocation, async ({ librarySources }) => {
    assert.deepEqual(librarySources[0]!.provenance, before);
  });
});

test('normalized provider runtimes retain the selected platform in report identity', async (t) => {
  const options = fixture(t);
  const providerFile = path.join(options.cwd, 'provider.mjs');
  fs.writeFileSync(
    providerFile,
    fs
      .readFileSync(providerFile, 'utf8')
      .replace(
        "id: 'headless', sdkVersion: 1, headless: true,",
        "id: 'headless', sdkVersion: 1, headless: true, targets: ['ios', 'android'],",
      ),
  );
  const targets: string[] = [];
  for (const selection of ['ios', 'android']) {
    await withProjectRecipeHost(
      { ...options, tokens: ['--adapter', selection] },
      async ({ context, engine, librarySources, cli }) => {
        assert.equal(context.adapter?.value, 'headless');
        assert.equal(cli.adapter, 'headless');
        const identity = await recipeConformanceIdentity(engine, {
          project: 'example',
          context,
          providerRoot: options.cwd,
          configurationPaths: [],
          librarySources,
          artifactsDir: path.join(options.cwd, 'artifacts'),
          recipes: [],
        });
        assert.equal(identity.selection?.adapterTarget, selection);
        targets.push(JSON.stringify(identity));
      },
    );
  }
  assert.notEqual(targets[0], targets[1]);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  test(
    `managed host awaits provider cleanup after real ${signal}`,
    { timeout: 4900, skip: process.platform === 'win32' },
    async (t) => {
      const options = fixture(t, false);
      const artifactDir = path.join(options.cwd, 'artifacts');
      fs.mkdirSync(artifactDir);
      const hookLog = path.join(artifactDir, 'hooks.log');
      const childPidPath = path.join(artifactDir, 'child.pid');
      const leaf = `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
      process.stdout.write(JSON.stringify({ready: process.pid}) + '\\n');
      setInterval(() => {}, 50);
    `;
      const driver = path.join(artifactDir, 'driver.mjs');
      fs.writeFileSync(
        driver,
        `
      import {withProjectRecipeHost} from ${JSON.stringify(new URL('../src/harness/project-host.ts', import.meta.url).href)};
      import {runOwnedRecipeProcess} from '@farmslot/recipe-runner/adapters/core';
      try {
        await withProjectRecipeHost(${JSON.stringify({ ...options, command: 'run', options: { scope: 'signal', hookLog } })}, async ({signal}) => {
          await runOwnedRecipeProcess(process.execPath, ['-e', ${JSON.stringify(leaf)}], {
            cwd: ${JSON.stringify(options.cwd)}, signal, timeoutMs: 2000,
            onOutput: (chunk) => process.stdout.write(chunk),
          });
        });
        process.exitCode = 0;
      } catch (error) {
        console.log(JSON.stringify({code: error.code, message: error.message}));
        process.exitCode = 1;
      }
    `,
      );
      const packageRoot = fileURLToPath(new URL('..', import.meta.url));
      const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
      const child = spawn(process.execPath, ['--import', 'tsx', driver], {
        cwd: packageRoot,
        env: { ...env, TSX_TSCONFIG_PATH: path.join(packageRoot, 'tsconfig.json') },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let stdout = '';
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('close', resolve);
        child.once('error', reject);
      });
      const killGroup = (pid: number): void => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      };
      t.after(async () => {
        if (child.pid && child.exitCode === null) killGroup(child.pid);
        if (fs.existsSync(childPidPath)) killGroup(Number(fs.readFileSync(childPidPath, 'utf8')));
        await exited;
        fs.rmSync(options.cwd, { recursive: true, force: true });
      });
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes('\n')) resolve();
        });
        child.once('close', () =>
          reject(new Error(`host exited before readiness: ${stderr}${stdout}`)),
        );
        child.once('error', reject);
      });
      const ready = JSON.parse(stdout.trim());
      assert.ok(ready.ready > 0, stdout);
      child.kill(signal);
      assert.equal(await exited, 1, stderr || stdout);
      assert.deepEqual(fs.readFileSync(hookLog, 'utf8').trim().split('\n'), ['cancel', 'finalize']);
      assert.equal(JSON.parse(stdout.trim().split('\n').at(-1)!).code, 'RECIPE_ABORTED');
      assert.throws(() => process.kill(ready.ready, 0), { code: 'ESRCH' });
    },
  );
}
