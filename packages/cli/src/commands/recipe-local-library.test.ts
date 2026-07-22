import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(packageDir, '../..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const entry = path.join(packageDir, 'src', 'entry.ts');
test('recipe validate and run discover an adjacent task library without flags', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'farmslot-cli-task-library-'));
  const recipePath = path.join(root, 'recipe.json');
  const libraryRoot = path.join(root, 'recipe-library');
  const childDir = path.join(libraryRoot, 'recipes', 'demo');
  const artifactsDir = path.join(root, 'artifacts');
  const blockedArtifactsDir = path.join(root, 'blocked-artifacts');
  const actionManifest = path.join(root, 'action-manifest.json');
  const markerPath = path.join(root, 'task-library-marker.txt');

  try {
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      path.join(libraryRoot, 'library.json'),
      `${JSON.stringify({ schema_version: 1, kind: 'recipe-library', name: 'task-local' })}\n`,
    );
    writeFileSync(
      path.join(childDir, 'child.recipe.json'),
      `${JSON.stringify({
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        description: 'Task-local child recipe.',
        workflow: {
          entry: 'write',
          nodes: {
            write: {
              action: 'command',
              intent: 'Write the task-library marker.',
              cmd: 'touch task-library-marker.txt',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      })}\n`,
    );
    writeFileSync(
      recipePath,
      `${JSON.stringify({
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        description: 'Call a task-local child recipe.',
        workflow: {
          entry: 'child',
          nodes: {
            child: {
              action: 'call',
              intent: 'Reuse the task-local child recipe.',
              ref: 'demo.child',
              next: 'done',
            },
            done: { action: 'end', status: 'pass' },
          },
        },
      })}\n`,
    );
    writeFileSync(
      actionManifest,
      `${JSON.stringify({
        runner_protocol_version: 1,
        action_registry_version: 1,
        supported_official_actions: ['command', 'call', 'end'],
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
      })}\n`,
    );

    const validate = spawnSync(
      tsxBin,
      [entry, '--json', 'recipe', 'validate', recipePath, '--action-manifest', actionManifest],
      { cwd: packageDir, encoding: 'utf-8' },
    );
    assert.equal(validate.status, 0, validate.stderr || validate.stdout);
    assert.equal(JSON.parse(validate.stdout).status, 'valid');

    const run = spawnSync(
      tsxBin,
      [
        entry,
        '--json',
        'recipe',
        'run',
        recipePath,
        '--action-manifest',
        actionManifest,
        '--artifacts-dir',
        artifactsDir,
        '--project-root',
        root,
      ],
      { cwd: packageDir, encoding: 'utf-8' },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const runEnvelope = JSON.parse(run.stdout) as { status: string; data?: { status?: string } };
    assert.equal(runEnvelope.status, 'ok');
    assert.equal(runEnvelope.data?.status, 'pass');
    assert.equal(existsSync(markerPath), true);

    unlinkSync(markerPath);
    const blocked = spawnSync(
      tsxBin,
      [
        entry,
        '--json',
        'recipe',
        'run',
        recipePath,
        '--action-manifest',
        actionManifest,
        '--artifacts-dir',
        blockedArtifactsDir,
        '--project-root',
        root,
        '--source-trust',
        'untrusted',
      ],
      { cwd: packageDir, encoding: 'utf-8' },
    );
    assert.notEqual(blocked.status, 0);
    assert.equal(existsSync(markerPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
