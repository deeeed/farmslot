import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';

let run: Run;
mock.module('../runs/store.js', {
  namedExports: { getRunWithArchived: async () => run },
});
mock.module('../security/native-worker-owner.js', {
  namedExports: { assertNativeRunOwner() {} },
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
