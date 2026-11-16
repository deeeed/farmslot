import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { resolveRecipeExecutionArtifacts } from '../src/harness/commands/run.js';
import { parseArgs } from '../src/harness/parse-args.js';

const taskVariables = ['RECIPE_TASK_DIR', 'FARMSLOT_TASK_DIR'] as const;
const variables = [...taskVariables, 'FARMSLOT_RECIPE_UNBOUND'] as const;
const original = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
const roots: string[] = [];
const layout = { fresh: 'runs/diagnostic', taskSubdir: 'recipe-runs/diagnostic' };

beforeEach(() => {
  for (const name of variables) delete process.env[name];
});

afterEach(() => {
  mock.restoreAll();
  for (const name of variables) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-task-binding-'));
  roots.push(root);
  return root;
}

test('a checkout with task storage refuses an unbound recipe attempt', () => {
  const root = checkout();
  fs.mkdirSync(path.join(root, 'temp/tasks/task-one'), { recursive: true });
  assert.throws(
    () => resolveRecipeExecutionArtifacts(root, undefined, layout),
    (error: unknown) =>
      error instanceof Error &&
      /RECIPE_TASK_DIR/u.test(error.message) &&
      /--unbound/u.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(root, 'temp/recipe/runs/diagnostic')), false);
});

test('an explicit output directory cannot silently bypass missing task binding', () => {
  const root = checkout();
  fs.mkdirSync(path.join(root, 'temp/tasks/task-one'), { recursive: true });
  assert.throws(
    () => resolveRecipeExecutionArtifacts(root, path.join(root, 'proof'), layout),
    /--unbound/u,
  );
});

test('call refusals teach a same-invocation environment prefix', () => {
  const root = checkout();
  fs.mkdirSync(path.join(root, 'temp/tasks/task-one'), { recursive: true });
  assert.throws(
    () => resolveRecipeExecutionArtifacts(root, undefined, layout, { command: 'call' }),
    (error: unknown) =>
      error instanceof Error &&
      'userAction' in error &&
      typeof error.userAction === 'string' &&
      error.userAction.startsWith('RECIPE_TASK_DIR=') &&
      error.userAction.includes(" call '<action>'"),
  );
});

test('checking task binding does not enumerate retained tasks', () => {
  const root = checkout();
  fs.mkdirSync(path.join(root, 'temp/tasks/task-one'), { recursive: true });
  mock.method(fs, 'readdirSync', () => {
    throw new Error('task history must not be scanned');
  });
  assert.throws(() => resolveRecipeExecutionArtifacts(root, undefined, layout), /--unbound/u);
});

test('an unreadable task-storage check does not allow an accidental unbound attempt', () => {
  const root = checkout();
  const failure = Object.assign(new Error('task storage unreadable'), { code: 'EACCES' });
  const stat = mock.method(fs, 'statSync', () => {
    throw failure;
  });
  assert.throws(() => resolveRecipeExecutionArtifacts(root, undefined, layout), failure);
  assert.deepEqual(
    stat.mock.calls.map((call) => call.arguments[0]),
    [path.join(root, 'temp/tasks')],
  );
});

test('unbound is a boolean option and does not consume the recipe name', () => {
  const parsed = parseArgs(['--unbound', 'smoke.recipe.json']);
  assert.equal(parsed.options.unbound, true);
  assert.deepEqual(parsed.positional, ['smoke.recipe.json']);
});

test('a checkout with no task storage remains a standalone diagnostic target', () => {
  const root = checkout();
  const result = resolveRecipeExecutionArtifacts(root, undefined, layout);
  assert.equal(result.taskDir, null);
  assert.equal(result.artifactsDir, path.join(root, 'temp/recipe/runs/diagnostic'));
});

test('explicit unbound diagnostics may run beside retained tasks without accepting claims', () => {
  const root = checkout();
  fs.mkdirSync(path.join(root, 'temp/tasks/task-one'), { recursive: true });
  const result = resolveRecipeExecutionArtifacts(root, undefined, layout, { unbound: true });
  assert.equal(result.taskDir, null);
  assert.equal(result.claims, undefined);
  assert.equal(result.artifactsDir, path.join(root, 'temp/recipe/runs/diagnostic'));
});

test('a scoped replay environment selects diagnostics without binding task claims', () => {
  const root = checkout();
  fs.mkdirSync(path.join(root, 'temp/tasks/task-one'), { recursive: true });
  process.env.FARMSLOT_RECIPE_UNBOUND = '1';
  const result = resolveRecipeExecutionArtifacts(root, undefined, layout);
  assert.equal(result.taskDir, null);
  assert.equal(result.claims, undefined);
});

test('a disabled replay setting cannot bypass task binding', () => {
  const root = checkout();
  fs.mkdirSync(path.join(root, 'temp/tasks/task-one'), { recursive: true });
  process.env.FARMSLOT_RECIPE_UNBOUND = '0';
  assert.throws(() => resolveRecipeExecutionArtifacts(root, undefined, layout), /--unbound/u);
});

for (const variable of taskVariables) {
  test(`unbound diagnostics cannot silently discard ${variable}`, () => {
    const root = checkout();
    process.env[variable] = path.join(root, 'temp/tasks/task-one');
    assert.throws(
      () => resolveRecipeExecutionArtifacts(root, undefined, layout, { unbound: true }),
      /cannot combine --unbound/u,
    );
  });
  test(`a scoped replay cannot discard ${variable}`, () => {
    const root = checkout();
    process.env[variable] = path.join(root, 'temp/tasks/task-one');
    process.env.FARMSLOT_RECIPE_UNBOUND = '1';
    assert.throws(
      () => resolveRecipeExecutionArtifacts(root, undefined, layout),
      /cannot combine --unbound or FARMSLOT_RECIPE_UNBOUND=1/u,
    );
  });
}

test('a bound task still owns its attempt and registered acceptance claims', () => {
  const root = checkout();
  const task = path.join(root, 'temp/tasks/task-one');
  fs.mkdirSync(path.join(task, 'inputs'), { recursive: true });
  fs.writeFileSync(
    path.join(task, 'inputs/handoff.json'),
    JSON.stringify({ task: { acceptanceCriteria: ['The result is recorded.'] } }),
  );
  process.env.RECIPE_TASK_DIR = task;
  const result = resolveRecipeExecutionArtifacts(root, undefined, layout);
  assert.equal(result.taskDir, task);
  assert.equal(result.artifactsDir, path.join(task, 'artifacts/recipe-runs/diagnostic'));
  assert.deepEqual(result.claims, [{ id: 'AC-1', claim: 'The result is recorded.' }]);
});
