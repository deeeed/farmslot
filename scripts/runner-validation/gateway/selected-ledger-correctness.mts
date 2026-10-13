// Manual live tier: actual CLI/engine/transport, outside default and CI suites.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import { validateRecordedEvidencePackage } from '@farmslot/adapter-sdk/evidence';
import type { ProjectConfig } from '@farmslot/protocol';

import {
  handleRun,
  withProjectRecipeHost,
} from '../../../packages/recipe-cli/src/harness/index.js';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'selected-ledger-proof-')));
const task = path.join(root, 'temp', 'tasks', 'proof');
const artifacts = path.join(task, 'artifacts');
const recipeFile = path.join(root, 'proof.recipe.json');
const manifestFile = path.join(root, 'provider', 'actions.json');
const claim = 'The command observes one.';
const recipe = {
  $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
  title: 'Selected ledger proof',
  description: 'Assert a command output.',
  proofTargets: [{ id: 'AC-1', claim, proofMode: 'state' }],
  workflow: {
    entry: 'read',
    nodes: {
      read: {
        action: 'command',
        cmd: 'printf one',
        intent: 'Read the command output',
        next: 'assert',
      },
      assert: {
        action: 'assert_output',
        source: 'read',
        contains: 'one',
        proves: ['AC-1'],
        intent: 'Verify the observed value',
        next: 'done',
      },
      done: { action: 'end', status: 'pass' },
    },
  },
};
const json = (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
const attempts: Array<{ status: string; recipeRunId: string; durationMs: number }> = [];
const invoke = async (extra: string[] = []) => {
  const startedAt = performance.now();
  const output: string[] = [];
  const originalLog = console.log;
  const argv = [
    recipeFile,
    '--target',
    root,
    '--adapter',
    'headless',
    '--heal',
    'off',
    '--json',
    ...extra,
  ];
  console.log = (...values: unknown[]) => output.push(values.map(String).join(' '));
  try {
    const config: ProjectConfig = {
      name: 'example',
      paths: { runtimeDir: 'runtime', artifactDir: 'artifacts' },
      recipe: {
        adapter: 'headless',
        provider: { module: 'provider.mjs', root: { projectPath: 'provider' } },
      },
    };
    const code = await withProjectRecipeHost(
      {
        cwd: root,
        command: 'run',
        tokens: argv,
        projects: [{ config, root }],
        options: { target: root, actionManifest: manifestFile, json: true, heal: 'off' },
      },
      ({ engine, librarySources, signal, finalize }) =>
        handleRun(argv, {
          engine,
          librarySources,
          signal,
          beforeResult: finalize,
        }),
    );
    assert.ok([0, 1].includes(code), output.join('\n'));
    const result = JSON.parse(output.join('\n'));
    const tracePath = result.result?.tracePath ?? result.tracePath;
    assert.ok(tracePath, output.join('\n'));
    const evidence = await readRecordedEvidencePackage(path.dirname(tracePath));
    assert.ok(evidence.checks.every((check) => check.status !== 'fail'));
    assert.equal(validateRecordedEvidencePackage(evidence.input).status, 'valid');
    assert.ok(evidence.input.claims?.recipeRunId);
    attempts.push({
      status: result.status,
      recipeRunId: evidence.input.claims.recipeRunId,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  } finally {
    console.log = originalLog;
  }
};

const previousTaskDir = process.env.RECIPE_TASK_DIR;
const previousCwd = process.cwd();
try {
  process.chdir(root);
  process.env.RECIPE_TASK_DIR = path.relative(root, task);
  await mkdir(path.join(task, 'inputs'), { recursive: true });
  await mkdir(artifacts);
  await mkdir(path.join(root, 'provider'));
  await json(path.join(task, 'inputs/handoff.json'), { task: { acceptanceCriteria: [claim] } });
  await json(recipeFile, recipe);
  await writeFile(
    path.join(root, 'provider', 'provider.mjs'),
    `
export function createProvider() {
  return { runtime: {
    id: 'headless', sdkVersion: 1, headless: true,
    runtimeStatus: async () => ({ decision: 'ready', reasons: [] }),
    resolveSlotPorts() {}, logSources: () => [], appLogSource: () => null,
    devServer: {}, hints: {}, harness: {}, runtimeContext: {},
    launch: async () => { throw new Error('unexpected launch'); },
    actions: { manifestPath: () => ${JSON.stringify(manifestFile)}, semantic: [], cdpTarget: { transport: 'none' } },
  } };
}
`,
  );
  await json(manifestFile, {
    $schema: 'https://farmslot.io/schemas/action-manifest-v1.schema.json',
    actions: {
      command: {
        description: 'Read a value.',
        schema: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd'],
          additionalProperties: false,
        },
        examples: [{ action: 'command', cmd: 'true', intent: 'Read a value', next: 'done' }],
      },
      assert_output: {
        description: 'Assert output.',
        schema: {
          type: 'object',
          properties: { source: { type: 'string' }, contains: { type: 'string' } },
          required: ['source', 'contains'],
          additionalProperties: false,
        },
        examples: [
          {
            action: 'assert_output',
            source: 'read',
            contains: 'one',
            intent: 'Check the value',
            next: 'done',
          },
        ],
      },
      end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
    },
  });
  const first = await invoke();
  assert.equal(first.status, 'pass', JSON.stringify(first.error ?? first));
  const ledgerFile = path.join(artifacts, 'acceptance-status.json');
  const pointerFile = path.join(artifacts, 'latest-valid-recipe-run.json');
  const ledger = await readFile(ledgerFile);
  const pointer = await readFile(pointerFile);
  const selected = JSON.parse(ledger.toString());
  assert.equal(selected.criteria[0].verdict, 'proven');

  recipe.workflow.nodes.assert.contains = 'two';
  await json(recipeFile, recipe);
  assert.equal((await invoke()).status, 'fail');
  assert.deepEqual(await readFile(ledgerFile), ledger);
  assert.deepEqual(await readFile(pointerFile), pointer);

  recipe.workflow.nodes.assert.contains = 'one';
  await json(recipeFile, recipe);
  assert.equal((await invoke(['--artifacts-dir', 'artifacts/outside-task-proof'])).status, 'pass');
  assert.deepEqual(await readFile(ledgerFile), ledger);
  assert.deepEqual(await readFile(pointerFile), pointer);
  console.log(
    JSON.stringify({
      status: 'pass',
      recipeRunId: selected.recipeRunId,
      attempts,
      checks: [
        'passing attempt selected',
        'failed attempt preserves selected ledger',
        'unselected passing attempt preserves selected ledger',
      ],
    }),
  );
} finally {
  process.chdir(previousCwd);
  if (previousTaskDir === undefined) delete process.env.RECIPE_TASK_DIR;
  else process.env.RECIPE_TASK_DIR = previousTaskDir;
  await rm(root, { recursive: true, force: true });
}
