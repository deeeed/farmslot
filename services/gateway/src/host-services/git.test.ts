import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { defaultBranchProbeCommand, readDefaultBranchProbe } from '@farmslot/protocol';

import type { GitCheckout } from './git.js';

// Global config comes from this test's own home, for git and for the reader alike.
const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'git-service-'));
const home = path.join(root, 'home');
await mkdir(home);
process.env.HOME = home;
delete process.env.XDG_CONFIG_HOME;
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
// The machine's system config too: git and the reader both take it from GIT_CONFIG_SYSTEM.
process.env.GIT_CONFIG_SYSTEM = path.join(root, 'system-gitconfig');

const gitSvc = await import('./git.js');
const { gitHeadProbeCommand, parseGitHeadProbe, readLocalSlotGit } =
  await import('../methods/fleet.js');

test.after(() => rm(root, { recursive: true, force: true }));

function sh(command: string, cwd = root) {
  const result = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8' });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
}

function git(cwd: string, ...args: string[]): string {
  const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
  const result = spawnSync('git', [...identity, ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

let repos = 0;
async function repo(branch = 'main'): Promise<string> {
  const dir = path.join(root, `repo-${++repos}`);
  git(root, 'init', '-q', '-b', branch, dir);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'a');
  return dir;
}

async function open(dir: string) {
  const checkout = await gitSvc.openGitCheckout(dir);
  assert.ok(checkout, `${dir} opens in-process`);
  return checkout;
}

/** The fleet head probe and branch-watcher command, from git and from the service. */
async function assertHeadMatchesGit(dir: string): Promise<void> {
  const checkout = await open(dir);
  assert.deepEqual(
    await gitSvc.readHeadProbe(checkout),
    parseGitHeadProbe(sh(gitHeadProbeCommand(dir)).stdout),
    `${dir}: rev-parse HEAD / --abbrev-ref HEAD`,
  );
  const head = await gitSvc.readGitHead(checkout);
  assert.equal(head?.kind, 'branch');
  if (head?.kind === 'branch')
    assert.equal(
      await gitSvc.shortenRefName(checkout, head.ref, false),
      sh(`git -C '${dir}' symbolic-ref --short HEAD`).stdout.trim(),
      `${dir}: symbolic-ref --short HEAD`,
    );
}

async function assertDefaultBranchMatchesGit(dir: string, branch = 'main'): Promise<void> {
  const fromGit = readDefaultBranchProbe(sh(defaultBranchProbeCommand(dir, branch)), branch);
  assert.equal(fromGit.readable, true, JSON.stringify(fromGit));
  assert.deepEqual(
    await gitSvc.readDefaultBranchProbeFiles(await open(dir), branch),
    fromGit,
    `${dir}: default-branch probe for ${branch}`,
  );
}

test('HEAD on a branch, loose and packed, reads as git reads it', async () => {
  const dir = await repo();
  await assertHeadMatchesGit(dir);
  git(dir, 'tag', '-a', 'v1', '-m', 'tag');
  git(dir, 'pack-refs', '--all');
  await assertHeadMatchesGit(dir);
  // A loose ref written after packing wins over the packed one.
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'b');
  const probe = await gitSvc.readHeadProbe(await open(dir));
  assert.equal(probe?.headSha, git(dir, 'rev-parse', 'HEAD').trim());
  await assertHeadMatchesGit(dir);
});

test('a detached HEAD reports HEAD and its commit; an unborn branch is left to git', async () => {
  const dir = await repo();
  git(dir, 'checkout', '-q', '--detach');
  const checkout = await open(dir);
  assert.deepEqual(
    await gitSvc.readHeadProbe(checkout),
    parseGitHeadProbe(sh(gitHeadProbeCommand(dir)).stdout),
  );
  assert.deepEqual(await gitSvc.readGitHead(checkout), {
    kind: 'detached',
    sha: git(dir, 'rev-parse', 'HEAD').trim(),
  });

  const unborn = path.join(root, 'unborn');
  git(root, 'init', '-q', '-b', 'main', unborn);
  const empty = await open(unborn);
  assert.deepEqual(await gitSvc.readGitHead(empty), {
    kind: 'branch',
    ref: 'refs/heads/main',
    sha: null,
  });
  // rev-parse prints its argument for an unborn HEAD; that output stays git's to give.
  assert.equal(await gitSvc.readHeadProbe(empty), undefined);
  assert.equal(
    await gitSvc.shortenRefName(empty, 'refs/heads/main', false),
    sh(`git -C '${unborn}' symbolic-ref --short HEAD`).stdout.trim(),
  );
});

test('ambiguous branch names shorten as rev-parse and symbolic-ref shorten them', async () => {
  const dir = await repo('foo');
  git(dir, 'tag', 'foo');
  await assertHeadMatchesGit(dir); // heads/foo in both modes
  git(dir, 'tag', '-d', 'foo');
  git(dir, 'update-ref', 'refs/remotes/foo', 'HEAD');
  await assertHeadMatchesGit(dir); // strict heads/foo, loose foo
  git(dir, 'config', 'core.warnAmbiguousRefs', 'false');
  await assertHeadMatchesGit(dir);
  git(dir, 'config', '--unset', 'core.warnAmbiguousRefs');
  git(dir, 'update-ref', '-d', 'refs/remotes/foo');
  git(dir, 'checkout', '-q', '-b', 'origin');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  await assertHeadMatchesGit(dir); // origin/HEAD resolves: heads/origin
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
  await assertHeadMatchesGit(dir); // a dangling symref is no competitor
  git(dir, 'pack-refs', '--all');
  await assertHeadMatchesGit(dir);
});

test('linked worktrees and separate git directories resolve through their .git file', async () => {
  const dir = await repo();
  const linked = path.join(root, 'linked');
  git(dir, 'worktree', 'add', '-q', linked, '-b', 'feature');
  const checkout = await open(linked);
  assert.equal(checkout.gitDir, path.join(dir, '.git', 'worktrees', 'linked'));
  assert.equal(checkout.commonDir, path.join(dir, '.git'));
  assert.equal(
    path.join(checkout.gitDir, 'HEAD'),
    git(linked, 'rev-parse', '--git-path', 'HEAD').trim(),
  );
  await assertHeadMatchesGit(linked);
  await assertDefaultBranchMatchesGit(linked);
  assert.equal(await gitSvc.isGitFile(linked), true);
  assert.equal(await gitSvc.isGitFile(dir), false);

  // A submodule's .git file has no commondir: its git directory holds everything.
  const separate = path.join(root, 'separate');
  git(
    root,
    'init',
    '-q',
    '-b',
    'main',
    `--separate-git-dir=${path.join(root, 'separate.git')}`,
    separate,
  );
  git(separate, 'commit', '-q', '--allow-empty', '-m', 'a');
  const module = await open(separate);
  assert.equal(module.commonDir, module.gitDir);
  assert.equal(await gitSvc.isGitFile(separate), true);
  await assertHeadMatchesGit(separate);
});

test('missing, unreadable and non-root checkouts are left to git', async () => {
  const missing = path.join(root, 'missing');
  assert.equal(await gitSvc.openGitCheckout(missing), undefined);
  assert.equal(await gitSvc.isGitFile(missing), sh(`test -f '${missing}/.git'`).exitCode === 0);

  // git searches parent directories from a directory without .git.
  const dir = await repo();
  await mkdir(path.join(dir, 'sub'));
  assert.equal(await gitSvc.openGitCheckout(path.join(dir, 'sub')), undefined);

  const locked = await repo();
  const checkout = await open(locked);
  await chmod(path.join(locked, '.git', 'HEAD'), 0o000);
  try {
    assert.equal(await gitSvc.readGitHead(checkout), undefined);
    assert.equal(await gitSvc.readHeadProbe(checkout), undefined);
    assert.notEqual(sh(`git -C '${locked}' rev-parse HEAD`).exitCode, 0);
  } finally {
    await chmod(path.join(locked, '.git', 'HEAD'), 0o644);
  }

  const broken = await repo();
  await writeFile(path.join(broken, '.git', 'refs', 'heads', 'main'), 'not a sha\n');
  assert.equal(await gitSvc.readHeadProbe(await open(broken)), undefined);
});

test('the default-branch probe reads config and refs as the git probe does', async () => {
  const dir = await repo();
  // No origin: no fetch refspec.
  await assertDefaultBranchMatchesGit(dir);
  git(dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
  await assertDefaultBranchMatchesGit(dir); // refspec, no origin/main
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await assertDefaultBranchMatchesGit(dir);
  git(dir, 'pack-refs', '--all');
  await assertDefaultBranchMatchesGit(dir);
  await assertDefaultBranchMatchesGit(dir, 'develop');
  // Single-branch clone refspec, an exclusion, a valueless entry, quoting and comments.
  git(
    dir,
    'config',
    '--replace-all',
    'remote.origin.fetch',
    '+refs/heads/other:refs/remotes/origin/other',
  );
  await assertDefaultBranchMatchesGit(dir);
  await writeFile(
    path.join(dir, '.git', 'config'),
    `[remote "origin"]\n\tfetch = "+refs/heads/*:refs/remotes/origin/*" ; comment\n\tfetch = ^refs/heads/main\n\tfetch\n`,
    { flag: 'a' },
  );
  await assertDefaultBranchMatchesGit(dir);
  git(dir, 'config', 'farmslot.blindRun', 'trial-1');
  await assertDefaultBranchMatchesGit(dir);
  // A dangling remote symref is not listed.
  git(dir, 'config', '--unset', 'farmslot.blindRun');
  git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
  git(dir, 'symbolic-ref', 'refs/remotes/origin/main', 'refs/remotes/origin/gone');
  await assertDefaultBranchMatchesGit(dir);
});

test('config that git rejects or that includes other files is left to git', async () => {
  const dir = await repo();
  const checkout = await open(dir);
  assert.ok(await gitSvc.readGitConfig(checkout));
  await writeFile(
    path.join(home, '.gitconfig'),
    '[includeIf "gitdir:/elsewhere/"]\n\tpath = other\n',
  );
  assert.equal(await gitSvc.readGitConfig(checkout), undefined);
  assert.equal(await gitSvc.readDefaultBranchProbeFiles(checkout, 'main'), undefined);
  await writeFile(path.join(home, '.gitconfig'), '[farmslot]\n\tblindRun = from-global\n');
  await assertDefaultBranchMatchesGit(dir);
  await rm(path.join(home, '.gitconfig'));
  await writeFile(path.join(dir, '.git', 'config'), '[core]\n\tbad = "unterminated\n', {
    flag: 'a',
  });
  assert.equal(await gitSvc.readGitConfig(checkout), undefined);
  assert.equal(sh(defaultBranchProbeCommand(dir, 'main')).stdout.includes('fetch-exit=128'), true);
});

test('the config parser matches git config --list', async () => {
  const sources = [
    '[core]\n\tbare = false\n[remote "origin"]\n\turl = x\n',
    '\uFEFF# comment\n; other\n[Section.Sub]\nKey=Value\n[a "B\\"c\\\\d"] k = v # trailing\n',
    '[s]\n\tk = "quoted ; # value"  \n\tk = a\\tb\\nc\\\\d\\"e\n\tk = one \\\n  two\n\tk\n\tk =\n\tk = in  ner space  \n\tk = " in"  "quotes "  \n',
    '[s]\r\n\tk = crlf\r\n[t "sub"]x = 1\n',
  ];
  for (const [index, source] of sources.entries()) {
    const file = path.join(root, `config-${index}`);
    await writeFile(file, source);
    const listed = git(root, 'config', '--file', file, '--list', '-z')
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const split = entry.indexOf('\n');
        return split < 0 ? [entry, null] : [entry.slice(0, split), entry.slice(split + 1)];
      });
    assert.deepEqual(gitSvc.parseGitConfig(source), listed, `config ${index}`);
  }
  for (const rejected of [
    '[s]\n\tk = "open\n',
    '[s]\n\tk = bad\\q\n',
    '[s\n',
    '[s "x]\n',
    '[s]\n\t1k = v\n',
  ]) {
    const file = path.join(root, 'rejected');
    await writeFile(file, rejected);
    assert.notEqual(sh(`git config --file '${file}' --list`).exitCode, 0, rejected);
    assert.equal(gitSvc.parseGitConfig(rejected), undefined, rejected);
  }
  assert.equal(gitSvc.parseGitConfig('[include]\n\tpath = x\n'), undefined);
  // A key before any section is git's own case.
  assert.equal(gitSvc.parseGitConfig('k = v\n'), undefined);
  // An inner tab reads differently across git versions.
  assert.equal(gitSvc.parseGitConfig('[s]\n\tk = a\tb\n'), undefined);
});

test('origin/HEAD reads as git symbolic-ref --quiet --short reads it', async () => {
  const dir = await repo();
  const checkout = await open(dir);
  const fromGit = () => {
    const result = sh(`git -C '${dir}' symbolic-ref --quiet --short refs/remotes/origin/HEAD`);
    return result.exitCode === 0 ? result.stdout.trim() : result.exitCode === 1 ? null : 'error';
  };
  const read = () => gitSvc.readSymbolicRefShort(checkout, 'refs/remotes/origin/HEAD');
  assert.equal(await read(), fromGit()); // missing
  git(dir, 'update-ref', 'refs/remotes/origin/HEAD', 'HEAD');
  assert.equal(await read(), fromGit()); // not symbolic
  git(dir, 'update-ref', '-d', 'refs/remotes/origin/HEAD');
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  assert.equal(await read(), fromGit()); // dangling target
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'pack-refs', '--all');
  assert.equal(await read(), fromGit());
  assert.equal(await read(), 'origin/main');
});

test('fleet refresh reads a local slot from its files and leaves a remote slot to its probes', async () => {
  const dir = await repo();
  git(dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const linked = path.join(root, 'fleet-linked');
  git(dir, 'worktree', 'add', '-q', linked, '-b', 'wt/slot-1');
  const local = { host: 'localhost', machine: 'git-service-test', remoteRepo: linked };
  assert.deepEqual(await readLocalSlotGit(local, 'main'), {
    head: parseGitHeadProbe(sh(gitHeadProbeCommand(linked)).stdout),
    linked: sh(`test -f '${linked}/.git'`).exitCode === 0,
    defaultBranch: readDefaultBranchProbe(sh(defaultBranchProbeCommand(linked, 'main')), 'main'),
  });
  // Without a project config there is no default branch to check.
  assert.equal((await readLocalSlotGit(local, undefined)).defaultBranch, undefined);
  // A missing checkout answers only `test -f`; git keeps the rest.
  assert.deepEqual(
    await readLocalSlotGit({ ...local, remoteRepo: path.join(root, 'gone') }, 'main'),
    {
      linked: false,
    },
  );
  assert.deepEqual(await readLocalSlotGit({ ...local, host: 'remote.invalid' }, 'main'), {});
});

/** What a caller reads: the service's file answer when the checkout opens, otherwise git's. */
async function serviceOrGit<T>(
  dir: string,
  files: (checkout: GitCheckout) => Promise<T>,
  fromGit: () => T,
): Promise<T> {
  const checkout = await gitSvc.openGitCheckout(dir);
  return checkout ? files(checkout) : fromGit();
}

test('a reftable repository is left to git, which reads its refs', async (t) => {
  const dir = path.join(root, 'reftable');
  const created = sh(`git init -q --ref-format=reftable -b main '${dir}'`);
  if (created.exitCode !== 0) {
    t.skip(`this git cannot create a reftable repository: ${created.stderr.trim()}`);
    return;
  }
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'a');
  git(dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const originHead = () => {
    const result = sh(`git -C '${dir}' symbolic-ref --quiet --short refs/remotes/origin/HEAD`);
    return result.exitCode === 0 ? result.stdout.trim() : result.exitCode === 1 ? null : 'error';
  };
  assert.equal(originHead(), 'origin/main');
  assert.equal(
    await serviceOrGit(
      dir,
      (checkout) => gitSvc.readSymbolicRefShort(checkout, 'refs/remotes/origin/HEAD'),
      originHead,
    ),
    'origin/main',
  );
  const probe = () => readDefaultBranchProbe(sh(defaultBranchProbeCommand(dir, 'main')), 'main');
  assert.deepEqual(
    await serviceOrGit(
      dir,
      (checkout) => gitSvc.readDefaultBranchProbeFiles(checkout, 'main'),
      probe,
    ),
    probe(),
  );
  assert.equal(await gitSvc.openGitCheckout(dir), undefined);
  // The same repository on the files backend, declared explicitly, still reads from its files.
  const files = path.join(root, 'files-declared');
  git(root, 'init', '-q', '--ref-format=files', '-b', 'main', files);
  git(files, 'commit', '-q', '--allow-empty', '-m', 'a');
  git(files, 'config', 'core.repositoryformatversion', '1');
  git(files, 'config', 'extensions.refStorage', 'files');
  await assertHeadMatchesGit(files);
});

test('a global config git rejects makes every read fail as git fails', async (t) => {
  const dir = await repo();
  git(dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.ok(await gitSvc.openGitCheckout(dir));
  await writeFile(path.join(home, '.gitconfig'), '[core\n');
  t.after(() => rm(path.join(home, '.gitconfig'), { force: true }));
  // Every git command the file readers stand in for loads the config first and dies on it.
  for (const command of [
    'rev-parse HEAD',
    'rev-parse --abbrev-ref HEAD',
    'symbolic-ref --quiet --short HEAD',
    'for-each-ref refs/remotes/origin/main',
    'config --get-all remote.origin.fetch',
  ])
    assert.equal(sh(`git -C '${dir}' ${command}`).exitCode, 128, command);
  // So no read answers from the files: each caller falls back to git and meets the same failure.
  assert.equal(await gitSvc.openGitCheckout(dir), undefined);
  const local = { host: 'localhost', machine: 'git-service-test', remoteRepo: dir };
  assert.deepEqual(await readLocalSlotGit(local, 'main'), { linked: false });
  assert.equal((await gitSvc.gitService.run(['rev-parse', 'HEAD'], { cwd: dir })).exitCode, 128);
});

/** Replace a config file through a rename, so its identity changes as git's own writes change it. */
async function replaceConfig(file: string, text: string): Promise<void> {
  await writeFile(`${file}.next`, text);
  await rename(`${file}.next`, file);
}

/** One variable as a config file line; null writes a bare key. */
function configEntry(name: string, value: string | null): string {
  const dot = name.lastIndexOf('.');
  const [section, ...sub] = name.slice(0, dot).split('.');
  const header = sub.length ? `[${section} "${sub.join('.')}"]` : `[${section}]`;
  return `${header}\n\t${name.slice(dot + 1)}${value === null ? '' : ` = ${value}`}\n`;
}

test('a config value git refuses leaves every read to git', async () => {
  const dir = await repo();
  const localFile = path.join(dir, '.git', 'config');
  const globalFile = path.join(home, '.gitconfig');
  const local = await readFile(localFile, 'utf8');
  assert.ok(await gitSvc.openGitCheckout(dir));
  // Each makes git exit 128 at startup (temp/git-config-probe.zsh, git 2.54). The repository
  // format variables only count in the repository's own config.
  const refused: Array<[scope: 'global' | 'local' | 'both', name: string, value: string | null]> = [
    ['both', 'core.bare', 'garbage'],
    ['both', 'core.bare', '99999999999'],
    ['both', 'core.compression', '10'],
    ['both', 'core.abbrev', '3'],
    ['both', 'core.checkstat', 'garbage'],
    ['both', 'core.editor', null],
    ['both', 'core.packedgitlimit', '99999999999999999999'],
    ['both', 'core.packedgitwindowsize', '-1'],
    ['both', 'core.warnambiguousrefs', 'garbage'],
    ['local', 'core.logallrefupdates', null],
    ['local', 'core.repositoryformatversion', 'garbage'],
    ['local', 'extensions.objectformat', 'garbage'],
    ['local', 'extensions.preciousobjects', 'garbage'],
    ['both', 'advice.detachedhead', 'garbage'],
    ['both', 'push.default', 'garbage'],
    ['both', 'push.default', null],
    ['both', 'branch.autosetupmerge', 'garbage'],
    ['both', 'branch.autosetuprebase', 'garbage'],
    ['both', 'pack.packsizelimit', 'garbage'],
    ['both', 'pager.color', 'garbage'],
    ['both', 'color.pager', 'auto'],
    ['both', 'color.advice', 'garbage'],
    ['both', 'user.name', null],
    ['both', 'author.name', null],
    ['both', 'i18n.commitencoding', null],
    ['both', 'index.version', null],
    ['both', 'index.skiphash', 'garbage'],
    ['both', 'feature.experimental', 'garbage'],
    ['both', 'sparse.expectfilesoutsideofpatterns', 'garbage'],
    ['both', 'fetch.negotiationalgorithm', 'garbage'],
    ['both', 'gc.writecommitgraph', 'garbage'],
  ];
  try {
    for (const [scope, name, value] of refused)
      for (const where of scope === 'both' ? (['global', 'local'] as const) : [scope]) {
        const label = `${where} ${name}=${value ?? '(bare)'}`;
        if (where === 'global') await replaceConfig(globalFile, configEntry(name, value));
        else await replaceConfig(localFile, local + configEntry(name, value));
        assert.equal(sh(`git -C '${dir}' rev-parse HEAD`).exitCode, 128, `git: ${label}`);
        assert.equal(await gitSvc.openGitCheckout(dir), undefined, `service: ${label}`);
        if (where === 'global') await rm(globalFile);
        else await replaceConfig(localFile, local);
      }
  } finally {
    await rm(globalFile, { force: true });
    await replaceConfig(localFile, local);
  }
});

test('a usual config is read from its files, with the answers git gives', async () => {
  const dir = await repo();
  git(dir, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  // The variables of this repository's and this machine's configs, by name, with usual values.
  const globalFile = path.join(home, '.gitconfig');
  await replaceConfig(
    globalFile,
    [
      ['user.name', 'Proof'],
      ['user.email', 'proof@example.invalid'],
      ['user.signingkey', '/tmp/key.pub'],
      ['core.pager', 'less -R'],
      ['push.autosetupremote', 'true'],
      ['init.defaultbranch', 'main'],
      ['commit.gpgsign', 'true'],
      ['gpg.format', 'ssh'],
      ['credential.helper', 'osxkeychain'],
      ['credential.https://example.invalid.helper', 'store'],
      ['filter.lfs.required', 'true'],
      ['filter.lfs.clean', 'git-lfs clean -- %f'],
      ['http.postbuffer', '524288000'],
    ]
      .map(([name, value]) => configEntry(name, value))
      .join(''),
  );
  try {
    git(dir, 'config', 'core.quotepath', 'false');
    git(dir, 'config', 'core.hookspath', '.githooks');
    git(dir, 'config', 'branch.main.remote', 'origin');
    git(dir, 'config', 'branch.main.merge', 'refs/heads/main');
    git(dir, 'config', 'gpg.ssh.allowedsignersfile', '/tmp/allowed');
    assert.equal(sh(`git -C '${dir}' rev-parse HEAD`).exitCode, 0);
    await assertHeadMatchesGit(dir);
    await assertDefaultBranchMatchesGit(dir);
  } finally {
    await rm(globalFile, { force: true });
  }
});
