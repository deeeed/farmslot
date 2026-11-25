import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A remote slot: its node answers fs.delete of a missing path with ENOENT, as
// services/node's rm without force does.
const { deleteStaleReceipt, sourceBuildRefusal } = await import('./pinned-prepare.js');
const present = new Set<string>();
const deletes: string[] = [];
const remote = {
  host: 'macwork-mm-2.invalid',
  machine: 'macwork-mm-2-node',
  sshTarget: 'fixture@macwork-mm-2.invalid',
  nodeRequest: async (method: string, params: unknown) => {
    const { root, relPath } = params as { root: string; relPath: string };
    const file = path.join(root, relPath);
    if (method === 'fs.exists') return { exists: present.has(file) };
    if (method === 'fs.delete') {
      deletes.push(file);
      if (!present.has(file))
        throw Object.assign(new Error(`ENOENT: no such file, rm '${file}'`), { code: 'ENOENT' });
      present.delete(file);
      return {};
    }
    throw new Error(`unexpected ${method}`);
  },
};

test('the first pinned prepare on a remote slot deletes nothing when no receipt exists', async () => {
  const receipt = '/slot/.agent/prepare-artifact.json';
  await deleteStaleReceipt(remote, receipt);
  assert.deepEqual(deletes, [], 'a missing receipt is not sent to fs.delete');
  present.add(receipt);
  await deleteStaleReceipt(remote, receipt);
  assert.deepEqual(deletes, [receipt]);
  assert.equal(present.size, 0);
});

const repo = mkdtempSync(path.join(tmpdir(), 'pinned-source-'));
after(() => rmSync(repo, { recursive: true, force: true }));
const git = (...args: string[]) =>
  execFileSync(
    'git',
    ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
    {
      encoding: 'utf8',
    },
  ).trim();
const runGit = async (command: string) => {
  try {
    execFileSync('bash', ['-c', command]);
    return { exitCode: 0 };
  } catch (error) {
    return { exitCode: (error as { status?: number }).status ?? 1 };
  }
};

test('a source build is accepted at the start or on a descendant, refused anywhere else', async () => {
  git('init', '-q', '--initial-branch=main');
  writeFileSync(path.join(repo, 'a'), 'a\n');
  git('add', 'a');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(path.join(repo, 'b'), 'b\n');
  git('add', 'b');
  git('commit', '-q', '-m', 'worker commit');
  const descendant = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--orphan', 'other');
  git('commit', '-q', '--allow-empty', '-m', 'unrelated');
  const unrelated = git('rev-parse', 'HEAD');

  assert.equal(await sourceBuildRefusal(repo, base, base, runGit), undefined);
  assert.equal(
    await sourceBuildRefusal(repo, base, descendant, runGit),
    undefined,
    'a prepare replay keeps worker commits',
  );
  assert.match(
    (await sourceBuildRefusal(repo, base, unrelated, runGit)) ?? '',
    new RegExp(`source build of ${unrelated}, which does not descend from the run's start ${base}`),
  );
  assert.match(
    (await sourceBuildRefusal(repo, descendant, base, runGit)) ?? '',
    /does not descend/,
    'an ancestor of the start is not a build of it',
  );
});
