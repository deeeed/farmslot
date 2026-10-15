import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

import { Command, CommanderError } from 'commander';

import { environment, fixture } from '../../test/helpers/project-doctor.js';
import { OutputContext } from '../output.js';

import { registerRecipeQualityCommand } from './recipe-quality.js';

const guidance = 'Require observed, claim-bound evidence before assigning a quality verdict.';

function project(t: TestContext) {
  const { root, write } = fixture(t);
  const provider = fs.readFileSync(path.join(root, 'provider.mjs'), 'utf8');
  write(
    'provider.mjs',
    provider.replace(
      'return { runtime:',
      `return { commandOptions: {recipeQuality: {
        guidance: ${JSON.stringify(guidance)},
        subcommands: {'advisor-status': () => { throw new Error('Help requested advice'); }}
      }}, runtime:`,
    ),
  );
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-help-registry-'));
  fs.symlinkSync(root, path.join(registry, 'example'), 'dir');
  t.after(() => fs.rmSync(registry, { recursive: true, force: true }));
  return { root, flags: ['--project', 'example', '--projects-dir', registry, '--target', root] };
}

async function invoke(t: TestContext, root: string, flags: string[], operation = 'build') {
  const previousEnv = process.env;
  const previousExitCode = process.exitCode;
  let output = '';
  const log = t.mock.method(console, 'log', (...args: unknown[]) => {
    output += format(...args) + '\n';
  });
  const envelope = t.mock.method(OutputContext.prototype, 'writeJson', (value: unknown) => {
    output += JSON.stringify(value);
  });
  process.env = environment(root, {});
  delete process.env.RECIPE_TASK_DIR;
  process.exitCode = 0;
  try {
    const program = new Command().name('farmslot').exitOverride();
    program.configureOutput({
      writeOut: (text) => {
        output += text;
      },
      writeErr() {},
    });
    registerRecipeQualityCommand(program.command('recipe'));
    try {
      await program.parseAsync(['recipe', 'quality', operation, ...flags, '--help'], {
        from: 'user',
      });
    } catch (error) {
      if (!(error instanceof CommanderError && error.code === 'commander.helpDisplayed'))
        throw error;
    }
    return { output, status: Number(process.exitCode ?? 0) };
  } finally {
    log.mock.restore();
    envelope.mock.restore();
    process.env = previousEnv;
    process.exitCode = previousExitCode;
  }
}

test('bare quality help shows grammar without importing a discovered provider', async (t) => {
  const f = project(t);
  const result = await invoke(t, f.root, ['--target', f.root]);
  assert.equal(result.status, 0);
  assert.match(result.output, /Validate and build the quality artifact/);
  assert.equal(fs.existsSync(`${f.root}.imported`), false);
});

for (const operation of ['build', 'advisor-status']) {
  test(`${operation} help includes declared guidance without running advice or writing artifacts`, async (t) => {
    const f = project(t);
    const result = await invoke(t, f.root, f.flags, operation);
    assert.equal(result.status, 0, result.output);
    assert.ok(result.output.includes(guidance));
    assert.equal(fs.existsSync(`${f.root}.imported`), true);
    assert.equal(fs.existsSync(path.join(f.root, 'artifacts')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.runtime')), false);
  });
}

test('public CLI quality help displays the configured project guidance', (t) => {
  const f = project(t);
  const entry = fileURLToPath(new URL('../../bin/farmslot.mjs', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [entry, 'recipe', 'quality', 'build', ...f.flags, '--help'],
    { env: environment(f.root, {}), cwd: f.root, encoding: 'utf8', timeout: 4900 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(guidance));
  assert.equal(fs.existsSync(path.join(f.root, 'artifacts')), false);
});

test('quality help rejects unknown flags before importing the provider', async (t) => {
  const f = project(t);
  await assert.rejects(invoke(t, f.root, [...f.flags, '--unsupported']), {
    code: 'commander.unknownOption',
  });
  assert.equal(fs.existsSync(`${f.root}.imported`), false);
});

test('quality help preserves an explicitly missing project refusal', async (t) => {
  const f = project(t);
  const result = await invoke(t, f.root, [...f.flags, '--project', 'missing']);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.output).error.code, 'PROJECT_NOT_FOUND');
  assert.equal(fs.existsSync(`${f.root}.imported`), false);
});

test('project quality help refuses unauthorized discovered code before import', async (t) => {
  const f = project(t);
  const emptyRegistry = path.join(f.root, 'untrusted-registry');
  fs.mkdirSync(emptyRegistry);
  const result = await invoke(t, f.root, [
    '--project',
    'example',
    '--target',
    f.root,
    '--projects-dir',
    emptyRegistry,
  ]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.output).error.code, 'PROVIDER_UNAUTHORIZED');
  assert.equal(fs.existsSync(`${f.root}.imported`), false);
});
