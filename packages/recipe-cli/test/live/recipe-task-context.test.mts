// Standalone CLI proof: no device, provider turn or existing farm task is touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { retainTaskExecution } from '../../../agent-runtime/src/task-init/execution-provenance.js';
import { projectTaskExecution, withProjectRecipeHost } from '@farmslot/recipe-cli/harness';
import { readProject } from '../../src/harness/context.js';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const output = path.resolve(
  process.env.FARMSLOT_PROOF_OUT ?? path.join(repo, 'temp/recipe-task-context'),
);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-task-context-')));
const checkout = path.join(root, 'tooling');
const app = path.join(root, 'app');
const pack = path.join(root, 'projects', 'proof');
const pool = path.join(root, 'pool');
const task = path.join(checkout, 'temp/tasks/proof');
const cli = path.join(repo, 'packages/cli/bin/farmslot.mjs');
const keys = [
  'FARMSLOT_HOME',
  'FARMSLOT_ENABLE_SCRIPTED_SCENARIOS',
  'RECIPE_TASK_DIR',
  'FARMSLOT_TASK_DIR',
];
const previous = new Map(keys.map((key) => [key, process.env[key]]));
const providerRef = 'fixture-provider/provider';
try {
  for (const dir of [checkout, app, pack, pool, path.join(task, 'inputs'), output])
    fs.mkdirSync(dir, { recursive: true });
  const providers = ['0.1.0', '0.2.0'].map((version) => {
    const dir = path.join(root, version);
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'fixture-provider',
        version,
        type: 'module',
        exports: { './provider': './provider.mjs' },
        files: ['provider.mjs', 'actions.json'],
      }),
    );
    fs.copyFileSync(
      path.join(repo, 'packages/recipe-cli/test/fixtures/proof.action-manifest.json'),
      path.join(dir, 'actions.json'),
    );
    fs.writeFileSync(
      path.join(dir, 'provider.mjs'),
      `import {fileURLToPath}from'node:url';export function createProvider(){return {runtime:{
      id:'headless',sdkVersion:1,headless:true,runtimeStatus:async()=>({decision:'ready',reasons:[]}),
      resolveSlotPorts(){},logSources:()=>[],appLogSource:()=>null,devServer:{},hints:{},runtimeContext:{},
      harness:{verify:async()=>({ok:true})},actions:{manifestPath:()=>fileURLToPath(new URL('./actions.json',import.meta.url)),semantic:[],cdpTarget:{transport:'none'}}
    },commandOptions:{task:{stepGates:[]}}};}`,
    );
    return dir;
  });
  const configFile = path.join(pack, 'project.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      name: 'proof',
      paths: { runtime_dir: 'temp/runtime', artifact_dir: 'temp/tasks' },
      recipe: {
        adapter: 'headless',
        provider: {
          module: providerRef,
          package: 'fixture-provider',
          root: { env: 'FIXTURE_PROVIDER_ROOT' },
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(pool, 'local.json'),
    JSON.stringify({
      machine: 'proof',
      host: 'localhost',
      project: 'proof',
      env: { FIXTURE_PROVIDER_ROOT: providers[0] },
      slots: [{ id: 'proof', repo: checkout }],
    }),
  );
  const claim = 'Execution uses the explicitly selected application checkout.';
  fs.writeFileSync(path.join(task, 'TASK.md'), '# Disposable recipe binding proof\n');
  fs.writeFileSync(
    path.join(task, 'inputs/handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: [claim] } }),
  );
  process.env.FARMSLOT_HOME = path.join(root, 'home');
  process.env.FARMSLOT_ENABLE_SCRIPTED_SCENARIOS = '1';
  delete process.env.RECIPE_TASK_DIR;
  delete process.env.FARMSLOT_TASK_DIR;
  await withProjectRecipeHost(
    {
      cwd: checkout,
      tokens: ['--project', 'proof'],
      projects: [{ root: pack, config: readProject(configFile) }],
      slotPoolDir: pool,
      command: 'task',
    },
    async (host) => {
      retainTaskExecution(task, {
        ...(await projectTaskExecution(host, {
          executable: cli,
          packageRoot: path.join(repo, 'packages/cli'),
          distributionRoot: repo,
        })),
        reuseInstalledInputs: true,
      });
    },
  );
  const original = fs.readFileSync(path.join(task, 'artifacts/harness-provenance.json'));
  const recipe = path.join(task, 'artifacts/recipe.json');
  fs.writeFileSync(
    recipe,
    JSON.stringify({
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Separate app checkout',
      description: claim,
      proofTargets: [{ id: 'AC1', claim }],
      workflow: {
        entry: 'cwd',
        nodes: {
          cwd: {
            action: 'command',
            cmd: 'pwd',
            intent: 'Read the real execution directory.',
            next: 'check',
          },
          check: {
            action: 'assert_output',
            source: 'cwd',
            assert: { path: '$.stdout', operator: 'contains', value: app },
            intent: claim,
            proves: ['AC1'],
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    }),
  );
  const runs = [];
  for (const variable of ['RECIPE_TASK_DIR', 'FARMSLOT_TASK_DIR']) {
    const env = {
      ...process.env,
      FARMSLOT_PROJECTS_DIR: path.dirname(pack),
      FARMSLOT_POOL_DIR: pool,
      FIXTURE_PROVIDER_ROOT: providers[1],
      [variable]: task,
    };
    delete env[variable === 'RECIPE_TASK_DIR' ? 'FARMSLOT_TASK_DIR' : 'RECIPE_TASK_DIR'];
    delete env.FARMSLOT_ROOT;
    delete env.RECIPE_RUNTIME_CONTEXT;
    const args = [
      cli,
      'recipe',
      'run',
      recipe,
      '--project',
      'proof',
      '--target',
      app,
      '--authorize-provider',
      providerRef,
      '--heal',
      'off',
      '--json',
    ];
    if (variable === 'FARMSLOT_TASK_DIR')
      args.push('--artifacts-dir', path.join(task, 'artifacts/recipe-runs/explicit'));
    const result = spawnSync(process.execPath, args, {
      cwd: checkout,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    fs.writeFileSync(path.join(output, variable + '.stdout'), result.stdout);
    fs.writeFileSync(path.join(output, variable + '.stderr'), result.stderr);
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    assert.equal(response.status, 'pass');
    const ledger = JSON.parse(
      fs.readFileSync(path.join(task, 'artifacts/acceptance-status.json'), 'utf8'),
    );
    assert.equal(ledger.criteria[0].id, 'AC-1');
    assert.equal(ledger.criteria[0].verdict, 'proven');
    const selected = JSON.parse(
      fs.readFileSync(path.join(task, 'artifacts/latest-valid-recipe-run.json'), 'utf8'),
    );
    const provider = JSON.parse(
      fs.readFileSync(path.join(task, 'artifacts/provider-execution.json'), 'utf8'),
    );
    assert.equal(provider.provider.version, '0.2.0');
    assert.equal(provider.provider.root, providers[1]);
    assert.deepEqual(
      fs.readFileSync(path.join(task, 'artifacts/harness-provenance.json')),
      original,
    );
    runs.push({
      variable,
      status: response.status,
      criterion: ledger.criteria[0].verdict,
      selected: selected.relativeArtifactRoot,
      provider: provider.provider.version,
    });
  }
  // A provider action must recheck the same source identity after writing run outputs.
  const local = path.join(root, 'local-provider');
  const localPack = path.join(root, 'projects', 'local-proof');
  fs.mkdirSync(local);
  fs.mkdirSync(localPack);
  fs.writeFileSync(
    path.join(local, 'package.json'),
    JSON.stringify({
      name: 'fixture-provider',
      version: '0.3.0',
      type: 'module',
      exports: { './provider': './provider.mjs' },
    }),
  );
  fs.writeFileSync(
    path.join(local, 'provider.mjs'),
    fs
      .readFileSync(path.join(providers[1]!, 'provider.mjs'), 'utf8')
      .replace(
        'semantic:[],',
        "semantic:['example.ping'],adapters:async()=>[{action:'example.ping',execute:async()=>({output:{pong:true}})}],",
      ),
  );
  const localManifest = JSON.parse(
    fs.readFileSync(path.join(providers[1]!, 'actions.json'), 'utf8'),
  );
  localManifest.actions['example.ping'] = {
    description: 'Read provider state.',
    execution_capabilities: ['host-read-export'],
    examples: [{ action: 'example.ping', intent: 'Read provider state.', next: 'done' }],
    schema: { type: 'object', properties: {}, additionalProperties: false },
  };
  fs.writeFileSync(path.join(local, 'actions.json'), JSON.stringify(localManifest));
  const localConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  localConfig.name = 'local-proof';
  fs.writeFileSync(path.join(localPack, 'project.json'), JSON.stringify(localConfig));
  const localRecipe = path.join(root, 'provider-action.recipe.json');
  fs.writeFileSync(
    localRecipe,
    JSON.stringify({
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Provider source integrity',
      description: 'Execute after writing explicit run outputs.',
      workflow: {
        entry: 'ping',
        nodes: {
          ping: { action: 'example.ping', intent: 'Read provider state.', next: 'done' },
          done: { action: 'end', status: 'pass' },
        },
      },
    }),
  );
  const localResult = spawnSync(
    process.execPath,
    [
      cli,
      'recipe',
      'run',
      localRecipe,
      '--project',
      'local-proof',
      '--target',
      local,
      '--authorize-provider',
      providerRef,
      '--artifacts-dir',
      path.join(local, 'execution-output'),
      '--heal',
      'off',
      '--json',
    ],
    {
      cwd: local,
      env: {
        ...process.env,
        FARMSLOT_PROJECTS_DIR: path.dirname(pack),
        FARMSLOT_POOL_DIR: pool,
        FIXTURE_PROVIDER_ROOT: local,
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  fs.writeFileSync(path.join(output, 'provider-action.stdout'), localResult.stdout);
  fs.writeFileSync(path.join(output, 'provider-action.stderr'), localResult.stderr);
  assert.equal(localResult.status, 0, localResult.stderr);
  const localResponse = JSON.parse(localResult.stdout.slice(localResult.stdout.indexOf('{')));
  assert.equal(localResponse.status, 'pass');
  fs.cpSync(path.join(local, 'execution-output'), path.join(output, 'provider-action'), {
    recursive: true,
  });
  fs.cpSync(task, path.join(output, 'task'), { recursive: true });
  fs.writeFileSync(
    path.join(output, 'PASS.json'),
    JSON.stringify(
      {
        pass: true,
        runs,
        originalReceiptUnchanged: true,
        providerActionWithExplicitOutputs: localResponse.status,
        actualCli: true,
        realEngine: true,
        liveFarmActions: 0,
        providerTurns: 0,
      },
      null,
      2,
    ),
  );
} finally {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
}
