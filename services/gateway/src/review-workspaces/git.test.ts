import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { runInNewContext } from 'node:vm';

import type { GitDiffParams, Run } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';

let run: Run;
let hostCalls = 0;
let authorized = true;
let simulated = false;
const hostRequire = createRequire(import.meta.url);
const exec = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...exec,
    execFileArgv: async (argv: string[]) => {
      hostCalls++;
      if (simulated) {
        const input = JSON.parse(argv.at(-1)!);
        const args: string[] = input.args;
        return {
          stdout: args.includes('diff')
            ? 'frozen diff'
            : args[0] === 'merge-base'
              ? 'a'.repeat(40)
              : args.at(-1)!.replace(/\^\{commit\}$/, ''),
          stderr: '',
          exitCode: 0,
        };
      }
      let stdout = '';
      let stderr = '';
      const process = {
        argv: ['node', ...argv.slice(3)],
        stdout: {
          write: (data: string) => {
            stdout += data;
          },
        },
        stderr: {
          write: (data: string) => {
            stderr += data;
          },
        },
        exitCode: 0,
      };
      runInNewContext(argv[2], { Buffer, require: hostRequire, process });
      return { stdout, stderr, exitCode: process.exitCode };
    },
  },
});
mock.module('../runs/store.js', {
  namedExports: { getRunWithArchived: async () => run, getRun: () => run },
});
mock.module('../security/native-worker-owner.js', {
  namedExports: {
    assertNativeRunOwner() {
      if (!authorized) throw new Error('Owner access revoked');
    },
  },
});
// The local and remote paths execute the same production Git wrapper over pipes.
mock.module('../runners/native/node.js', {
  namedExports: {
    execNativeNodeArgv() {
      throw new Error('Unexpected remote execution');
    },
  },
});
const { workspaceReviewGit } = await import('./git.js');
const { gitDiff, gitShow, gitShowBatch } = await import('../methods/git.js');

test('review Git returns all 570 frozen lines, including finding 479, after the head changes', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-git-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  git('config', 'commit.gpgsign', 'false');
  const file = 'usePerpsCloseAllCalculations.ts';
  const content =
    Array.from(
      { length: 570 },
      (_, index) => `// ${index + 1}: ${'reviewed source '.repeat(12)}`,
    ).join('\n') + '\n';
  await writeFile(path.join(source, file), content);
  git('add', file);
  git('commit', '--quiet', '-m', 'fixture: reviewed version');
  const headSha = git('rev-parse', 'HEAD');
  await writeFile(
    path.join(source, file),
    content.split('\n').slice(0, 552).join('\n').replaceAll('reviewed source', 'current source') +
      '\n',
  );
  git('commit', '--quiet', '-am', 'fixture: newer version');
  const identity = {
    owner: 'fixture',
    project: 'fixture',
    repositoryUrl: 'https://example.test/repo.git',
  };
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const cache = path.join(root, 'repositories', key);
  await mkdir(path.dirname(cache), { recursive: true });
  execFileSync('git', ['clone', '--quiet', '--bare', source, cache]);
  await writeFile(cache + '.json', JSON.stringify(identity));
  run = makeRun({ id: 'review', project: identity.project });
  run.nativeOwnerPrincipalId = identity.owner;
  run.reviewWorkspaceSubject = {
    repository: 'fixture/repo',
    repositoryUrl: identity.repositoryUrl,
    headSha,
    baseSha: headSha,
    branch: 'main',
    title: 'Review',
    body: '',
    capturedAt: '2026-10-22',
  };
  run.reviewWorkspace = {
    workspaceId: run.id,
    machine: 'fixture',
    executionNodeId: 'local',
    checkoutPath: path.join(root, 'runs', run.id, 'source'),
    taskPath: '',
    artifactPath: '',
  };
  const deps = await workspaceReviewGit({ runId: run.id, slotId: '', ref: headSha });
  const result = await deps.runCommand!(['show', `${headSha}:${file}`]);
  assert.equal(
    Buffer.byteLength(result.stdout),
    Buffer.byteLength(content),
    'the wrapper must drain stdout before exiting',
  );
  assert.equal(result.stdout, content);
  assert.equal(result.stdout.trimEnd().split('\n').length, 570);
  assert.match(result.stdout.split('\n')[478], /^\/\/ 479:/);
  const currentHead = git('rev-parse', 'HEAD');
  const expectedDiff = execFileSync(
    'git',
    ['diff', '--no-ext-diff', '--no-textconv', headSha, currentHead, '--', file],
    {
      cwd: source,
      encoding: 'utf8',
    },
  );
  assert.ok(Buffer.byteLength(expectedDiff) > 8192);
  const diff = await deps.runCommand!(['diff', headSha, currentHead, '--', file]);
  assert.equal(
    Buffer.byteLength(diff.stdout),
    Buffer.byteLength(expectedDiff),
    'diff readers must also drain the complete output',
  );
  assert.equal(diff.stdout, expectedDiff);
});

test('run-scoped batched git.show reads only the frozen head and the derived merge-base', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-git-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--bare');
  const imported = [
    ['main', 'branch point\n', ':1', undefined],
    ['feature', 'reviewed\n', ':2', ':1'],
    ['feature', 'newer\n', ':3', ':2'],
    ['main', 'base moved\n', ':4', ':1'],
  ]
    .map(
      ([branch, content, mark, parent]) =>
        `commit refs/heads/${branch}\nmark ${mark}\ncommitter Fixture <fixture@example.test> 1 +0000\ndata 7\nfixture\n${parent ? `from ${parent}\n` : ''}M 100644 inline shared.txt\ndata ${Buffer.byteLength(content!)}\n${content}\n`,
    )
    .join('');
  execFileSync('git', ['fast-import', '--quiet'], { cwd: source, input: imported });
  const [mergeBase, headSha, newerHead, baseSha, reviewedBlob, baseBlob, newerBlob] = git(
    'rev-parse',
    'refs/heads/main^',
    'refs/heads/feature^',
    'refs/heads/feature',
    'refs/heads/main',
    'refs/heads/feature^:shared.txt',
    'refs/heads/main:shared.txt',
    'refs/heads/feature:shared.txt',
  ).split('\n');
  const identity = {
    owner: 'fixture',
    project: 'fixture',
    repositoryUrl: 'https://example.test/repo.git',
  };
  const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const cache = path.join(root, 'repositories', key);
  await mkdir(path.dirname(cache), { recursive: true });
  execFileSync('git', ['clone', '--quiet', '--bare', source, cache]);
  await writeFile(cache + '.json', JSON.stringify(identity));
  run = makeRun({ id: 'review-batch', project: identity.project });
  run.nativeOwnerPrincipalId = identity.owner;
  run.reviewWorkspaceSubject = {
    repository: 'fixture/repo',
    repositoryUrl: identity.repositoryUrl,
    headSha,
    baseSha,
    branch: 'feature',
    title: 'Review',
    body: '',
    capturedAt: '2026-10-27',
  };
  run.reviewWorkspace = {
    workspaceId: run.id,
    machine: 'fixture',
    executionNodeId: 'local',
    checkoutPath: path.join(root, 'runs', run.id, 'source'),
    taskPath: '',
    artifactPath: '',
  };
  const read = (ref: string, have?: string[]) =>
    gitShowBatch({ slotId: '', runId: run.id, ref, paths: ['shared.txt'], have });
  const content = async (ref: string) =>
    Buffer.from((await read(ref)).entries[0].content!, 'base64').toString();

  hostCalls = 0;
  const reviewed = await read(headSha);
  assert.equal(Buffer.from(reviewed.entries[0].content!, 'base64').toString(), 'reviewed\n');
  assert.equal(reviewed.entries[0].id, reviewedBlob);
  assert.equal(hostCalls, 1);
  hostCalls = 0;
  assert.equal(await content(mergeBase), 'branch point\n');
  assert.equal(hostCalls, 1);
  for (const [ref, id] of [
    [baseSha, baseBlob],
    [newerHead, newerBlob],
  ]) {
    // Holding the object id is no authority to read it.
    const have = [id];
    await assert.rejects(read(ref, have), /frozen review commits/);
  }
  // Single-path reads keep today's head-only rule, even when the client asks for the merge-base.
  for (const params of [
    { slotId: '', runId: run.id, ref: mergeBase, path: 'shared.txt' },
    { slotId: '', runId: run.id, ref: mergeBase, path: 'shared.txt', mergeBaseRef: true },
  ])
    await assert.rejects(gitShow(params), /frozen review commits/);
  await assert.rejects(
    gitDiff({ slotId: '', runId: run.id, ref: mergeBase, mergeBaseRef: true } as GitDiffParams),
    /frozen review commits/,
  );
  hostCalls = 0;
  assert.deepEqual(await gitShow({ slotId: '', runId: run.id, ref: headSha, path: 'shared.txt' }), {
    content: 'reviewed\n',
    id: reviewedBlob,
  });
  assert.equal(hostCalls, 1);
});

test('cached frozen diffs still check ownership and exact commits', { timeout: 1000 }, async () => {
  run = makeRun({ id: 'cached-review', project: 'example' });
  run.nativeOwnerPrincipalId = 'example-owner';
  run.reviewWorkspaceSubject = {
    repository: 'example/repo',
    repositoryUrl: 'https://example.test/repo.git',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    branch: 'feature',
    title: 'Example',
    body: '',
    capturedAt: '2026-11-05',
  };
  run.reviewWorkspace = {
    workspaceId: run.id,
    machine: 'example',
    executionNodeId: 'local',
    checkoutPath: '/example/runs/cached-review/source',
    taskPath: '',
    artifactPath: '',
  };
  const params = {
    slotId: '',
    runId: run.id,
    base: run.reviewWorkspaceSubject.baseSha,
    head: run.reviewWorkspaceSubject.headSha,
  };
  simulated = true;
  try {
    const expected = { diff: 'frozen diff', mergeBaseSha: params.base, headSha: params.head };
    assert.deepEqual(await gitDiff(params), expected);
    hostCalls = 0;
    assert.deepEqual(await gitDiff(params), expected);
    assert.equal(hostCalls, 0);
    authorized = false;
    await assert.rejects(gitDiff(params), /Owner access revoked/);
    authorized = true;
    await assert.rejects(gitDiff({ ...params, head: 'c'.repeat(40) }), /frozen review commits/);
    assert.equal(hostCalls, 0);
  } finally {
    simulated = false;
    authorized = true;
  }
});
