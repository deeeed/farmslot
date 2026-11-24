import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { GRADED_DIFF_MAX_BYTES, gradedDiffScript, parseGradedDiffOutput } from './output.js';

async function repo(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'graded-diff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      encoding: 'utf8',
    }).trim();
  git('init', '-q');
  await writeFile(path.join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  return { dir, git, base: git('rev-parse', 'HEAD') };
}

const run = (script: string) => execFileSync('bash', ['-c', script], { encoding: 'utf8' });

test('a committed output diffs the dispatch head against the commit', async (t) => {
  const { dir, git, base } = await repo(t);
  await writeFile(path.join(dir, 'a.txt'), 'two\n');
  git('commit', '-qam', 'change');
  const head = git('rev-parse', 'HEAD');
  const parsed = parseGradedDiffOutput(
    run(gradedDiffScript({ repo: dir, base, source: 'committed', ref: head })),
  );
  assert.equal(parsed.head, head);
  assert.match(parsed.body ?? '', /-one\n\+two/);
  assert.equal(parsed.sha256, createHash('sha256').update(parsed.body!).digest('hex'));
  assert.equal(parsed.sizeBytes, Buffer.byteLength(parsed.body!));
});

test('a working-tree output includes untracked files and leaves the slot index alone', async (t) => {
  const { dir, git, base } = await repo(t);
  await writeFile(path.join(dir, 'a.txt'), 'edited\n');
  await writeFile(path.join(dir, 'new-file.ts'), 'export const added = 1;\n');
  const indexBefore = await readFile(path.join(dir, '.git', 'index'));
  const parsed = parseGradedDiffOutput(
    run(gradedDiffScript({ repo: dir, base, source: 'working-tree', ref: null })),
  );
  assert.match(parsed.body ?? '', /new-file\.ts/);
  assert.match(parsed.body ?? '', /\+edited/);
  assert.deepEqual(await readFile(path.join(dir, '.git', 'index')), indexBefore);
  assert.equal(git('status', '--porcelain'), 'M a.txt\n?? new-file.ts');
});

test('an oversized diff keeps its sha256 and size without bytes', () => {
  const sha = 'a'.repeat(64);
  const parsed = parseGradedDiffOutput(
    `${'b'.repeat(40)}\n${GRADED_DIFF_MAX_BYTES + 1}\n${sha}\n--farmslot-graded-diff--\n`,
  );
  assert.equal(parsed.body, null);
  assert.equal(parsed.sha256, sha);
  assert.equal(parsed.sizeBytes, GRADED_DIFF_MAX_BYTES + 1);
});

test('truncated slot output is refused', () => {
  assert.throws(() => parseGradedDiffOutput('abc\n'), /incomplete/);
});

test('a replay keeps the failures it resets in the append-only attempt log', async (t) => {
  const { createRun, deleteRun, getRun, updateRun, updateRunStep } =
    await import('../runs/store.js');
  const { recordReplayedFailures } = await import('./output.js');
  const created = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `TRACE-${Date.now()}`,
  });
  t.after(async () => {
    updateRun(created.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(created.id);
  });
  updateRunStep(created.id, 'prepare', {
    status: 'failed',
    completedAt: '2026-11-24T09:00:00Z',
    detail: 'node offline',
  });
  recordReplayedFailures(created.id, 'prepare');
  recordReplayedFailures(created.id, 'prepare');
  assert.deepEqual(getRun(created.id)!.attemptLog, [
    {
      kind: 'infra-failure',
      step: 'prepare',
      at: '2026-11-24T09:00:00Z',
      error: 'node offline',
      recovery: 'replay prepare',
    },
    {
      kind: 'infra-failure',
      step: 'prepare',
      at: '2026-11-24T09:00:00Z',
      error: 'node offline',
      recovery: 'replay prepare',
    },
  ]);
});
