import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

import { Command } from 'commander';

import { registerDoctorCommand } from '../../src/commands/doctor.js';
import { OutputContext } from '../../src/output.js';

const cliConfig = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
const commandUrl = new URL('../../src/commands/doctor.ts', import.meta.url).href;
const driver = `
  import {Command} from 'commander';
  import {registerDoctorCommand} from '${commandUrl}';
  const program = new Command().name('farmslot').option('--json');
  registerDoctorCommand(program);
  await program.parseAsync(process.argv.slice(1), {from:'user'});
`;
export const manifest = JSON.parse(
  fs.readFileSync(
    new URL('../../../recipe-cli/test/fixtures/proof.action-manifest.json', import.meta.url),
    'utf8',
  ),
);

export function fixture(t: TestContext, missing = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-doctor-')));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${root}.imported`, { force: true });
  });
  const write = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(
      path.join(root, file),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };
  write('recipe-library.json', { schema_version: 1, name: 'example', platforms: ['headless'] });
  write('project.json', {
    name: 'example',
    paths: { runtime_dir: '.runtime', artifact_dir: 'artifacts' },
    recipe: { adapter: 'headless', provider: { module: 'provider.mjs' } },
  });
  const example = {
    description: 'Read the checkout.',
    execution_capabilities: ['host-read-export'],
    examples: [{ action: 'example.read', intent: 'Read the checkout.', next: 'done' }],
    schema: { type: 'object', properties: {}, additionalProperties: false },
  };
  write('manifests/headless.action-manifest.json', {
    $schema: manifest.$schema,
    actions: { 'example.read': example },
  });
  write('recipes/headless/smoke.recipe.json', {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: 'Read-only preflight',
    workflow: {
      entry: 'read',
      nodes: {
        read: { action: 'example.read', intent: 'Inspect the checkout.', next: 'done' },
        done: { action: 'end', status: 'pass' },
      },
    },
  });
  write(
    'provider.mjs',
    `
    import fs from 'node:fs';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    const root = path.dirname(fileURLToPath(import.meta.url));
    fs.writeFileSync(root + '.imported', 'yes');
    export function createProvider() {
      return { runtime: {
        id: 'headless', sdkVersion: 1, headless: true,
        runtimeStatus: async () => ({decision:'ready', reasons:[]}),
        resolveSlotPorts() {}, logSources: () => [], appLogSource: () => null,
        launch: async () => { throw new Error('doctor launched the app'); },
        devServer: {}, hints: {}, harness: {}, runtimeContext: {},
        actions: {
          manifestPath: () => path.join(root, 'manifests/headless.action-manifest.json'),
          semantic: [], cdpTarget: {transport:'none'},
          adapters: async () => ${missing ? '[]' : `[{action:'example.read', execute:async () => {throw new Error('doctor executed an action');}}]`}
        }
      }};
    }
  `,
  );
  return { root, write };
}

export function environment(root: string, overrides: Record<string, string>) {
  const env = { ...process.env };
  for (const name of [
    'FARMSLOT_ROOT',
    'FARMSLOT_POOL_DIR',
    'FARMSLOT_WORKSPACE',
    'RECIPE_RUNTIME_CONTEXT',
    'RECIPE_RUNTIME_DIR',
    'RECIPE_LIBRARY_PATH',
  ])
    delete env[name];
  return {
    ...env,
    FARMSLOT_HOME: path.join(root, 'operator-home'),
    ...overrides,
    TSX_TSCONFIG_PATH: cliConfig,
  };
}

export function runProcess(
  root: string,
  flags: string[],
  overrides: Record<string, string> = {},
  execution: { timeoutMs?: number; publicBin?: boolean } = {},
) {
  const result = spawnSync(
    process.execPath,
    [
      ...(execution.publicBin
        ? [path.join(path.dirname(cliConfig), 'bin/farmslot.mjs')]
        : ['--import', 'tsx', '--input-type=module', '-e', driver, '--']),
      '--json',
      'doctor',
      root,
      '--conformance',
      ...flags,
    ],
    {
      env: environment(root, overrides),
      cwd: path.dirname(cliConfig),
      encoding: 'utf8',
      timeout: execution.timeoutMs ?? 4900,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null, `Doctor child timed out or was interrupted: ${result.signal}`);
  return { status: result.status, envelope: JSON.parse(result.stdout) };
}

/** Exercise the public command parser/handler; one subprocess smoke retains process-level coverage. */
export async function run(
  t: TestContext,
  root: string,
  flags: string[],
  overrides: Record<string, string> = {},
  argv?: string[],
) {
  const previousEnv = process.env;
  const previousExitCode = process.exitCode;
  let output = '';
  const render = t.mock.method(OutputContext.prototype, 'writeJson', (data: unknown) => {
    output += JSON.stringify(data);
  });
  const consoleOutput = t.mock.method(console, 'log', (...args: unknown[]) => {
    output += format(...args) + '\n';
  });
  process.env = environment(root, overrides);
  process.exitCode = 0;
  try {
    const program = new Command().name('farmslot').option('--json');
    registerDoctorCommand(program);
    await program.parseAsync(argv ?? ['--json', 'doctor', root, '--conformance', ...flags], {
      from: 'user',
    });
    return { status: Number(process.exitCode ?? 0), envelope: JSON.parse(output) };
  } finally {
    render.mock.restore();
    consoleOutput.mock.restore();
    process.env = previousEnv;
    process.exitCode = previousExitCode;
  }
}
