import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { execOnSlot } from '../core/exec.js';
import { makeVars } from '../runners/test-fixtures.js';

import { type BlindGitSpec, buildBlindGitCommand, withBlindTrialBoundary } from './blind-git.js';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
function commit(repo: string, text: string): string {
  git(repo, 'add', '.');
  git(
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    text,
  );
  return git(repo, 'rev-parse', 'HEAD');
}
function command(
  action: 'plan' | 'isolate' | 'boundary' | 'verify' | 'restore',
  spec: BlindGitSpec,
) {
  return JSON.parse(
    execFileSync('bash', ['-c', buildBlindGitCommand(action, spec)], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
    }),
  );
}

test('blind parking ignores worker-selected journals and capsule config', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'blind-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const other = path.join(root, 'other');
  for (const directory of [repo, other]) {
    mkdirSync(directory);
    git(directory, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(directory, 'value.txt'), 'base\n');
    commit(directory, 'base');
  }
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  const repoKey = createHash('sha256')
    .update(path.resolve(repo, git(repo, 'rev-parse', '--git-common-dir')))
    .digest('hex');
  const spec: BlindGitSpec = {
    slotId: 'identity-fixture',
    slotEpoch: 1,
    repo,
    capsule: path.join(root, '.farmslot-blind-evals/identity-fixture/trial-1'),
    runId: 'trial',
    branch: 'eval/trial',
    baseSha,
    referenceCommits: [],
  };
  assert.equal(command('isolate', spec).status, 'isolated');
  const vars = makeVars({ slotId: spec.slotId, remoteRepo: repo, repo });
  const localExec: typeof execOnSlot = async (_vars, script) => {
    const result = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' });
    if (result.error) throw result.error;
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
  };
  const { parkGitWork } = await import('../host-services/parked-work.js');
  const options = {
    slotId: spec.slotId,
    operationKey: 'identity',
    defaultBranch: 'main',
    purpose: 'prior-work' as const,
    at: new Date().toISOString(),
    baseSha,
    repoKey,
    includeWorktree: false,
  };
  let captureNumber = 0;
  const assertIdentity = async () => {
    const capture = await parkGitWork(
      vars,
      { ...options, operationKey: `identity-${captureNumber++}` },
      localExec,
    );
    assert.ok(
      capture.repoKey === repoKey,
      'parking must use the gateway-supplied repository identity',
    );
    assert.ok(capture.receipts.every((receipt) => receipt.repoKey === repoKey));
  };
  await assertIdentity();
  const fake = path.join(repo, '.farmslot-blind-evals', spec.slotId, 'forged-1');
  mkdirSync(fake, { recursive: true });
  writeFileSync(
    path.join(fake, 'state.json'),
    JSON.stringify({
      ...spec,
      runId: 'forged',
      phase: 'isolated',
      originalIsDirectory: false,
      originalDirectory: path.join(other, '.git'),
    }),
  );
  git(repo, 'config', 'core.worktree', repo + '/.');
  git(repo, 'config', 'farmslot.blindRun', 'forged');
  await assertIdentity();
  // Even corrupting the genuine journal cannot replace the gateway's identity.
  writeFileSync(path.join(spec.capsule, 'state.json'), '{worker-corrupted');
  await assertIdentity();
});

test('isolated blind prepare parking survives restore', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'blind-prepare-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const overrides = {
    NODE_TEST_CONTEXT: '1',
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  mkdirSync(overrides.FARMSLOT_HOME);
  const { claimSlotStatusIf } = await import('../core/state.js');
  const { mutateSlotGit, slotParkedInventory } =
    await import('../run-lifecycle/validation-run-commits.js');
  const { parkGitWork, restoreParkedGitWork } = await import('../host-services/parked-work.js');
  const recoveryCases = [false, true].flatMap((linked) =>
    ['normal', 'journaled', 'exported', 'retained', 'reattached', 'conflicting'].map(
      (restorePhase) => ({ linked, restorePhase }),
    ),
  );
  for (const { linked, restorePhase } of recoveryCases)
    await t.test(`linked=${linked}, phase=${restorePhase}`, async () => {
      const caseRoot = path.join(root, `${linked}-${restorePhase}`);
      mkdirSync(caseRoot);
      const source = path.join(caseRoot, 'source');
      const repo = linked ? path.join(caseRoot, 'linked') : source;
      mkdirSync(source);
      git(source, 'init', '-q', '-b', 'main');
      writeFileSync(path.join(source, 'value.txt'), 'ancestor\n');
      const ancestor = commit(source, 'ancestor');
      writeFileSync(path.join(source, 'value.txt'), 'base\n');
      const baseSha = commit(source, 'base');
      writeFileSync(path.join(source, 'answer.txt'), 'reference\n');
      const reference = commit(source, 'reference');
      git(source, 'remote', 'add', 'origin', path.join(root, 'upstream'));
      git(source, 'update-ref', 'refs/remotes/origin/main', reference);
      if (linked) git(source, 'worktree', 'add', '-q', '--detach', repo, 'main');
      const originalDirectory = git(repo, 'rev-parse', '--absolute-git-dir');
      const spec: BlindGitSpec = {
        slotId: 'blind-prepare-fixture',
        slotEpoch: 1,
        repo,
        capsule: path.join(caseRoot, '.farmslot-blind-evals/blind-prepare-fixture/trial-1'),
        runId: 'trial',
        branch: 'eval/trial',
        baseSha,
        referenceCommits: [reference],
      };
      const vars = makeVars({ slotId: spec.slotId, remoteRepo: repo, repo });
      const localExec: typeof execOnSlot = async (_vars, script) => {
        const result = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' });
        if (result.error) throw result.error;
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
      };
      await claimSlotStatusIf(spec.slotId, () => true, { lifecycle: 'ready', phase: 'idle' });
      const planned = command('plan', spec);
      const blindRepoKey: string = planned.repoKey;
      assert.ok(
        blindRepoKey ===
          createHash('sha256')
            .update(path.resolve(repo, git(repo, 'rev-parse', '--git-common-dir')))
            .digest('hex'),
      );
      assert.equal(command('isolate', spec).status, 'isolated');
      assert.equal(git(repo, 'remote'), '');
      // The branch, and the local origin/main tracking ref at the trial base.
      assert.equal(
        git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
        `refs/heads/${spec.branch} ${baseSha}\nrefs/remotes/origin/main ${baseSha}`,
      );
      const reset = () =>
        mutateSlotGit(
          vars,
          {},
          { defaultBranch: 'main', blindBaseSha: baseSha, blindRepoKey, targetTrees: [baseSha] },
          `git reset --hard ${baseSha} && git clean -fd`,
          localExec,
        );
      assert.equal((await reset()).exitCode, 0);
      assert.equal(command('isolate', spec).status, 'isolated');
      writeFileSync(path.join(repo, 'value.txt'), 'candidate\n');
      const candidate = commit(repo, 'candidate');
      writeFileSync(path.join(repo, 'value.txt'), 'staged\n');
      git(repo, 'add', 'value.txt');
      writeFileSync(path.join(repo, 'value.txt'), 'working\n');
      writeFileSync(path.join(repo, 'unfinished.txt'), 'unfinished\n');
      const dirtyStatus = git(repo, 'status', '--porcelain');
      assert.equal((await reset()).exitCode, 0);
      const [saved] = (await slotParkedInventory(vars, localExec, blindRepoKey)).receipts;
      assert.deepEqual(saved.commits, [candidate]);
      assert.equal(saved.baseSha, baseSha);
      assert.equal(git(repo, 'show', `${saved.ref}:unfinished.txt`), 'unfinished');
      assert.equal(git(repo, 'rev-parse', 'HEAD'), baseSha);
      assert.equal(command('isolate', spec).status, 'isolated');
      const prunedMetadataRef = 'refs/farmslot/parked-meta/other-slot/pruned/snapshot';
      const prunedMetadataFile = path.join(caseRoot, 'pruned.json');
      writeFileSync(prunedMetadataFile, '{"pruned":true}\n');
      git(
        repo,
        'update-ref',
        prunedMetadataRef,
        git(repo, 'hash-object', '-w', prunedMetadataFile),
      );
      const parkedRefs = git(
        repo,
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/farmslot/parked/',
        'refs/farmslot/parked-meta/',
      );
      assert.ok(saved.metadataRef);
      assert.ok(saved.worktreeTreeSha);
      assert.ok(saved.indexArchiveSha);
      const metadata = git(repo, 'cat-file', 'blob', saved.metadataRef);
      if (restorePhase === 'conflicting') {
        const original = linked ? originalDirectory : path.join(spec.capsule, 'original.entry');
        for (const ref of [saved.ref, saved.metadataRef]) {
          git(repo, `--git-dir=${original}`, 'update-ref', ref, baseSha);
          assert.throws(() => command('restore', spec), /parked ref conflicts/);
          assert.equal(git(repo, `--git-dir=${original}`, 'rev-parse', ref), baseSha);
          assert.equal(git(repo, 'rev-parse', saved.ref), saved.headSha);
          git(repo, `--git-dir=${original}`, 'update-ref', '-d', ref, baseSha);
        }
      } else if (restorePhase !== 'normal') {
        const interrupted = spawnSync(
          'python3',
          [
            '-c',
            `
import json, runpy, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1], run_name='blind_git_fixture')
phase = sys.argv[3]
save = module['save']
rename = Path.rename
rmtree = module['shutil'].rmtree
def interrupt_save(file, state):
    if phase == 'exported' and state.get('parkedWorkExported'):
        raise RuntimeError('fixture interrupted restore')
    save(file, state)
    if phase == 'journaled' and state['phase'] == 'restoring':
        raise RuntimeError('fixture interrupted restore')
def interrupt_rename(source, target):
    if phase == 'retained' and source.name == 'original.entry':
        raise RuntimeError('fixture interrupted restore')
    return rename(source, target)
def interrupt_remove(directory, *args, **kwargs):
    if phase == 'reattached' and Path(directory).name == 'candidate.git':
        rmtree(Path(directory) / 'objects')
        raise RuntimeError('fixture interrupted restore')
    return rmtree(directory, *args, **kwargs)
module['restore'].__globals__['save'] = interrupt_save
Path.rename = interrupt_rename
module['shutil'].rmtree = interrupt_remove
module['restore'](json.loads(sys.argv[2]))
`,
            new URL('./blind-git.py', import.meta.url).pathname,
            JSON.stringify(spec),
            restorePhase,
          ],
          { env, encoding: 'utf8', timeout: 60_000 },
        );
        assert.notEqual(interrupted.status, 0);
        assert.match(interrupted.stderr, /fixture interrupted restore/);
        assert.equal(
          JSON.parse(readFileSync(path.join(spec.capsule, 'state.json'), 'utf8')).phase,
          'restoring',
        );
      }
      assert.equal(command('restore', spec).status, 'restored');
      assert.equal(git(repo, 'rev-parse', 'origin/main'), reference);
      assert.equal(
        git(
          repo,
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          'refs/farmslot/parked/',
          'refs/farmslot/parked-meta/',
        ),
        parkedRefs,
      );
      assert.equal(git(repo, 'cat-file', 'blob', saved.metadataRef), metadata);
      assert.equal(git(repo, 'cat-file', 'blob', prunedMetadataRef), '{"pruned":true}');
      assert.equal(git(repo, 'cat-file', '-t', candidate), 'commit');
      assert.equal(git(repo, 'cat-file', '-t', saved.worktreeTreeSha), 'tree');
      assert.equal(git(repo, 'cat-file', '-t', saved.indexArchiveSha), 'commit');
      assert.ok(git(repo, 'show', `${saved.indexArchiveSha}:index`).length > 0);
      assert.equal(git(repo, 'rev-parse', `${candidate}~2`), ancestor);
      git(repo, 'fsck', '--full', '--no-reflogs');
      assert.deepEqual((await slotParkedInventory(vars, localExec)).receipts, [saved]);
      const capture = await parkGitWork(
        vars,
        {
          slotId: spec.slotId,
          operationKey: 'restore',
          defaultBranch: 'main',
          purpose: 'checkpoint',
          at: new Date().toISOString(),
          onlyThreatened: true,
        },
        localExec,
      );
      const restored = await restoreParkedGitWork(
        vars,
        { slotId: spec.slotId, restoreBranch: 'restored/candidate' },
        { ...capture, receipts: [saved] },
        saved,
        localExec,
      );
      assert.equal(restored.head, candidate);
      assert.equal(git(repo, 'branch', '--show-current'), 'restored/candidate');
      assert.equal(git(repo, 'status', '--porcelain'), dirtyStatus);
      assert.equal(git(repo, 'show', ':value.txt'), 'staged');
      assert.equal(readFileSync(path.join(repo, 'value.txt'), 'utf8'), 'working\n');
      assert.equal(readFileSync(path.join(repo, 'unfinished.txt'), 'utf8'), 'unfinished\n');
      assert.equal(command('restore', spec).status, 'restored');
    });
});

for (const linked of [false, true])
  test(`blind Git removes reference objects and restores candidate work, linked=${linked}`, (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'blind-git-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    mkdirSync(source);
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'config', 'user.name', 'Fixture');
    git(source, 'config', 'user.email', 'fixture@example.invalid');
    git(source, 'config', 'commit.gpgsign', 'false');
    writeFileSync(path.join(source, 'value.txt'), 'base\n');
    writeFileSync(path.join(source, '.gitignore'), 'private-input.txt\n');
    const base = commit(source, 'base');
    writeFileSync(path.join(source, 'value.txt'), 'reference\n');
    writeFileSync(path.join(source, 'answer.txt'), 'later reference-only file\n');
    const reference = commit(source, 'answer');
    git(source, 'remote', 'add', 'origin', path.join(root, 'upstream'));
    git(source, 'update-ref', 'refs/remotes/origin/main', reference);
    const refs = git(source, 'for-each-ref', '--format=%(refname) %(objectname)');
    const repo = linked ? path.join(root, 'linked') : source;
    const sibling = path.join(root, 'sibling');
    mkdirSync(sibling);
    writeFileSync(path.join(sibling, 'answer.txt'), 'reference\n');
    if (linked) git(source, 'worktree', 'add', '-q', '--detach', repo, 'main');
    writeFileSync(path.join(repo, 'private-input.txt'), 'preserved\n');
    const farmPool = path.join(root, 'farm/pool');
    mkdirSync(farmPool, { recursive: true });
    writeFileSync(path.join(farmPool, 'node.json'), 'live pool\n');
    symlinkSync(path.join(farmPool, 'node.json'), path.join(root, 'pool-link.json'));
    const spec: BlindGitSpec = {
      slotId: 'fixture-slot',
      slotEpoch: 1,
      repo,
      capsule: path.join(root, '.farmslot-blind-evals/fixture-slot/trial-1-1'),
      siblingRepos: [sibling],
      farmConfigRoots: [farmPool],
      runId: 'trial-1',
      branch: 'eval/trial-1',
      baseSha: base,
      referenceCommits: [reference],
    };
    assert.equal(command('isolate', spec).status, 'isolated');
    // Project checks run git merge-base origin/main HEAD: the tracking ref is the trial base.
    assert.equal(
      execFileSync('git', ['-C', repo, 'merge-base', 'origin/main', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      base,
    );
    assert.equal(execFileSync('git', ['-C', repo, 'remote'], { encoding: 'utf8' }).trim(), '');
    // A node without sandbox-exec refuses the worker instead of starting it unsandboxed.
    const unsandboxed = spawnSync(
      'python3',
      [
        '-c',
        `
import json, runpy, sys
module = runpy.run_path(sys.argv[1], run_name='blind_git_fixture')
module['boundary'].__globals__['SANDBOX'] = '/nonexistent/sandbox-exec'
module['boundary'](json.loads(sys.argv[2]))
`,
        new URL('./blind-git.py', import.meta.url).pathname,
        JSON.stringify(spec),
      ],
      { env, encoding: 'utf8', timeout: 60_000 },
    );
    assert.notEqual(unsandboxed.status, 0);
    assert.match(
      unsandboxed.stderr,
      /need macOS sandbox-exec on the slot node; refusing an unsandboxed worker/,
    );
    assert.throws(() => command('verify', spec), /worker boundary is missing/);
    assert.equal(command('boundary', spec).status, 'isolated');
    const workerTemp = realpathSync(path.join(spec.capsule, 'boundary/tmp'));
    t.after(() => rmSync(workerTemp, { recursive: true, force: true }));
    assert.equal(git(repo, 'rev-parse', 'HEAD'), base);
    assert.equal(readFileSync(path.join(repo, 'value.txt'), 'utf8'), 'base\n');
    assert.equal(existsSync(path.join(repo, 'answer.txt')), false);
    // Ignored leftovers wait in the capsule until restore.
    assert.equal(existsSync(path.join(repo, 'private-input.txt')), false);
    assert.equal(git(repo, 'remote'), '');
    assert.equal(git(repo, 'config', '--local', '--get', 'commit.gpgsign'), 'false');
    assert.equal(git(repo, 'config', '--local', '--get', 'user.email'), 'fixture@example.invalid');
    assert.notEqual(spawnSync('git', ['-C', repo, 'cat-file', '-e', reference], { env }).status, 0);
    assert.notEqual(spawnSync('git', ['-C', repo, 'fetch', 'origin'], { env }).status, 0);
    git(repo, 'fsck', '--full', '--no-reflogs');
    assert.equal(command('verify', spec).githubAttempt, undefined);
    // A transport the isolated repository refuses is recorded on its own, by any git binary.
    const fetched = spawnSync(
      'bash',
      [
        '-c',
        withBlindTrialBoundary(
          '! /usr/bin/env git fetch https://github.com/owner/reference.git main',
          spec,
        ),
      ],
      { cwd: repo, env, encoding: 'utf8' },
    );
    assert.equal(fetched.status, 0, fetched.stderr);
    assert.match(fetched.stderr, /transport 'https' not allowed/);
    assert.equal(existsSync(path.join(spec.capsule, 'boundary/attempts.log')), false);
    assert.equal(
      command('verify', spec).githubAttempt,
      "git fetch https://github.com/owner/reference.git main: transport 'https' not allowed",
    );
    rmSync(path.join(spec.capsule, 'boundary/git-trace.jsonl'));
    assert.equal(command('verify', spec).githubAttempt, undefined);
    // The worker has no token, gh login or credential helper, and its sandbox
    // cannot read sibling checkouts or retained Git metadata. GitHub calls are recorded.
    const q = (value: string) => `'${value}'`;
    const worker = spawnSync(
      'bash',
      [
        '-c',
        withBlindTrialBoundary(
          [
            'test -z "${GH_TOKEN-}${GITHUB_TOKEN-}"',
            `test "$FARMSLOT_CI_BASE_REF" = '${base}'`,
            `git -C ${q(repo)} diff "$FARMSLOT_CI_BASE_REF" -- value.txt`,
            // Project checks diff against origin/main; it is the verified base, with no remote.
            `test "$(git -C ${q(repo)} merge-base origin/main HEAD)" = '${base}'`,
            `test -z "$(git -C ${q(repo)} remote)"`,
            `test "$(cat ${q(path.join(repo, 'value.txt'))})" = base`,
            `! cat ${q(path.join(sibling, 'answer.txt'))}`,
            `! ls ${q(path.join(root, '.farmslot-blind-evals'))}`,
            `! git --git-dir=${q(path.join(spec.capsule, 'original.entry'))} cat-file -e ${reference}`,
            // A linked worktree's original checkout holds the reference objects too.
            `! git --git-dir=${q(path.join(source, '.git'))} cat-file -e ${reference}`,
            ...(linked ? [`! cat ${q(path.join(source, 'value.txt'))}`] : []),
            '! gh pr list --repo owner/reference',
            '! printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill',
            '! git ls-remote ssh://git@github.com/owner/reference.git',
            // The node's live pool is not writable, directly or through a link.
            `test "$(cat ${q(path.join(farmPool, 'node.json'))})" = 'live pool'`,
            `! sh -c 'printf x > ${path.join(farmPool, 'node.json')}'`,
            `! sh -c 'printf x > ${path.join(root, 'pool-link.json')}'`,
            `! touch ${q(path.join(farmPool, 'new.json'))}`,
          ].join(' && '),
          spec,
        ),
      ],
      {
        cwd: root,
        env: { ...env, GH_TOKEN: 'inherited', GITHUB_TOKEN: 'inherited' },
        encoding: 'utf8',
      },
    );
    assert.equal(worker.status, 0, worker.stderr);
    assert.equal(readFileSync(path.join(farmPool, 'node.json'), 'utf8'), 'live pool\n');
    const attempts = readFileSync(path.join(spec.capsule, 'boundary/attempts.log'), 'utf8');
    assert.match(attempts, /^gh pr list --repo owner\/reference\ncredential get github.com\n/u);
    // Git may first probe the SSH variant; the transport attempt itself is recorded either way.
    assert.match(attempts, /^ssh .*git@github\.com git-upload-pack '\/owner\/reference\.git'$/mu);
    assert.equal(command('verify', spec).githubAttempt, 'gh pr list --repo owner/reference');
    assert.equal(
      command('isolate', spec).status,
      'isolated',
      'prepare replay preserves the isolated store',
    );
    writeFileSync(path.join(repo, 'value.txt'), 'candidate\n');
    const head = commit(repo, 'candidate');
    assert.equal(command('verify', spec).status, 'isolated');
    // Simulate a process exit between retaining isolated metadata and restoring
    // the original entry. The durable restoration journal must recover it.
    const interrupted = spawnSync(
      'python3',
      [
        '-c',
        `
import json, runpy, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1], run_name='blind_git_fixture')
rename = Path.rename
def interrupt(source, target):
    if source.name == 'original.entry':
        raise RuntimeError('fixture interrupted restore')
    return rename(source, target)
Path.rename = interrupt
module['restore'](json.loads(sys.argv[2]))
`,
        new URL('./blind-git.py', import.meta.url).pathname,
        JSON.stringify(spec),
      ],
      { env, encoding: 'utf8', timeout: 60_000 },
    );
    assert.notEqual(interrupted.status, 0);
    assert.match(interrupted.stderr, /fixture interrupted restore/);
    assert.equal(existsSync(path.join(repo, '.git')), false);
    assert.equal(command('restore', spec).headSha, head);
    assert.equal(existsSync(workerTemp), false, 'restoration removes only the allocated temp');
    assert.equal(readFileSync(path.join(repo, 'private-input.txt'), 'utf8'), 'preserved\n');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    assert.equal(git(repo, 'status', '--porcelain'), '');
    assert.equal(git(repo, 'remote', 'get-url', 'origin'), path.join(root, 'upstream'));
    assert.equal(
      git(source, 'for-each-ref', '--format=%(refname) %(objectname)')
        .split('\n')
        .filter((line) => !line.startsWith('refs/heads/eval/'))
        .join('\n'),
      refs,
    );
    assert.equal(command('restore', spec).status, 'restored');
  });

// Outside the default suite: this checks the real macOS worker sandbox.
test('proof Git admits both source snapshots and keeps product and pinned inputs read-only', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'proof-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, '.gitignore'), 'tasks/\n.runtime/\n');
  writeFileSync(path.join(repo, 'value.txt'), 'before\n');
  const baseSha = commit(repo, 'before');
  writeFileSync(path.join(repo, 'value.txt'), 'supplied\n');
  const headSha = commit(repo, 'implementation');
  const treeSha = git(repo, 'rev-parse', 'HEAD^{tree}');
  writeFileSync(path.join(repo, 'golden.json'), 'hidden proof');
  const golden = commit(repo, 'golden');
  git(repo, 'checkout', '-q', headSha);
  const task = path.join(repo, 'tasks/current');
  mkdirSync(path.join(task, 'inputs'), { recursive: true });
  mkdirSync(path.join(task, 'artifacts'));
  writeFileSync(path.join(task, 'inputs/qa.json'), '{}');
  const runtime = path.join(repo, '.runtime');
  mkdirSync(runtime);
  const spec: BlindGitSpec = {
    slotId: 'proof-slot',
    slotEpoch: 1,
    repo,
    capsule: path.join(root, '.farmslot-blind-evals/trial'),
    runId: 'trial',
    branch: 'eval/proof',
    baseSha: headSha,
    referenceCommits: [golden],
    proof: { baseSha, headSha, treeSha, diffSha256: 'a'.repeat(64) },
    keepIgnored: ['tasks/current', '.runtime'],
  };
  assert.equal(command('isolate', spec).status, 'isolated');
  assert.equal(git(repo, 'cat-file', '-t', baseSha), 'commit');
  assert.match(git(repo, 'diff', baseSha, headSha), /supplied/);
  assert.notEqual(spawnSync('git', ['-C', repo, 'cat-file', '-e', golden], { env }).status, 0);
  const priorTask = path.join(repo, 'tasks/prior');
  mkdirSync(priorTask);
  writeFileSync(path.join(priorTask, 'answer.json'), 'golden');
  const gatewayTask = path.join(root, 'gateway-tasks');
  mkdirSync(gatewayTask);
  writeFileSync(path.join(gatewayTask, 'answer.json'), 'golden');
  spec.proofBoundary = {
    taskRoot: path.join(repo, 'tasks'),
    currentTask: task,
    runtimeRoots: [runtime],
    deniedRoots: [gatewayTask],
  };
  assert.equal(command('boundary', spec).status, 'isolated');
  const worker = spawnSync(
    'bash',
    [
      '-c',
      withBlindTrialBoundary(
        [
          `! sh -c 'echo changed > "${repo}/value.txt"'`,
          `! sh -c 'echo changed > "${repo}/.git/HEAD"'`,
          `! sh -c 'echo changed > "${task}/inputs/qa.json"'`,
          `! cat '${priorTask}/answer.json'`,
          `! cat '${gatewayTask}/answer.json'`,
          `cat '${task}/inputs/qa.json'`,
          `git -C '${repo}' diff ${baseSha} ${headSha} >/dev/null`,
          `echo captured > '${task}/artifacts/output.txt'`,
          `echo cache > '${runtime}/cache'`,
        ].join(' && '),
        spec,
      ),
    ],
    { env, encoding: 'utf8' },
  );
  assert.equal(worker.status, 0, worker.stderr);
  assert.equal(command('verify', spec).status, 'isolated');
  writeFileSync(path.join(repo, 'value.txt'), 'tampered\n');
  assert.throws(() => command('verify', spec), /implementation changed/);
  writeFileSync(path.join(repo, 'value.txt'), 'supplied\n');
  writeFileSync(path.join(task, 'inputs/qa.json'), '{"tampered":true}');
  assert.throws(() => command('verify', spec), /input.*changed/);
});

function ignoredFixture(root: string) {
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(
    path.join(repo, '.gitignore'),
    'temp/\n.env.local\ncoverage/\nnode_modules/\n.agent/\n',
  );
  mkdirSync(path.join(repo, 'packages/a'), { recursive: true });
  writeFileSync(path.join(repo, 'packages/a/index.js'), 'base\n');
  const baseSha = commit(repo, 'base');
  const files: Record<string, string> = {
    'temp/recipe/runtime/eval-cancel-proof/answer.txt': 'FAKE_EARLIER_ANSWER\n',
    'temp/recipe/runtime/operations/0000.json': '{"logPath":"temp/tasks/T-1/old/artifacts"}\n',
    'temp/recipe/runtime/status.json':
      '{"operations":[{"command":"run","logPath":"temp/tasks/T-1/old/artifacts/operations/0000.log"}]}\n',
    'temp/recipe/runtime/prepare.json': '{"run":"earlier"}\n',
    'temp/tasks/T-1/old/artifacts/notes.md': 'earlier run notes\n',
    '.env.local': 'FAKE_MARKER=earlier\n',
    'coverage/lcov.info': 'earlier coverage\n',
    '.agent/old.log': 'earlier log\n',
    '.agent/.observability/node-support-hash': 'this-run-hash\n',
    'temp/tasks/T-2/current/TASK.md': 'this run task\n',
    'node_modules/pkg/index.js': 'cache\n',
    'packages/a/node_modules/b.js': 'nested cache\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    writeFileSync(path.join(repo, name), text);
  }
  const spec: BlindGitSpec = {
    slotId: 'ignored-fixture',
    slotEpoch: 1,
    repo,
    capsule: path.join(root, '.farmslot-blind-evals/ignored-fixture/trial-1'),
    runId: 'trial',
    branch: 'eval/trial',
    baseSha,
    referenceCommits: [],
    keepIgnored: [
      'node_modules',
      '.agent/.observability/node-support-hash',
      'temp/tasks/T-2/current',
    ],
  };
  return { repo, spec, files };
}

const movedLeftovers = [
  'temp/recipe/runtime/eval-cancel-proof/answer.txt',
  'temp/recipe/runtime/operations/0000.json',
  'temp/recipe/runtime/status.json',
  'temp/recipe/runtime/prepare.json',
  'temp/tasks/T-1/old/artifacts/notes.md',
  '.env.local',
  'coverage/lcov.info',
  '.agent/old.log',
];

test('blind isolation moves earlier ignored leftovers aside and restores them byte-identical', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'blind-ignored-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo, spec, files } = ignoredFixture(root);
  assert.equal(command('isolate', spec).status, 'isolated');
  for (const name of movedLeftovers)
    assert.equal(existsSync(path.join(repo, name)), false, `${name} stays outside the boundary`);
  for (const name of Object.keys(files).filter((name) => !movedLeftovers.includes(name)))
    assert.equal(readFileSync(path.join(repo, name), 'utf8'), files[name], `${name} stays`);
  // Prepare writes this run's runtime files after isolation (fixtures phase onward).
  mkdirSync(path.join(repo, 'temp/recipe/runtime/operations'), { recursive: true });
  writeFileSync(path.join(repo, 'temp/recipe/runtime/prepare.json'), '{"run":"trial"}\n');
  assert.equal(
    readFileSync(path.join(repo, 'temp/recipe/runtime/prepare.json'), 'utf8'),
    '{"run":"trial"}\n',
  );
  // The worker writes its own runtime state, including a path an earlier run also used.
  writeFileSync(path.join(repo, 'temp/tasks/T-2/current/out.txt'), 'trial output\n');
  writeFileSync(path.join(repo, 'temp/recipe/runtime/operations/0000.json'), '{"trial":true}\n');
  assert.equal(command('restore', spec).status, 'restored');
  for (const [name, text] of Object.entries(files))
    assert.equal(readFileSync(path.join(repo, name), 'utf8'), text, `${name} restored`);
  assert.equal(
    readFileSync(path.join(repo, 'temp/tasks/T-2/current/out.txt'), 'utf8'),
    'trial output\n',
  );
  assert.equal(
    readFileSync(
      path.join(spec.capsule, 'trial-ignored/temp/recipe/runtime/operations/0000.json'),
      'utf8',
    ),
    '{"trial":true}\n',
    'a colliding trial file is set aside, never deleted',
  );
  assert.equal(
    readFileSync(path.join(spec.capsule, 'trial-ignored/temp/recipe/runtime/prepare.json'), 'utf8'),
    '{"run":"trial"}\n',
  );
  assert.equal(command('restore', spec).status, 'restored');
});

test('restore after an isolate killed mid-move returns every moved ignored path', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'blind-ignored-kill-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo, spec, files } = ignoredFixture(root);
  // The journal records the full move list before the first rename; the kill
  // lands after three of the six moves.
  mkdirSync(spec.capsule, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(spec.capsule, 'state.json'),
    JSON.stringify({
      ...spec,
      phase: 'preparing',
      originalDirectory: path.join(repo, '.git'),
      originalHead: spec.baseSha,
      originalIsDirectory: true,
      ignoredMoved: ['.agent/old.log', '.env.local', 'coverage', 'temp/recipe', 'temp/tasks/T-1'],
    }),
  );
  for (const name of ['.agent/old.log', '.env.local', 'coverage']) {
    const target = path.join(spec.capsule, 'original-ignored', name);
    mkdirSync(path.dirname(target), { recursive: true });
    execFileSync('mv', [path.join(repo, name), target]);
  }
  assert.equal(command('restore', spec).status, 'restored');
  for (const [name, text] of Object.entries(files))
    assert.equal(readFileSync(path.join(repo, name), 'utf8'), text, `${name} restored`);
});

test('blind isolate batches a partial clone fetch and heals a capsule a killed isolate left behind', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'blind-partial-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // A blobless clone checked out past the base: none of the base's blobs are local.
  const source = path.join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-q', '-b', 'main');
  for (let index = 0; index < 400; index++)
    writeFileSync(path.join(source, `file-${index}.txt`), `base ${index}\n`);
  const baseSha = commit(source, 'base');
  for (let index = 0; index < 400; index++)
    writeFileSync(path.join(source, `file-${index}.txt`), `later ${index}\n`);
  commit(source, 'later');
  git(source, 'config', 'uploadpack.allowFilter', 'true');
  const repo = path.join(root, 'slot');
  execFileSync('git', ['clone', '-q', '--filter=blob:none', `file://${source}`, repo], { env });
  const missing = () =>
    git(repo, 'rev-list', '--objects', '--no-object-names', '--no-walk', '--missing=print', baseSha)
      .split('\n')
      .filter((line) => line.startsWith('?')).length;
  assert.equal(missing(), 400);
  const capsule = path.join(root, '.farmslot-blind-evals/partial-fixture/trial-1');
  const spec: BlindGitSpec = {
    slotId: 'partial-fixture',
    slotEpoch: 1,
    repo,
    capsule,
    runId: 'trial',
    branch: 'eval/trial',
    baseSha,
    referenceCommits: [],
  };
  // An isolate killed mid-swap (as a caller's timeout does) leaves its capsule preparing.
  const killed = spawnSync(
    'python3',
    [
      '-c',
      `import json, os, runpy, sys
blind = runpy.run_path(sys.argv[1], run_name='fixture')
blind['isolate'].__globals__['pack_into'] = lambda *args, **kwargs: os._exit(9)
blind['isolate'](json.loads(sys.argv[2]))`,
      new URL('./blind-git.py', import.meta.url).pathname,
      JSON.stringify(spec),
    ],
    { env, encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(killed.status, 9, killed.stderr);
  assert.equal(
    JSON.parse(readFileSync(path.join(capsule, 'state.json'), 'utf8')).phase,
    'preparing',
  );
  // The batch fetch already ran: one request, not one per blob.
  assert.equal(missing(), 0);
  const started = Date.now();
  assert.equal(command('isolate', spec).status, 'isolated');
  t.diagnostic(`retried isolate in ${Date.now() - started}ms`);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), baseSha);
  const parent = path.dirname(capsule);
  assert.equal(
    readdirSync(parent).filter((name) => name.startsWith('trial-1.interrupted-')).length,
    1,
    'the interrupted capsule is kept aside',
  );
  assert.equal(command('restore', spec).status, 'restored');
  // A second isolation of the same capsule waits for none: the lock refuses it.
  const holder = spawn('python3', [
    '-c',
    `import fcntl, sys, time
lock = open(sys.argv[1], 'a'); fcntl.flock(lock, fcntl.LOCK_EX); print('held', flush=True); time.sleep(30)`,
    path.join(parent, 'trial-2.lock'),
  ]);
  t.after(() => holder.kill('SIGKILL'));
  await once(holder.stdout!, 'data');
  assert.throws(
    () => command('isolate', { ...spec, capsule: path.join(parent, 'trial-2'), runId: 'trial-2' }),
    /isolation is already running for this capsule/,
  );
  // Objects that cannot be fetched fail at once, before any capsule exists.
  const offline = path.join(root, 'offline-slot');
  execFileSync('git', ['clone', '-q', '--filter=blob:none', `file://${source}`, offline], { env });
  renameSync(source, `${source}-gone`);
  const offlineSpec = {
    ...spec,
    repo: offline,
    capsule: path.join(parent, 'trial-3'),
    runId: 'trial-3',
  };
  assert.throws(
    () => command('isolate', offlineSpec),
    /missing from this partial clone and could not be fetched/,
  );
  assert.equal(existsSync(offlineSpec.capsule), false);
});

test('a restored blind trial isolates again from its base, but never over candidate commits', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'blind-reisolate-')));
  try {
    const repo = path.join(root, 'slot');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'value.txt'), 'base\n');
    const baseSha = commit(repo, 'base');
    const parent = path.join(root, '.farmslot-blind-evals/reisolate-fixture');
    const spec: BlindGitSpec = {
      slotId: 'reisolate-fixture',
      slotEpoch: 1,
      repo,
      capsule: path.join(parent, 'trial-1'),
      runId: 'trial',
      branch: 'eval/trial',
      baseSha,
      referenceCommits: [],
    };
    // Unchanged trial: restore keeps its branch at the base; a retry isolates afresh.
    assert.equal(command('isolate', spec).status, 'isolated');
    assert.equal(command('restore', spec).status, 'restored');
    // An interrupted attempt can leave a written object store and loose files beside its records.
    const pack = path.join(spec.capsule, 'interrupted.git/objects/pack');
    mkdirSync(pack, { recursive: true });
    writeFileSync(path.join(pack, 'pack-fixture.pack'), 'PACK fixture\n');
    writeFileSync(path.join(spec.capsule, 'candidate.objects'), 'fixture\n');
    writeFileSync(path.join(spec.capsule, 'receipt.json'), '{"kept":true}\n');
    assert.equal(command('isolate', spec).status, 'isolated');
    const [aside] = readdirSync(parent).filter((name) => name.startsWith('trial-1.interrupted-'));
    assert.ok(aside, 'the restored capsule is kept aside');
    // Its stores are gone; only the journal and receipts remain.
    assert.deepEqual(readdirSync(path.join(parent, aside)).sort(), ['receipt.json', 'state.json']);
    assert.equal(readFileSync(path.join(parent, aside, 'receipt.json'), 'utf8'), '{"kept":true}\n');
    // Candidate work: the retry refuses and the candidate branch survives.
    writeFileSync(path.join(repo, 'value.txt'), 'candidate\n');
    const candidate = commit(repo, 'candidate');
    assert.equal(command('restore', spec).status, 'restored');
    assert.throws(
      () => command('isolate', spec),
      /holds candidate commits from an earlier attempt/,
    );
    assert.equal(git(repo, 'rev-parse', 'refs/heads/eval/trial'), candidate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('healing a restored capsule keeps its ignored files and isolates the leftovers again', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'blind-ignored-heal-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo, spec, files } = ignoredFixture(root);
  assert.equal(command('isolate', spec).status, 'isolated');
  mkdirSync(path.join(repo, 'temp/recipe/runtime'), { recursive: true });
  writeFileSync(path.join(repo, 'temp/recipe/runtime/status.json'), '{"trial":1}\n');
  assert.equal(command('restore', spec).status, 'restored');
  // A file whose original never came back stays where only the capsule holds it.
  const stranded = path.join(spec.capsule, 'original-ignored/stranded.txt');
  writeFileSync(stranded, 'stranded original\n');
  assert.equal(command('isolate', spec).status, 'isolated');
  const parent = path.dirname(spec.capsule);
  const [aside] = readdirSync(parent).filter((name) => name.startsWith('trial-1.interrupted-'));
  assert.ok(aside, 'the restored capsule is kept aside');
  assert.deepEqual(readdirSync(path.join(parent, aside)).sort(), [
    'original-ignored',
    'state.json',
    'trial-ignored',
  ]);
  assert.equal(
    readFileSync(path.join(parent, aside, 'trial-ignored/temp/recipe/runtime/status.json'), 'utf8'),
    '{"trial":1}\n',
  );
  assert.equal(
    readFileSync(path.join(parent, aside, 'original-ignored/stranded.txt'), 'utf8'),
    'stranded original\n',
  );
  // The fresh isolation moved the earlier leftovers aside again.
  for (const name of movedLeftovers)
    assert.equal(existsSync(path.join(repo, name)), false, `${name} stays outside the boundary`);
  assert.equal(command('restore', spec).status, 'restored');
  for (const [name, text] of Object.entries(files))
    assert.equal(readFileSync(path.join(repo, name), 'utf8'), text, `${name} restored`);
});

test('a failure before the Git swap returns every moved ignored path', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'blind-ignored-rollback-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo, spec, files } = ignoredFixture(root);
  // Fail after the moves, while the prepared Git is still being built.
  const failed = spawnSync(
    'python3',
    [
      '-c',
      `
import json, runpy, sys
module = runpy.run_path(sys.argv[1], run_name='blind_git_fixture')
def fail(*args, **kwargs):
    raise RuntimeError('fixture pack failure')
module['isolate'].__globals__['pack_into'] = fail
module['isolate'](json.loads(sys.argv[2]))
`,
      new URL('./blind-git.py', import.meta.url).pathname,
      JSON.stringify(spec),
    ],
    { env, encoding: 'utf8', timeout: 60_000 },
  );
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /fixture pack failure/);
  for (const [name, text] of Object.entries(files))
    assert.equal(readFileSync(path.join(repo, name), 'utf8'), text, `${name} restored`);
  assert.equal(
    JSON.parse(readFileSync(path.join(spec.capsule, 'state.json'), 'utf8')).phase,
    'restored',
  );
});

test('isolation moves ignored leftovers inside submodules and keeps nested caches', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'blind-ignored-nested-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, 'module-upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(upstream, '.gitignore'), 'proof/\n');
  writeFileSync(path.join(upstream, 'value.txt'), 'module\n');
  commit(upstream, 'module');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, '.gitignore'), 'temp/\npackages/a/.yarn/\n');
  mkdirSync(path.join(repo, 'packages/a'), { recursive: true });
  writeFileSync(path.join(repo, 'packages/a/index.js'), 'base\n');
  git(
    repo,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    `file://${upstream}`,
    'sdk',
  );
  const baseSha = commit(repo, 'base');
  const files: Record<string, string> = {
    'sdk/proof/answer.json': 'FAKE_EARLIER_ANSWER\n',
    'temp/generated-app/answer.txt': 'FAKE_EARLIER_ANSWER\n',
    'temp/generated-app/node_modules/pkg/index.js': 'cache\n',
    'packages/a/.yarn/cache/pkg.zip': 'cache\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    writeFileSync(path.join(repo, name), text);
  }
  const spec: BlindGitSpec = {
    slotId: 'ignored-nested-fixture',
    slotEpoch: 1,
    repo,
    capsule: path.join(root, '.farmslot-blind-evals/ignored-nested-fixture/trial-1'),
    runId: 'trial',
    branch: 'eval/trial',
    baseSha,
    referenceCommits: [],
    keepIgnored: ['node_modules', '.yarn/*'],
  };
  assert.equal(command('isolate', spec).status, 'isolated');
  assert.equal(existsSync(path.join(repo, 'sdk/proof/answer.json')), false, 'submodule leftover');
  assert.equal(existsSync(path.join(repo, 'temp/generated-app/answer.txt')), false);
  assert.equal(
    readFileSync(path.join(repo, 'temp/generated-app/node_modules/pkg/index.js'), 'utf8'),
    'cache\n',
    'a cache under a collapsed ignored parent stays',
  );
  assert.equal(
    readFileSync(path.join(repo, 'packages/a/.yarn/cache/pkg.zip'), 'utf8'),
    'cache\n',
    'a nested .yarn cache stays',
  );
  assert.equal(command('restore', spec).status, 'restored');
  for (const [name, text] of Object.entries(files))
    assert.equal(readFileSync(path.join(repo, name), 'utf8'), text, `${name} restored`);
});

test('a restore interrupted before the ignored files return finishes on retry without a marker', (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'blind-ignored-restore-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo, spec, files } = ignoredFixture(root);
  assert.equal(command('isolate', spec).status, 'isolated');
  const interrupted = spawnSync(
    'python3',
    [
      '-c',
      `
import json, runpy, sys
module = runpy.run_path(sys.argv[1], run_name='blind_git_fixture')
def stop(*args, **kwargs):
    raise RuntimeError('fixture interrupted restore')
module['restore'].__globals__['restore_ignored'] = stop
module['restore'](json.loads(sys.argv[2]))
`,
      new URL('./blind-git.py', import.meta.url).pathname,
      JSON.stringify(spec),
    ],
    { env, encoding: 'utf8', timeout: 60_000 },
  );
  assert.notEqual(interrupted.status, 0);
  assert.match(interrupted.stderr, /fixture interrupted restore/);
  // The original Git is back, so the slot shows no blind marker, but the journal is unfinished.
  assert.notEqual(
    spawnSync('git', ['-C', repo, 'config', '--get', 'farmslot.blindRun'], { env }).status,
    0,
  );
  assert.notEqual(
    JSON.parse(readFileSync(path.join(spec.capsule, 'state.json'), 'utf8')).phase,
    'restored',
  );
  assert.equal(existsSync(path.join(repo, '.env.local')), false);
  assert.equal(command('restore', spec).status, 'restored');
  for (const [name, text] of Object.entries(files))
    assert.equal(readFileSync(path.join(repo, name), 'utf8'), text, `${name} restored`);
});

test('isolation keeps farm tooling and generated sources, and handles self-ignoring folders', async (t) => {
  const { DEFAULT_BLIND_KEEP_IGNORED } = await import('./blind-trial.js');
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'blind-ignored-tooling-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(
    path.join(repo, '.gitignore'),
    '.agents/\ntemp/\ndevelopment/build/*.js\nshared/lib/manifestFlags.*\n',
  );
  mkdirSync(path.join(repo, 'development/build'), { recursive: true });
  writeFileSync(path.join(repo, 'development/build/index.ts'), 'source\n');
  mkdirSync(path.join(repo, 'shared/lib'), { recursive: true });
  writeFileSync(path.join(repo, 'shared/lib/index.ts'), 'source\n');
  const baseSha = commit(repo, 'base');
  const kept: Record<string, string> = {
    '.agents/skills/proof/SKILL.md': 'skill\n',
    'temp/farmslot/deps-setup.stamp': 'stamp\n',
    'development/build/constants.js': 'generated\n',
    'shared/lib/manifestFlags.js': 'generated\n',
  };
  const moved: Record<string, string> = {
    'temp/recipe/runtime/status.json': '{"operations":["earlier"]}\n',
    '.agents/earlier-notes.md': 'FAKE_EARLIER_ANSWER\n',
    // A folder that ignores itself: Git lists it and every entry in it.
    'hooks/_/.gitignore': '*\n',
    'hooks/_/pre-commit': 'hook\n',
  };
  for (const [name, text] of Object.entries({ ...kept, ...moved })) {
    mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    writeFileSync(path.join(repo, name), text);
  }
  const spec: BlindGitSpec = {
    slotId: 'ignored-tooling-fixture',
    slotEpoch: 1,
    repo,
    capsule: path.join(root, '.farmslot-blind-evals/ignored-tooling-fixture/trial-1'),
    runId: 'trial',
    branch: 'eval/trial',
    baseSha,
    referenceCommits: [],
    keepIgnored: DEFAULT_BLIND_KEEP_IGNORED,
  };
  assert.equal(command('isolate', spec).status, 'isolated');
  for (const [name, text] of Object.entries(kept))
    assert.equal(readFileSync(path.join(repo, name), 'utf8'), text, `${name} stays`);
  for (const name of Object.keys(moved))
    assert.equal(existsSync(path.join(repo, name)), false, `${name} moves`);
  assert.equal(command('restore', spec).status, 'restored');
  for (const [name, text] of Object.entries({ ...kept, ...moved }))
    assert.equal(readFileSync(path.join(repo, name), 'utf8'), text, `${name} restored`);
});
