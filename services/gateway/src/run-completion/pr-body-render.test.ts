import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ExecResult } from '../core/exec.js';

import { type PrBodyRenderDeps, renderPrBodyArtifact } from './pr-body-render.js';
import { makeRun } from './test-fixtures.js';

async function makeTaskDir(withProse = true): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-pr-body-render-'));
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await writeFile(path.join(root, 'task.md'), '# Task\n');
  if (withProse)
    await writeFile(path.join(root, 'artifacts', 'pr-description.md'), '## **Description**\n\nx\n');
  return root;
}

function deps(overrides: Partial<PrBodyRenderDeps> & { calls: string[] }): PrBodyRenderDeps {
  return {
    exec: async (command) => {
      overrides.calls.push(command);
      return { exitCode: 0, stdout: '{"status":"ok"}', stderr: '' } satisfies ExecResult;
    },
    readTemplate: async () => ({
      path: '.github/pull-request-template.md',
      body: '## **Description**\n',
    }),
    resolveRenderer: async () => ({
      command: 'mm-harness pr-body render',
      machineEnv: { MM_HARNESS_BIN: '/opt/mm-harness' },
    }),
    ...overrides,
  };
}

test('renderPrBodyArtifact runs the pack renderer with the fetched template and the machine env', async () => {
  const root = await makeTaskDir();
  try {
    const calls: string[] = [];
    const outcome = await renderPrBodyArtifact(
      makeRun({ taskFile: path.join(root, 'task.md'), slotId: 'macwork-mmdev-1' }),
      'main',
      deps({ calls }),
    );
    assert.deepEqual(outcome, { rendered: true, command: 'mm-harness pr-body render' });
    assert.equal(calls.length, 1);
    const command = calls[0];
    assert.match(
      command,
      /^export MM_HARNESS_BIN='\/opt\/mm-harness' && mm-harness pr-body render '/,
    );
    assert.ok(command.includes(`'${root}'`), 'task dir passed');
    assert.match(
      command,
      /--template '[^']*pull-request-template\.md' --template-path '\.github\/pull-request-template\.md' --json$/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('renderPrBodyArtifact surfaces the renderer error message on failure', async () => {
  const root = await makeTaskDir();
  try {
    const calls: string[] = [];
    await assert.rejects(
      renderPrBodyArtifact(
        makeRun({ taskFile: path.join(root, 'task.md'), slotId: 'macwork-mmdev-1' }),
        'main',
        deps({
          calls,
          exec: async () => ({
            exitCode: 1,
            stdout:
              '{"status":"error","error":"pr-description.md is missing the template section(s) ## **Changelog**; author them under those exact headings."}',
            stderr: '',
          }),
        }),
      ),
      /PR body render failed: pr-description\.md is missing the template section\(s\) ## \*\*Changelog\*\*/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('renderPrBodyArtifact skips runs without a task, prose, slot or pack renderer', async () => {
  const withoutProse = await makeTaskDir(false);
  const withProse = await makeTaskDir();
  try {
    const calls: string[] = [];
    assert.deepEqual(
      await renderPrBodyArtifact(makeRun({ taskFile: null }), 'main', deps({ calls })),
      {
        rendered: false,
        reason: 'no-task',
      },
    );
    assert.deepEqual(
      await renderPrBodyArtifact(
        makeRun({ taskFile: path.join(withoutProse, 'task.md') }),
        'main',
        deps({ calls }),
      ),
      { rendered: false, reason: 'no-prose' },
    );
    assert.deepEqual(
      await renderPrBodyArtifact(
        makeRun({ taskFile: path.join(withProse, 'task.md') }),
        'main',
        deps({ calls, resolveRenderer: async () => 'no-command' }),
      ),
      { rendered: false, reason: 'no-command' },
    );
    assert.equal(calls.length, 0);
    assert.equal(
      await readFile(path.join(withProse, 'artifacts', 'pr-description.md'), 'utf-8'),
      '## **Description**\n\nx\n',
    );
  } finally {
    await rm(withoutProse, { recursive: true, force: true });
    await rm(withProse, { recursive: true, force: true });
  }
});

test('renderPrBodyArtifact passes an empty template when the repository has none', async () => {
  const root = await makeTaskDir();
  try {
    const calls: string[] = [];
    await renderPrBodyArtifact(
      makeRun({ taskFile: path.join(root, 'task.md'), slotId: 'macwork-mmdev-1' }),
      'main',
      deps({
        calls,
        readTemplate: async () => null,
        resolveRenderer: async () => ({ command: 'mm-harness pr-body render' }),
      }),
    );
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0], /--template-path/);
    assert.match(calls[0], /^mm-harness pr-body render '/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('renderPrBodyArtifact falls back to stderr, then stdout, then the exit code for a non-JSON failure', async () => {
  const root = await makeTaskDir();
  try {
    const calls: string[] = [];
    const failing = (result: ExecResult) =>
      renderPrBodyArtifact(
        makeRun({ taskFile: path.join(root, 'task.md'), slotId: 'macwork-mmdev-1' }),
        'main',
        deps({ calls, exec: async () => result }),
      );
    await assert.rejects(
      failing({ exitCode: 2, stdout: '', stderr: 'usage: bad flag\n' }),
      /PR body render failed: usage: bad flag$/,
    );
    await assert.rejects(
      failing({ exitCode: 2, stdout: 'plain text\n', stderr: '' }),
      /PR body render failed: plain text$/,
    );
    await assert.rejects(
      failing({ exitCode: 3, stdout: '', stderr: '' }),
      /PR body render failed: exit 3$/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('renderPrBodyArtifact skips a run without a slot through the real pack lookup', async () => {
  const root = await makeTaskDir();
  try {
    assert.deepEqual(
      await renderPrBodyArtifact(
        makeRun({ taskFile: path.join(root, 'task.md'), slotId: null }),
        'main',
      ),
      {
        rendered: false,
        reason: 'no-slot',
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
