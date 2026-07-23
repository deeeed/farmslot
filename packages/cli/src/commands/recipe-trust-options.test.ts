import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { registerRecipeCommand } from './recipe.js';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(packageDir, '../..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const entry = path.join(packageDir, 'src', 'entry.ts');

test('recipe run exposes exact-plan trust controls', () => {
  const program = new Command();
  registerRecipeCommand(program);

  const recipe = program.commands.find((command) => command.name() === 'recipe');
  const run = recipe?.commands.find((command) => command.name() === 'run');
  assert.ok(run);
  assert.deepEqual(
    run.options
      .flatMap((option) => (option.long ? [option.long] : []))
      .filter((option) => option.startsWith('--source-') || option === '--approve-plan')
      .sort(),
    ['--approve-plan', '--source-digest', '--source-kind', '--source-name', '--source-trust'],
  );
});

test('recipe run blocks an untrusted command until the exact plan is approved', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'farmslot-cli-recipe-trust-'));
  const recipePath = path.join(root, 'recipe.json');
  const manifestPath = path.join(root, 'manifest.json');
  const markerPath = path.join(root, 'approved.txt');
  const artifactsDir = path.join(root, 'artifacts');
  const commonArgs = [
    entry,
    '--json',
    'recipe',
    'run',
    recipePath,
    '--action-manifest',
    manifestPath,
    '--project-root',
    root,
    '--source-trust',
    'untrusted',
    '--source-kind',
    'task',
  ];

  try {
    writeFileSync(
      recipePath,
      JSON.stringify({
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        title: 'CLI trust round trip',
        description: 'Proves exact-plan approval before host execution.',
        workflow: {
          entry: 'write',
          nodes: {
            write: {
              action: 'command',
              intent: 'Write the exact-plan approval marker',
              cmd: 'touch approved.txt',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        runner_protocol_version: 1,
        action_registry_version: 1,
        supported_official_actions: ['command', 'end'],
        action_metadata: {
          command: {
            description: 'Run a command.',
            schema: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd'],
              additionalProperties: false,
            },
          },
        },
      }),
    );

    const blocked = spawnSync(tsxBin, [...commonArgs, '--artifacts-dir', artifactsDir], {
      cwd: packageDir,
      env: { ...process.env, FARMSLOT_HOME: root },
      encoding: 'utf-8',
    });
    assert.notEqual(blocked.status, 0);
    assert.equal(existsSync(markerPath), false);
    const failure = JSON.parse(blocked.stdout) as {
      error?: { code?: string; userAction?: string };
    };
    assert.equal(failure.error?.code, 'RECIPE_TRUST_REQUIRED', blocked.stderr || blocked.stdout);
    const digest = failure.error?.userAction?.match(/--approve-plan (sha256:[a-f0-9]+)/u)?.[1];
    assert.ok(digest);

    const approved = spawnSync(
      tsxBin,
      [...commonArgs, '--artifacts-dir', artifactsDir, '--approve-plan', digest],
      { cwd: packageDir, env: { ...process.env, FARMSLOT_HOME: root }, encoding: 'utf-8' },
    );
    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    assert.equal(existsSync(markerPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
