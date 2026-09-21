import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { updateCheckout } from '../update-checkout.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'checkout-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote = join(dir, 'remote.git');
  const publisher = join(dir, 'publisher');
  const root = join(dir, 'checkout');
  const git = (cwd, ...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
      { cwd, encoding: 'utf8', stdio: 'pipe' },
    ).trim();
  git(dir, 'init', '--bare', '--initial-branch=main', remote);
  git(dir, 'clone', remote, publisher);
  await writeFile(join(publisher, 'README.md'), 'before\n');
  await writeFile(join(publisher, 'package.json'), '{"version":"1.0.0"}\n');
  git(publisher, 'add', '.');
  git(publisher, 'commit', '-m', 'chore: initialize fixture');
  git(publisher, 'push', 'origin', 'main');
  git(dir, 'clone', remote, root);
  const localSha = git(root, 'rev-parse', 'HEAD');
  const publish = async (file = 'README.md', content = 'after\n') => {
    await writeFile(join(publisher, file), content);
    git(publisher, 'add', '.');
    git(publisher, 'commit', '-m', 'fix: advance fixture');
    git(publisher, 'push', 'origin', 'main');
    return git(publisher, 'rev-parse', 'HEAD');
  };
  const run = async (targetSha) => {
    const record = join(root, '.git/farmslot-checkout-update.json');
    await mkdir(`${record}.lock`);
    await writeFile(
      record,
      JSON.stringify({
        id: 'test',
        phase: 'running',
        localSha: git(root, 'rev-parse', 'HEAD'),
        targetSha,
        updatedAt: new Date().toISOString(),
      }),
    );
    await updateCheckout(root, record);
    return JSON.parse(await readFile(record, 'utf8'));
  };
  return { root, localSha, publish, run, git };
}

test('updates a clean checkout and leaves FETCH_HEAD alone', async (t) => {
  const f = await fixture(t);
  const target = await f.publish();
  await writeFile(join(f.root, '.git/FETCH_HEAD'), 'operator-owned fetch receipt\n');
  const result = await f.run(target);
  assert.equal(result.phase, 'complete');
  assert.equal(f.git(f.root, 'rev-parse', 'HEAD'), target);
  assert.equal(await readFile(join(f.root, 'README.md'), 'utf8'), 'after\n');
  assert.equal(
    await readFile(join(f.root, '.git/FETCH_HEAD'), 'utf8'),
    'operator-owned fetch receipt\n',
  );
});
for (const kind of ['dirty', 'branch', 'diverged', 'stale-target', 'dependencies']) {
  test(`refuses ${kind} without changing the checkout`, async (t) => {
    const f = await fixture(t);
    let target = await f.publish(
      kind === 'dependencies' ? 'package.json' : 'README.md',
      kind === 'dependencies' ? '{"dependencies":{"example":"1.0.0"}}' : 'after\n',
    );
    if (kind === 'dirty') await writeFile(join(f.root, 'local.txt'), 'keep this');
    if (kind === 'branch') f.git(f.root, 'checkout', '-b', 'feature');
    if (kind === 'diverged') {
      await writeFile(join(f.root, 'local.txt'), 'keep this');
      f.git(f.root, 'add', '.');
      f.git(f.root, 'commit', '-m', 'feat: local work');
    }
    if (kind === 'stale-target') target = f.localSha;
    const before = f.git(f.root, 'rev-parse', 'HEAD');
    const result = await f.run(target);
    assert.equal(result.phase, 'error');
    assert.equal(f.git(f.root, 'rev-parse', 'HEAD'), before);
    if (kind === 'dirty')
      assert.equal(await readFile(join(f.root, 'local.txt'), 'utf8'), 'keep this');
  });
}

test('version-only manifest changes do not require dependency installation', async (t) => {
  const f = await fixture(t);
  const target = await f.publish('package.json', '{"version":"1.0.1"}\n');
  assert.equal((await f.run(target)).phase, 'complete');
});

test('preserves ignored files when an incoming commit would overwrite them', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, '.git/info/exclude'), 'collision.txt\n');
  await writeFile(join(f.root, 'collision.txt'), 'private local content');
  const target = await f.publish('collision.txt', 'incoming content');
  assert.equal((await f.run(target)).phase, 'error');
  assert.equal(f.git(f.root, 'rev-parse', 'HEAD'), f.localSha);
  assert.equal(await readFile(join(f.root, 'collision.txt'), 'utf8'), 'private local content');
});
