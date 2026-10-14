#!/usr/bin/env tsx
/** Manual cutover proof through the checkout CLI and task's own terminal command. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRecordedEvidencePackage } from '@farmslot/adapter-sdk';
import { createRecipeRunner, createStandardCoreAdapters } from '@farmslot/recipe-runner';
import { recordRecipeAcceptance } from '../packages/recipe-cli/src/harness/acceptance-ledger.js';

const source = fileURLToPath(new URL('../', import.meta.url));
const agent = path.join(source, 'packages/agent-runtime/bin/farmslot-agent.mjs');
const cli = path.join(source, 'packages/cli/bin/farmslot.mjs');
const require = createRequire(import.meta.url);
const {
  enumerateChecklistCheckboxes,
} = require('@farmslot/agent-runtime/scripts/checklist-target.cjs');
const {
  recordRecipeAttemptSelection,
} = require('@farmslot/agent-runtime/scripts/retained-recipe-attempt.cjs');
export const criteria = [
  'The command exits successfully.',
  'The observed output names the checked file.',
  'The file retains the expected observation.',
];
function invoke(args: string[], expected = 0) {
  const result = spawnSync(process.execPath, args, {
    cwd: source,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, expected, `${args[1]}: ${result.stderr}\n${result.stdout}`);
  return result;
}
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};

export async function proveLedgerCutover(taskDir: string, projectRoot: string) {
  invoke([
    agent,
    'task',
    'init',
    taskDir,
    '--flow',
    'ci-fix',
    '--platform',
    'cli',
    '--template',
    'ci-fix/default',
    '--project-worker',
    path.join(source, 'templates/worker'),
    '--title',
    'Engine ledger cutover',
    '--task-text',
    'Prove each criterion with recipe assertions.',
    ...criteria.flatMap((criterion) => ['--acceptance', criterion]),
    '--surface',
    'test',
    '--project',
    'ledger-proof',
    '--var',
    'PR_NUMBER=1',
    '--var',
    'GH_REPO=example/project',
    '--var',
    'BRANCH=fix/ledger-proof',
    '--var',
    'PUBLICATION_BASE=main',
    '--var',
    'CI_ISSUE_TYPE=lint',
    '--var',
    'CI_ISSUES=- lint failed',
    '--var',
    `REPO=${projectRoot}`,
  ]);
  const artifacts = path.join(taskDir, 'artifacts');
  const projection = path.join(artifacts, 'acceptance-status.json');
  const mark = path.join(taskDir, 'mark');
  const ac = (...args: string[]) => [agent, 'ac', args[0], '--task-dir', taskDir, ...args.slice(1)];
  assert.deepEqual(
    json(path.join(taskDir, 'inputs/handoff.json')).task.acceptanceCriteria,
    criteria,
  );
  assert.deepEqual(
    JSON.parse(invoke(ac('list')).stdout).map((row: { verdict: unknown }) => row.verdict),
    [null, null, null],
  );
  for (const verdict of ['proven', 'weak', 'missing', 'failed', 'awaiting-review', 'untestable']) {
    assert.match(
      invoke(ac('set', 'AC-1', verdict, '--actor', 'operator'), 1).stderr,
      /engine-owned.*verified person/,
    );
  }
  writeFileSync(path.join(projectRoot, 'observation.txt'), 'src/checked.ts\n');
  const manifestFile = path.join(projectRoot, 'actions.json');
  writeJson(manifestFile, {
    $schema: 'https://farmslot.io/schemas/action-manifest-v1.schema.json',
    actions: {
      command: {
        description: 'Read the observation.',
        schema: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd'],
          additionalProperties: false,
        },
        examples: [{ action: 'command', cmd: 'true', intent: 'Read state', next: 'done' }],
      },
      assert_output: {
        description: 'Check the observed output.',
        schema: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            contains: { type: 'string' },
            assert: { type: 'object' },
          },
          required: ['source'],
          additionalProperties: false,
        },
        examples: [
          {
            action: 'assert_output',
            source: 'observe',
            contains: 'checked',
            intent: 'Check state',
            next: 'done',
          },
        ],
      },
      assert_file: {
        description: 'Check a file observation.',
        schema: {
          type: 'object',
          properties: { path: { type: 'string' }, contains: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        examples: [
          {
            action: 'assert_file',
            path: 'observation.txt',
            contains: 'checked',
            intent: 'Check the file',
            next: 'done',
          },
        ],
      },
      end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
    },
  });
  async function execute(name: string, all: boolean, expected = 'src/checked.ts') {
    const recipeFile = path.join(projectRoot, `${name}.recipe.json`);
    const attemptDir = path.join(artifacts, 'recipe-runs', name);
    writeJson(recipeFile, {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Ledger cutover conformance',
      proofTargets: criteria.slice(0, all ? 3 : 2).map((claim, index) => ({
        id: `AC-${index + 1}`,
        claim,
        proofMode: 'state',
      })),
      workflow: {
        entry: 'observe',
        nodes: {
          observe: {
            action: 'command',
            cmd: 'cat observation.txt',
            intent: 'Read the real file',
            next: 'exit',
          },
          exit: {
            action: 'assert_output',
            source: 'observe',
            assert: { path: '$.exitCode', operator: 'eq', value: 0 },
            proves: ['AC-1'],
            intent: 'Require successful execution',
            next: 'output',
          },
          output: {
            action: 'assert_output',
            source: 'observe',
            contains: expected,
            proves: ['AC-2'],
            intent: 'Check the actual output',
            next: all ? 'file' : 'done',
          },
          ...(all
            ? {
                file: {
                  action: 'assert_file',
                  path: 'observation.txt',
                  contains: expected,
                  proves: ['AC-3'],
                  intent: 'Check retained file content',
                  next: 'done',
                },
              }
            : {}),
          done: { action: 'end', status: 'pass' },
        },
      },
    });
    if (all)
      invoke(
        [
          cli,
          '--json',
          'recipe',
          'run',
          recipeFile,
          '--project-root',
          projectRoot,
          '--action-manifest',
          manifestFile,
          '--artifacts-dir',
          attemptDir,
          '--source-trust',
          'trusted',
          '--source-kind',
          'operator',
        ],
        expected === 'src/checked.ts' ? 0 : 1,
      );
    else {
      // Public engine registration retains unexecuted task claims as missing.
      const engine = createRecipeRunner({
        actionManifest: json(manifestFile),
        adapters: createStandardCoreAdapters({ actions: Object.keys(json(manifestFile).actions) }),
        defaultSource: { kind: 'operator', trust: 'trusted', name: 'ledger-proof' },
      });
      const result = await engine.run({
        recipePath: recipeFile,
        projectRoot,
        artifactsDir: attemptDir,
        claims: criteria.map((claim, index) => ({ id: `AC-${index + 1}`, claim })),
      });
      assert.equal(result.status, 'pass');
    }
    const loaded = await readRecordedEvidencePackage(attemptDir);
    assert.ok(
      loaded.checks.every((check) => check.status === 'pass'),
      JSON.stringify(loaded.checks),
    );
    const claims = loaded.input.claims!;
    if (expected !== 'src/checked.ts') {
      assert.equal(
        claims.criteria[1].verdict,
        'failed',
        'the assertion can fail on actual observed state',
      );
      return { attemptDir, claims };
    }
    assert.equal(recordRecipeAttemptSelection(taskDir, attemptDir), true);
    recordRecipeAcceptance(taskDir, projectRoot, {
      tracePath: path.join(attemptDir, 'trace.json'),
      recipePath: recipeFile,
      claimsPath: path.join(attemptDir, 'acceptance-status.json'),
    });
    assert.equal(json(projection).recipeRunId, claims.recipeRunId);
    return { attemptDir, claims };
  }
  // Negative control and missing-claim control precede the passing selected execution.
  await execute('negative', true, 'absent-observation');
  const partial = await execute('partial', false);
  assert.equal(partial.claims.criteria[2].verdict, 'missing');
  invoke([
    path.join(source, 'packages/agent-runtime/scripts/mark-checklist-step.cjs'),
    taskDir,
    'start',
  ]);
  const steps = enumerateChecklistCheckboxes(
    readFileSync(path.join(taskDir, 'CHECKLIST.md'), 'utf8'),
  ).length;
  for (let step = 1; step < steps; step++)
    invoke([
      path.join(source, 'packages/agent-runtime/scripts/mark-checklist-step.cjs'),
      taskDir,
      String(step),
    ]);
  writeFileSync(path.join(artifacts, 'report.md'), '# Proof\n\nEngine claims verified.\n');
  writeFileSync(path.join(artifacts, 'learnings.md'), '- Task ledgers transfer engine claims.\n');
  const finish = () =>
    spawnSync(mark, ['complete', '--mark-last'], { cwd: projectRoot, encoding: 'utf8' });
  let terminal = finish();
  assert.notEqual(terminal.status, 0);
  assert.match(terminal.stderr, /AC-3 is missing/);
  const settled = await execute('complete', true);
  assert.deepEqual(
    settled.claims.criteria.map((claim) => claim.verdict),
    ['proven', 'proven', 'proven'],
  );
  const original = readFileSync(projection, 'utf8');
  assert.match(
    invoke(ac('set', 'AC-1', 'untestable', '--actor', 'operator'), 1).stderr,
    /engine-owned/,
  );
  assert.equal(readFileSync(projection, 'utf8'), original);
  terminal = finish();
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.equal(json(path.join(taskDir, 'SIGNAL.json')).status, 'complete');
  assert.match(invoke(ac('render')).stdout, /Overall recipe coverage: 3\/3 ACs PROVEN/);
  return { taskDir, projection, ...settled };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const work = mkdtempSync(path.join(tmpdir(), 'ledger-cutover-proof-'));
  try {
    const result = await proveLedgerCutover(path.join(work, 'tasks/current'), work);
    console.log(
      JSON.stringify(
        {
          status: 'pass',
          recipeRunId: result.claims.recipeRunId,
          criteria: result.claims.criteria.length,
          negativeControl: 'failed',
          missingControl: 'refused',
          completion: 'accepted',
          recording: result.claims.recording.status,
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
