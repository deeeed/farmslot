import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import type {
  ActionsEnvelope,
  DescribeEnvelope,
  DiscoveryErrorEnvelope,
  ExplainEnvelope,
  ListEnvelope,
  SearchEnvelope,
} from '@farmslot/recipe-cli';

import { registerRecipeCommand } from './recipe.js';

const HELLO = fileURLToPath(new URL('../../../../examples/recipe-library-hello', import.meta.url));

/** `farmslot --json recipe <args>` in this process, with the hello library on RECIPE_LIBRARY_PATH. */
async function recipe<T>(args: string[]): Promise<{ json: T; exitCode: number }> {
  const chunks: string[] = [];
  const write = process.stdout.write;
  const previousLibraries = process.env.RECIPE_LIBRARY_PATH;
  const previousExit = process.exitCode;
  // Keep the command's JSON; the test reporter shares stdout and keeps its own lines.
  process.stdout.write = ((chunk: string | Uint8Array) => {
    const text = String(chunk);
    if (!text.startsWith('{')) return write.call(process.stdout, chunk);
    chunks.push(text);
    return true;
  }) as typeof process.stdout.write;
  process.env.RECIPE_LIBRARY_PATH = `hello=${HELLO}`;
  process.exitCode = 0;
  try {
    const program = new Command().name('farmslot').option('--json');
    registerRecipeCommand(program);
    await program.parseAsync(['--json', 'recipe', ...args], { from: 'user' });
    return { json: JSON.parse(chunks.join('')) as T, exitCode: Number(process.exitCode ?? 0) };
  } finally {
    process.stdout.write = write;
    if (previousLibraries === undefined) delete process.env.RECIPE_LIBRARY_PATH;
    else process.env.RECIPE_LIBRARY_PATH = previousLibraries;
    process.exitCode = previousExit;
  }
}

test('run --list, --describe and --plan with --project-root discover libraries without a project', async () => {
  const list = await recipe<ListEnvelope>(['run', '--list', '--project-root', '.']);
  assert.equal(list.json.command, 'list');
  assert.deepEqual(
    list.json.recipes.map((entry) => entry.ref),
    ['greet', 'greet-twice'],
  );

  const describe = await recipe<DescribeEnvelope>([
    'run',
    'greet',
    '--describe',
    '--project-root',
    '.',
  ]);
  assert.equal(describe.json.kind, 'recipe');
  assert.equal(describe.json.recipe?.template?.node.action, 'call');
  assert.equal(describe.json.recipe?.template?.node.ref, 'greet');
  assert.equal(
    describe.json.recipe?.runCommand,
    'farmslot recipe run greet --action-manifest <manifest.json> --artifacts-dir <dir>',
  );

  const plan = await recipe<ExplainEnvelope>([
    'run',
    'greet-twice',
    'guest=Ada',
    '--plan',
    '--project-root',
    '.',
  ]);
  assert.equal(plan.json.command, 'explain');
  assert.deepEqual(plan.json.recipe.parameters[0], { name: 'guest', value: 'Ada', from: 'input' });
});

test('recipe actions with --project-root lists, searches and details actions', async () => {
  const actions = await recipe<ActionsEnvelope>([
    'actions',
    '--project-root',
    '.',
    '--platform',
    'web',
  ]);
  assert.ok(actions.json.actions.some((action) => action.name === 'hello.wave'));

  const search = await recipe<SearchEnvelope>(['actions', 'greet', '--project-root', '.']);
  assert.equal(search.json.command, 'search');
  assert.ok(search.json.results.some((result) => result.name === 'greet'));

  const detail = await recipe<DescribeEnvelope>([
    'actions',
    '--action',
    'command',
    '--project-root',
    '.',
  ]);
  assert.equal(detail.json.kind, 'action');
  assert.equal(detail.json.action?.template.node.action, 'command');
});

test('standalone discovery prints this CLI syntax and its library option', async () => {
  const missing = await recipe<DiscoveryErrorEnvelope>([
    'run',
    'gret',
    '--describe',
    '--project-root',
    '.',
  ]);
  assert.equal(missing.exitCode, 2);
  assert.equal(
    missing.json.error.userAction,
    'did you mean greet, hello.greet? Inspect: farmslot recipe actions gret --project-root .',
  );

  const selected = await recipe<DescribeEnvelope>([
    'run',
    'greet',
    '--describe',
    '--project-root',
    '.',
    '--library-source',
    `hello=${HELLO}`,
  ]);
  assert.match(selected.json.recipe?.runCommand ?? '', / --library-source hello=/u);
});

test('standalone discovery refuses execution flags, stray inputs and a query with --action', async () => {
  const execution = await recipe<DiscoveryErrorEnvelope>([
    'run',
    'greet',
    '--plan',
    '--project-root',
    '.',
    '--artifacts-dir',
    'artifacts',
  ]);
  assert.equal(execution.json.error.code, 'CLI_UNKNOWN_OPTION');

  const inputs = await recipe<DiscoveryErrorEnvelope>([
    'run',
    'greet',
    'name=Ada',
    '--describe',
    '--project-root',
    '.',
  ]);
  assert.equal(inputs.json.error.code, 'CLI_INVALID_OPTION_VALUE');

  const both = await recipe<DiscoveryErrorEnvelope>([
    'actions',
    'greet',
    '--action',
    'command',
    '--project-root',
    '.',
  ]);
  assert.match(both.json.error.message, /--action takes no query/u);
});

test('standalone run executes a library recipe by ref once its plan is approved', async (t) => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-standalone-ref-'));
  t.after(() => fs.rmSync(artifacts, { recursive: true, force: true }));
  const run = [
    'run',
    'greet-twice',
    'guest=Ada',
    '--action-manifest',
    path.join(HELLO, 'manifests/shared.action-manifest.json'),
    '--artifacts-dir',
    artifacts,
  ];
  const plan = await recipe<DiscoveryErrorEnvelope>(run);
  assert.equal(plan.json.error.code, 'RECIPE_TRUST_REQUIRED');
  const digest = /sha256:[0-9a-f]{64}/u.exec(plan.json.error.userAction)?.[0];
  assert.ok(digest);

  const approved = await recipe<{ status: string; data: { status: string } }>([
    ...run,
    '--approve-plan',
    digest,
  ]);
  assert.equal(approved.json.data.status, 'pass');
  const summary = JSON.parse(fs.readFileSync(path.join(artifacts, 'summary.json'), 'utf8'));
  assert.deepEqual(
    [
      summary.recipeSelection.name,
      summary.recipeSelection.resolvedBy,
      summary.recipeSelection.source,
    ],
    ['greet-twice', 'ref', 'hello'],
  );
});
