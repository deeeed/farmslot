import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(path.join(tmpdir(), 'prepare-preserve-'));
after(() => rmSync(root, { recursive: true, force: true }));
for (const name of [
  'scripts',
  'services/gateway',
  'projects/farm',
  'pool',
  'home',
  'runs',
  'bin',
  'base',
])
  mkdirSync(path.join(root, name), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), 'fixture');
writeFileSync(path.join(root, 'scripts/dev.sh'), '');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
writeFileSync(path.join(root, 'bin/tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, '.farm-status.json'),
  NODE_TEST_CONTEXT: '1',
  PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH,
});
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=.git/hooks', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const base = path.join(root, 'base');
git(base, 'init', '-b', 'main');
git(base, 'config', 'user.name', 'Fixture');
git(base, 'config', 'user.email', 'fixture@example.invalid');
git(base, 'config', 'commit.gpgsign', 'false');
writeFileSync(path.join(base, '.gitignore'), '.sandbox\n.task\n.agent\n');
writeFileSync(path.join(base, 'file.txt'), 'base\n');
git(base, 'add', '.');
git(base, 'commit', '-m', 'test: base');
const baseHead = git(base, 'rev-parse', 'HEAD');
const remote = path.join(root, 'remote.git');
execFileSync('git', ['clone', '--bare', base, remote], { stdio: 'ignore' });
git(base, 'remote', 'add', 'origin', remote);
git(base, 'checkout', '-b', 'published-work');
writeFileSync(path.join(base, 'file.txt'), 'published\n');
git(base, 'commit', '-am', 'test: published work');
git(base, 'push', 'origin', 'published-work');
const publishedHead = git(base, 'rev-parse', 'HEAD');
writeFileSync(
  path.join(root, 'projects/farm/project.json'),
  JSON.stringify({
    name: 'farm',
    repo_url: 'https://github.com/example/app.git',
    default_branch: 'main',
    prepare: { default_profile: 'git-only', profiles: { 'git-only': { phases: ['git'] } } },
  }),
);
function freshSlot(label: string): string {
  const slot = path.join(root, label);
  execFileSync('git', ['clone', remote, slot], { stdio: 'ignore' });
  git(slot, 'config', 'user.name', 'Fixture');
  git(slot, 'config', 'user.email', 'fixture@example.invalid');
  git(slot, 'config', 'commit.gpgsign', 'false');
  writeFileSync(
    path.join(root, 'pool/local.json'),
    JSON.stringify({
      machine: 'fixture',
      host: 'localhost',
      project: 'farm',
      platform: 'cli',
      slots: [{ id: 'slot', repo: slot, session: 'slot', enabled: true, resources: {} }],
    }),
  );
  writeFileSync(path.join(root, '.farm-status.json'), JSON.stringify({ slots: [] }));
  return slot;
}

function unpublishedSlot(label: string): { slot: string; head: string } {
  const slot = freshSlot(label);
  git(slot, 'checkout', '-b', 'comparison-work', baseHead);
  writeFileSync(path.join(slot, 'file.txt'), 'worker commit\n');
  git(slot, 'commit', '-am', 'test: unpublished comparison work');
  const head = git(slot, 'rev-parse', 'HEAD');
  writeFileSync(path.join(slot, 'file.txt'), 'uncommitted work\n');
  return { slot, head };
}

writeFileSync(path.join(root, '.farm-status.json'), JSON.stringify({ slots: [] }));
const { slotPrepare } = await import('./prepare.js');
const params = { slotId: 'slot', prepareProfile: 'git-only' };

test('recovery into another clone restores a published branch without overwriting the current branch', async () => {
  const slot = freshSlot('published-slot');
  assert.throws(() => git(slot, 'show-ref', '--verify', 'refs/heads/published-work'));
  await slotPrepare({ ...params, branch: 'published-work' }, () => {}, undefined, {
    preserveBranch: true,
  });
  assert.equal(git(slot, 'rev-parse', 'HEAD'), publishedHead);
  assert.equal(git(slot, 'rev-parse', 'main'), baseHead);
});

test('fresh dev prepare reuses detached parked work without moving its unpublished branch', async () => {
  const slot = freshSlot('parked-slot');
  git(slot, 'checkout', '-b', 'parked-work', baseHead);
  writeFileSync(path.join(slot, 'file.txt'), 'parked worker commit\n');
  git(slot, 'commit', '-am', 'test: parked work');
  const parkedHead = git(slot, 'rev-parse', 'HEAD');
  git(slot, 'checkout', '--detach');
  await slotPrepare(
    { ...params, branch: 'next-work', flowType: 'dev', forceNewBranch: true },
    () => {},
  );
  assert.equal(git(slot, 'rev-parse', 'HEAD'), baseHead);
  assert.equal(git(slot, 'rev-parse', 'parked-work'), parkedHead);
  assert.equal(git(slot, 'show', 'parked-work:file.txt'), 'parked worker commit');
});

test('start-ref recovery preserves unpublished commits and dirty files while recording the frozen base', async () => {
  const { slot, head } = unpublishedSlot('comparison-slot');
  const result = await slotPrepare(
    { ...params, branch: 'comparison-work', flowType: 'dev' },
    () => {},
    undefined,
    {
      preserveBranch: true,
      startRef: { requestedRef: baseHead },
    },
  );
  assert.equal(result.startRef?.resolvedSha, baseHead);
  assert.equal(git(slot, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(path.join(slot, 'file.txt'), 'utf8'), 'uncommitted work\n');
});

test('recovery without a local or published branch fails closed and retains the current work', async () => {
  const { slot, head } = unpublishedSlot('missing-slot');
  await assert.rejects(
    slotPrepare({ ...params, branch: 'missing-work' }, () => {}, undefined, {
      preserveBranch: true,
    }),
    /Replay cannot preserve/,
  );
  assert.equal(git(slot, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(path.join(slot, 'file.txt'), 'utf8'), 'uncommitted work\n');
});

test('QA recovery in a new clone lands on the frozen head even when the published branch moved', async () => {
  const slot = freshSlot('qa-cold-slot');
  const result = await slotPrepare(
    { ...params, branch: 'published-work', flowType: 'qa' },
    () => {},
    undefined,
    {
      preserveBranch: true,
      startRef: { requestedRef: baseHead },
    },
  );
  assert.equal(result.startRef?.resolvedSha, baseHead);
  assert.equal(git(slot, 'rev-parse', 'HEAD'), baseHead);
  assert.equal(git(slot, 'rev-parse', 'origin/published-work'), publishedHead);
});

test('QA recovery refuses a mismatched existing branch without moving it', async () => {
  const slot = freshSlot('qa-existing-slot');
  git(slot, 'checkout', '-b', 'published-work', 'origin/published-work');
  await assert.rejects(
    slotPrepare({ ...params, branch: 'published-work', flowType: 'qa' }, () => {}, undefined, {
      preserveBranch: true,
      startRef: { requestedRef: baseHead },
    }),
    /QA replay requires frozen head/,
  );
  assert.equal(git(slot, 'rev-parse', 'HEAD'), publishedHead);
});

for (const forceNewBranch of [false, true])
  test(`destructive prepare rechecks a cross-clone rewrite before reset, forceNewBranch=${forceNewBranch}`, async () => {
    const slot = freshSlot('rewritten-slot-' + forceNewBranch);
    const author = path.join(root, 'rewrite-author-' + forceNewBranch);
    execFileSync('git', ['clone', remote, author], { stdio: 'ignore' });
    git(author, 'checkout', '-B', 'rewritten-work', 'origin/published-work');
    git(author, 'config', 'user.name', 'Fixture');
    git(author, 'config', 'user.email', 'fixture@example.invalid');
    git(author, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(author, 'unique.txt'), 'only on rewritten branch\n');
    git(author, 'add', 'unique.txt');
    git(author, 'commit', '-m', 'test: remote-only publication');
    git(author, 'push', 'origin', 'rewritten-work');
    git(slot, 'fetch', 'origin');
    git(slot, 'checkout', '-b', 'rewritten-work', 'origin/rewritten-work');
    const head = git(slot, 'rev-parse', 'HEAD');
    await assert.rejects(
      slotPrepare({ ...params, branch: 'rewritten-work', forceNewBranch }, () => {}, undefined, {
        beforeBranchSetup: async () => {
          git(author, 'checkout', '-B', 'rewritten-work', 'origin/main');
          git(author, 'push', '--force', 'origin', 'rewritten-work');
        },
      }),
      /unpushed commits/,
    );
    assert.equal(git(slot, 'rev-parse', 'HEAD'), head);
    assert.equal(git(slot, 'rev-parse', 'refs/heads/rewritten-work'), head);
  });

test('review recovery fast-forwards a stale published head and preserves local-ahead work', async () => {
  const slot = freshSlot('review-advance-slot');
  git(slot, 'checkout', '-b', 'published-work', baseHead);
  const request = { ...params, branch: 'published-work', flowType: 'review-pr' };
  await slotPrepare(request, () => {}, undefined, { preserveBranch: true });
  assert.equal(git(slot, 'rev-parse', 'HEAD'), publishedHead);
  writeFileSync(path.join(slot, 'ahead.txt'), 'local worker\n');
  git(slot, 'add', 'ahead.txt');
  git(slot, 'commit', '-m', 'test: local-ahead work');
  const ahead = git(slot, 'rev-parse', 'HEAD');
  await slotPrepare(request, () => {}, undefined, { preserveBranch: true });
  assert.equal(git(slot, 'rev-parse', 'HEAD'), ahead);
});

test('review recovery refuses diverged history without discarding commits or dirty files', async () => {
  const slot = freshSlot('review-diverged-slot');
  git(slot, 'checkout', '-b', 'published-work', baseHead);
  writeFileSync(path.join(slot, 'file.txt'), 'local divergent work\n');
  git(slot, 'commit', '-am', 'test: divergent work');
  const head = git(slot, 'rev-parse', 'HEAD');
  writeFileSync(path.join(slot, 'dirty.txt'), 'retain me\n');
  await assert.rejects(
    slotPrepare(
      { ...params, branch: 'published-work', flowType: 'review-pr' },
      () => {},
      undefined,
      {
        preserveBranch: true,
      },
    ),
    /cannot safely update.*Local work was preserved/s,
  );
  assert.equal(git(slot, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(path.join(slot, 'dirty.txt'), 'utf8'), 'retain me\n');
});
