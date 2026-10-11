import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const driver = `
  import { Command } from 'commander';
  import { registerRecipeCommand } from '${new URL('./recipe.ts', import.meta.url).href}';
  const program = new Command().name('farmslot').option('--json');
  registerRecipeCommand(program);
  await program.parseAsync(process.argv.slice(1), {from:'user'});
`;

function discovery(t: TestContext, flags: string[]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-actions-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'project.json'),
    JSON.stringify({
      name: 'example',
      recipe: { adapter: 'headless', provider: { module: 'provider.mjs' } },
    }),
  );
  fs.writeFileSync(path.join(root, 'provider.mjs'), "throw new Error('unapproved import');");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, FARMSLOT_HOME: root };
  for (const name of [
    'FARMSLOT_ROOT',
    'FARMSLOT_POOL_DIR',
    'FARMSLOT_WORKSPACE',
    'RECIPE_RUNTIME_CONTEXT',
    'RECIPE_RUNTIME_DIR',
    'RECIPE_LIBRARY_PATH',
  ])
    delete env[name];
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      driver,
      '--',
      '--json',
      'recipe',
      'actions',
      '--target',
      root,
      ...flags,
    ],
    {
      cwd: packageRoot,
      env: { ...env, TSX_TSCONFIG_PATH: path.join(packageRoot, 'tsconfig.json') },
      encoding: 'utf8',
      timeout: 4900,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(path.join(root, '.agent')), false);
  return JSON.parse(result.stdout);
}

test('public recipe actions refuses discovered executable code before import', (t) => {
  const result = discovery(t, []);
  assert.equal(result.error.code, 'PROVIDER_UNAUTHORIZED');
});

test('public recipe actions refuses an invalid explicit slot before provider import', (t) => {
  const result = discovery(t, ['--slot', 'missing-slot']);
  assert.equal(result.error.code, 'SLOT_NOT_FOUND');
});

function callFixture(t: TestContext, cleanup = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-call-')));
  if (cleanup) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pack = path.join(root, 'projects/example');
  fs.mkdirSync(pack, { recursive: true });
  fs.mkdirSync(path.join(root, 'artifacts'));
  fs.writeFileSync(
    path.join(pack, 'project.json'),
    JSON.stringify({
      name: 'example',
      paths: { runtimeDir: 'runtime', artifactDir: 'artifacts' },
      recipe: { adapter: 'headless', provider: { module: 'provider.mjs' } },
    }),
  );
  fs.writeFileSync(
    path.join(pack, 'manifest.json'),
    JSON.stringify({
      $schema: 'https://farmslot.io/schemas/action-manifest-v1.schema.json',
      actions: {
        command: {
          description: 'Execute an operator command.',
          schema: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd'],
            additionalProperties: false,
          },
          examples: [
            {
              action: 'command',
              cmd: 'printf checked',
              intent: 'Read a command result',
              next: 'done',
            },
          ],
        },
        end: { description: 'Finish execution.', examples: [{ action: 'end', status: 'pass' }] },
      },
    }),
  );
  fs.writeFileSync(
    path.join(pack, 'provider.mjs'),
    `
    import fs from 'node:fs';
    export const providerCommands = ['call','run'].map(name => ({name,example:name+' command',contract:{options:{
      '--sandbox':{kind:'boolean'}, '--consent-file':{kind:'value'}, '--finalize-fail':{kind:'boolean'}
    }}}));
    export function createProvider(context) {
      const log = context.target.value + '/artifacts/factory.json';
      fs.writeFileSync(log, JSON.stringify(context.options));
      return {
        runtime: {
          id: 'headless', sdkVersion: 1, headless: true,
          runtimeStatus: async () => ({decision:'ready', reasons:[]}),
          resolveSlotPorts() {}, logSources: () => [], appLogSource: () => null,
          devServer: {}, hints: {launch:'unused',relaunch:'unused',runtimeProbeRecovery:()=>''},
          harness: {}, runtimeContext: {forbiddenFields:[]}, launch: async () => 0,
          actions: {manifestPath: () => new URL('./manifest.json', import.meta.url).pathname, semantic: [], cdpTarget: {transport:'none'}},
        },
        cancel: async () => {
          fs.appendFileSync(context.target.value + '/artifacts/hooks.log', 'cancel\\n');
        },
        finalize: async () => {
          fs.appendFileSync(context.target.value + '/artifacts/hooks.log', 'finalize\\n');
          fs.writeFileSync(context.target.value + '/artifacts/finalized', 'yes');
          if (context.options.finalizeFail) throw new Error('finalization failed');
        },
      };
    }
  `,
  );
  return root;
}

function publicCall(root: string, args: string[], operation: 'call' | 'run' = 'call') {
  const env = {
    ...process.env,
    FARMSLOT_HOME: root,
    FARMSLOT_POOL_DIR: path.join(root, 'no-pool'),
    TSX_TSCONFIG_PATH: path.join(packageRoot, 'tsconfig.json'),
  };
  return {
    args: [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      driver,
      '--',
      '--json',
      'recipe',
      operation,
      ...args,
      '--target',
      root,
      '--projects-dir',
      path.join(root, 'projects'),
      '--project',
      'example',
    ],
    options: {
      cwd: packageRoot,
      env,
      encoding: 'utf8' as const,
    },
  };
}

function standaloneRun(root: string, file: string) {
  const command = publicCall(root, [file], 'run');
  command.args = command.args.slice(0, command.args.indexOf('--target'));
  command.args.push(
    '--artifacts-dir',
    path.join(root, 'artifacts'),
    '--action-manifest',
    path.join(root, 'projects/example/manifest.json'),
  );
  return command;
}

function callPublic(root: string, args: string[], operation: 'call' | 'run' = 'call') {
  const command = publicCall(root, args, operation);
  const result = spawnSync(process.execPath, command.args, { ...command.options, timeout: 4900 });
  assert.ifError(result.error);
  return result;
}

test('public call rejects unknown flags before provider construction', (t) => {
  const root = callFixture(t);
  const result = callPublic(root, ['command', 'cmd=printf unsafe', '--plna']);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).error.code, 'CLI_UNKNOWN_OPTION');
  assert.equal(fs.existsSync(path.join(root, 'artifacts/factory.json')), false);
});

test('public call executes through the bound provider and finalizes before success', (t) => {
  const root = callFixture(t);
  const result = callPublic(root, [
    'command',
    'cmd=printf checked > artifacts/effect',
    '--sandbox',
    '--consent-file',
    'reviewed.json',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, 'pass');
  assert.equal(fs.readFileSync(path.join(root, 'artifacts/effect'), 'utf8'), 'checked');
  assert.equal(fs.readFileSync(path.join(root, 'artifacts/finalized'), 'utf8'), 'yes');
  const factory = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/factory.json'), 'utf8'));
  assert.equal(factory.sandbox, true);
  assert.equal(factory.consentFile, 'reviewed.json');
});

test('public call emits one failure when provider finalization fails', (t) => {
  const root = callFixture(t);
  const result = callPublic(root, [
    'command',
    'cmd=printf checked > artifacts/effect',
    '--finalize-fail',
  ]);
  assert.notEqual(result.status, 0, result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'error');
  assert.match(output.error.message, /finalization failed/u);
  assert.equal(fs.readFileSync(path.join(root, 'artifacts/effect'), 'utf8'), 'checked');
});

for (const { signal, standalone } of [
  { signal: 'SIGINT', standalone: false },
  { signal: 'SIGTERM', standalone: false },
  { signal: 'SIGHUP', standalone: false },
  { signal: 'SIGTERM', standalone: true },
] as const) {
  test(
    `public ${standalone ? 'standalone run' : 'call'} cleans its command child after ${signal}`,
    { skip: process.platform === 'win32' },
    async (t) => {
      const root = callFixture(t, false);
      const ready = path.join(root, 'artifacts/child.json');
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const childScript = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid}));setInterval(()=>{},50)`;
      const cmd = `exec ${quote(process.execPath)} -e ${quote(childScript)}`;
      let command = publicCall(root, ['command', `cmd=${cmd}`]);
      if (standalone) {
        const file = path.join(root, 'interrupt.recipe.json');
        fs.writeFileSync(
          file,
          JSON.stringify({
            $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
            description: 'Observe standalone command cancellation.',
            workflow: {
              entry: 'child',
              nodes: {
                child: {
                  action: 'command',
                  cmd,
                  intent: 'Run an owned child until interrupted',
                  next: 'done',
                },
                done: { action: 'end', status: 'pass' },
              },
            },
          }),
        );
        command = standaloneRun(root, file);
      }
      const host = spawn(process.execPath, command.args, command.options);
      let stdout = '';
      let stderr = '';
      host.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      host.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        host.once('error', reject);
        host.once('close', resolve);
      });
      const deadline = Date.now() + 4500;
      let childPid: number | undefined;
      t.after(async () => {
        host.kill('SIGTERM');
        const force = setTimeout(() => host.kill('SIGKILL'), 300);
        try {
          await exited;
        } finally {
          clearTimeout(force);
          if (childPid !== undefined) {
            try {
              process.kill(childPid, 'SIGKILL');
            } catch (error) {
              assert.equal(
                (error as NodeJS.ErrnoException).code,
                'ESRCH',
                'Owned child cleanup failed',
              );
            }
          }
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
      while (
        !fs.existsSync(ready) &&
        host.exitCode === null &&
        host.signalCode === null &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      assert.ok(fs.existsSync(ready), stdout + stderr);
      childPid = JSON.parse(fs.readFileSync(ready, 'utf8')).pid;
      host.kill(signal);
      const ceiling = setTimeout(() => host.kill('SIGKILL'), Math.max(1, deadline - Date.now()));
      let status: number | null;
      try {
        status = await exited;
      } finally {
        clearTimeout(ceiling);
      }
      assert.notEqual(status, 0, stdout);
      assert.equal(host.signalCode, null, stderr);
      const output = JSON.parse(stdout);
      if (standalone) {
        assert.equal(output.data.status, 'fail');
        const trace = fs.readFileSync(output.data.tracePath, 'utf8');
        assert.match(trace, /RECIPE_ABORTED/u);
        assert.equal(fs.existsSync(path.join(root, 'artifacts/factory.json')), false);
      } else {
        assert.equal(output.status, 'fail');
        assert.deepEqual(
          fs.readFileSync(path.join(root, 'artifacts/hooks.log'), 'utf8').trim().split('\n'),
          ['cancel', 'finalize'],
        );
      }
      assert.throws(() => process.kill(childPid!, 0), { code: 'ESRCH' });
      childPid = undefined;
    },
  );
}

function runFixture(t: TestContext) {
  const root = callFixture(t);
  const file = path.join(root, 'recipe.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      description: 'Observe explicit execution and read-only planning.',
      workflow: {
        entry: 'effect',
        nodes: {
          effect: {
            action: 'command',
            intent: 'Write an observable result',
            cmd: 'printf checked > artifacts/effect',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    }),
  );
  return { root, file };
}

test('public project run executes with bound manifests and artifact defaults', (t) => {
  const { root, file } = runFixture(t);
  const result = callPublic(root, [file], 'run');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, 'pass');
  assert.equal(fs.readFileSync(path.join(root, 'artifacts/effect'), 'utf8'), 'checked');
  assert.equal(fs.readFileSync(path.join(root, 'artifacts/finalized'), 'utf8'), 'yes');
});

test('public project run plans without executing a command', (t) => {
  const { root, file } = runFixture(t);
  const result = callPublic(root, [file, '--plan'], 'run');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.status, 'pass');
  assert.equal(fs.existsSync(path.join(root, 'artifacts/effect')), false);
});

test('public run JSONL reports finalizer failure once after the command effect', (t) => {
  const { root, file } = runFixture(t);
  const result = callPublic(root, [file, '--json-stream', '--finalize-fail'], 'run');
  assert.notEqual(result.status, 0, result.stdout);
  const events = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.event === 'complete').length, 1);
  assert.equal(events.filter((event) => event.event === 'error').length, 1);
  assert.equal(events.at(-1).status, 'fail');
  assert.equal(result.status, events.at(-1).exitCode);
  assert.equal(fs.readFileSync(path.join(root, 'artifacts/effect'), 'utf8'), 'checked');
});

test('public run JSONL refuses a misspelled plan flag before constructing a provider', (t) => {
  const { root, file } = runFixture(t);
  const result = callPublic(root, [file, '--json-stream', '--plna'], 'run');
  assert.notEqual(result.status, 0);
  const events = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.event === 'complete').length, 1);
  assert.equal(events.at(-1).status, 'fail');
  assert.equal(result.status, events.at(-1).exitCode);
  assert.equal(fs.existsSync(path.join(root, 'artifacts/factory.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'artifacts/effect')), false);
});

test('standalone execution refuses project-only preview flags before any command', (t) => {
  const { root, file } = runFixture(t);
  const result = callPublic(root, [file, '--project-root', root, '--plan'], 'run');
  assert.notEqual(result.status, 0);
  assert.equal(JSON.parse(result.stdout).error.code, 'CLI_UNKNOWN_OPTION');
  assert.equal(fs.existsSync(path.join(root, 'artifacts/effect')), false);
});

function declaredLibraryFixture(t: TestContext) {
  const { root, file } = runFixture(t);
  const library = path.join(root, 'team-library');
  fs.mkdirSync(path.join(library, 'recipes'), { recursive: true });
  fs.copyFileSync(file, path.join(library, 'recipes/library-only.recipe.json'));
  const projectFile = path.join(root, 'projects/example/project.json');
  const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  project.recipe.libraries = [
    { name: 'team', source: { projectPath: 'team-library' }, owner: 'example' },
  ];
  fs.writeFileSync(projectFile, JSON.stringify(project));
  return root;
}

test('public run executes a recipe found only in its declared library', (t) => {
  const root = declaredLibraryFixture(t);
  const result = callPublic(root, ['library-only'], 'run');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(path.join(root, 'artifacts/effect'), 'utf8'), 'checked');
  const output = JSON.parse(result.stdout);
  const summary = JSON.parse(fs.readFileSync(output.result.summaryPath, 'utf8'));
  assert.ok(
    summary.recipeLibraries.sources.some((source: { name: string }) => source.name === 'team'),
  );
});

for (const flag of ['--list', '--describe'] as const) {
  test(`public run ${flag} uses the declared library`, (t) => {
    const root = declaredLibraryFixture(t);
    const result = callPublic(root, flag === '--list' ? [flag] : ['library-only', flag], 'run');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /library-only/u);
    assert.equal(fs.existsSync(path.join(root, 'artifacts/effect')), false);
  });
}

test('original manifest/artifact invocation preserves the default root and result envelope', (t) => {
  const { root, file } = runFixture(t);
  const recipe = JSON.parse(fs.readFileSync(file, 'utf8'));
  recipe.workflow.nodes.effect.cmd = 'pwd';
  fs.writeFileSync(file, JSON.stringify(recipe));
  const command = standaloneRun(root, file);
  const result = spawnSync(process.execPath, command.args, { ...command.options, timeout: 4900 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'ok');
  assert.equal(output.data.status, 'pass');
  const trace = JSON.parse(fs.readFileSync(output.data.tracePath, 'utf8'));
  const entries = Array.isArray(trace) ? trace : trace.entries;
  assert.equal(entries[0].output.stdout.trim(), fs.realpathSync(packageRoot));
});

for (const stream of [false, true]) {
  test(`public run keeps one ${stream ? 'JSONL terminal' : 'JSON result'} when refusal and finalization both fail`, (t) => {
    const { root, file } = runFixture(t);
    const result = callPublic(
      root,
      [
        file,
        '--source-trust',
        'untrusted',
        '--source-kind',
        'task',
        '--finalize-fail',
        ...(stream ? ['--json-stream'] : []),
      ],
      'run',
    );
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(root, 'artifacts/effect')), false);
    assert.equal(fs.readFileSync(path.join(root, 'artifacts/finalized'), 'utf8'), 'yes');
    if (stream) {
      const events = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(events.filter((event) => event.event === 'complete').length, 1);
      assert.equal(events.at(-1).status, 'fail');
      assert.equal(events.at(-1).exitCode, result.status);
      assert.ok(events.some((event) => event.error?.code === 'RECIPE_TRUST_REQUIRED'));
      assert.ok(events.some((event) => event.error?.message === 'finalization failed'));
    } else {
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'error');
      assert.match(output.error.message, /finalization failed/u);
      assert.match(result.stderr, /RECIPE_TRUST_REQUIRED/u);
    }
  });
}
