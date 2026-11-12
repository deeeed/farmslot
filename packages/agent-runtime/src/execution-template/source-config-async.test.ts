import assert from 'node:assert/strict';
import childProcess, { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ProjectExecutionTemplatesConfig } from '@farmslot/protocol';

import {
  type ExecutionTemplateGitResult,
  type ExecutionTemplateGitRunner,
  resolveConfiguredExecutionTemplateSources,
  resolveConfiguredExecutionTemplateSourcesAsync,
} from './source-config.js';

test('async source resolution preserves ordered answers and unavailable diagnostics', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'source-config-async-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'first'));
  mkdirSync(path.join(root, 'second'));
  writeFileSync(path.join(root, 'first', 'proof.md'), 'source fixture');
  const config: ProjectExecutionTemplatesConfig = {
    sources: [
      { id: 'one', kind: 'workspace', root: { projectPath: 'first' } },
      { id: 'missing', kind: 'workspace', root: { projectPath: 'missing' } },
      { id: 'two', kind: 'workspace', root: { projectPath: 'second' } },
    ],
  };
  const original = childProcess.spawnSync;
  const commands: string[][] = [];
  const answers: ExecutionTemplateGitResult[] = [];
  const spy = t.mock.method(childProcess, 'spawnSync', (...args: Parameters<typeof original>) => {
    const result = original(...args);
    commands.push([...(args[1] ?? [])]);
    answers.push({ status: result.status, stdout: String(result.stdout ?? '') });
    return result;
  });
  syncBuiltinESMExports();
  let expected;
  try {
    expected = resolveConfiguredExecutionTemplateSources(config, { projectPackRoot: root });
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  let next = 0;
  const actual = await resolveConfiguredExecutionTemplateSourcesAsync(
    config,
    { projectPackRoot: root },
    async (args) => {
      assert.deepEqual(args, commands[next]);
      return answers[next++]!;
    },
  );
  assert.deepEqual(actual, expected);
  assert.equal(next, 4, 'each valid source checks revision then status exactly once');
  assert.deepEqual(actual.unavailable, [{ id: 'missing', reason: 'missing-root' }]);
});

test('async source resolution yields before another source and propagates the first read failure', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'source-config-order-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seen: string[] = [];
  const config: ProjectExecutionTemplatesConfig = {
    sources: [
      { id: 'one', kind: 'workspace', root: { sourceId: 'first', entry: '.' } },
      { id: 'two', kind: 'workspace', root: { sourceId: 'second', entry: '.' } },
    ],
  };
  const options = {
    projectPackRoot: root,
    resolveSourceBinding: (selection: { sourceId: string }) => {
      seen.push(selection.sourceId);
      if (selection.sourceId === 'second') throw new Error('later source failed');
      return { root, commit: 'a'.repeat(40), lockDigest: 'b'.repeat(64) };
    },
  };
  let reject!: (error: Error) => void;
  const answer = new Promise<ExecutionTemplateGitResult>((_resolve, fail) => {
    reject = fail;
  });
  const first = new Error('first git read failed');
  const pending = resolveConfiguredExecutionTemplateSourcesAsync(config, options, () => answer);
  const rejected = assert.rejects(pending, (error) => error === first);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['first'], 'async resolution eagerly validated a later source');
  reject(first);
  await rejected;
  assert.deepEqual(seen, ['first']);
});

test('the asynchronous source resolver answers as the synchronous one, through the given git runner', async (t) => {
  const pack = mkdtempSync(path.join(tmpdir(), 'source-config-async-'));
  t.after(() => rmSync(pack, { recursive: true, force: true }));
  const git = (args: string[]) => execFileSync('git', args, { cwd: pack, stdio: 'ignore' });
  // A committed source, the same with an uncommitted change, a non-repository and a missing root.
  const repo = path.join(pack, 'repo');
  mkdirSync(path.join(repo, 'clean'), { recursive: true });
  mkdirSync(path.join(repo, 'dirty'), { recursive: true });
  writeFileSync(path.join(repo, 'clean', 'a.md'), '# A\n');
  writeFileSync(path.join(repo, 'dirty', 'b.md'), '# B\n');
  git(['init', '--quiet', repo]);
  git(['-C', repo, 'add', '.']);
  git([
    '-C',
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'init',
  ]);
  writeFileSync(path.join(repo, 'dirty', 'b.md'), '# B changed\n');
  mkdirSync(path.join(pack, 'plain'));
  const config = {
    sources: [
      { id: 'clean', kind: 'workspace' as const, root: { projectPath: 'repo' }, subpath: 'clean' },
      { id: 'dirty', kind: 'workspace' as const, root: { projectPath: 'repo' }, subpath: 'dirty' },
      { id: 'plain', kind: 'workspace' as const, root: { projectPath: 'plain' } },
      { id: 'missing', kind: 'workspace' as const, root: { projectPath: 'missing' } },
    ],
  };
  const calls: string[][] = [];
  const runner: ExecutionTemplateGitRunner = (args) =>
    new Promise((resolve) => {
      calls.push(args);
      execFile('git', args, { encoding: 'utf8' }, (error, stdout) =>
        resolve({
          status: !error ? 0 : typeof error.code === 'number' ? error.code : null,
          stdout,
        }),
      );
    });
  const options = { projectPackRoot: pack };
  const synchronous = resolveConfiguredExecutionTemplateSources(config, options);
  assert.deepEqual(
    await resolveConfiguredExecutionTemplateSourcesAsync(config, options, runner),
    synchronous,
  );
  assert.equal(calls.length, 6, 'a revision and a status read per available source');
  assert.deepEqual(
    synchronous.sources.map((source) => [
      source.id,
      Boolean(source.sourceRevision),
      source.sourceDirty,
    ]),
    [
      ['clean', true, false],
      ['dirty', true, true],
      ['plain', false, undefined],
    ],
  );
  assert.deepEqual(synchronous.unavailable, [{ id: 'missing', reason: 'missing-root' }]);
  await assert.rejects(
    resolveConfiguredExecutionTemplateSourcesAsync(config, options, () =>
      Promise.reject(new Error('git gone')),
    ),
    /git gone/,
  );
});
