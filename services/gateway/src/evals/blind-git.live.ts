import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
function command(action: 'isolate' | 'boundary' | 'verify' | 'restore', spec: BlindGitSpec) {
  return JSON.parse(
    execFileSync('bash', ['-c', buildBlindGitCommand(action, spec)], {
      env,
      encoding: 'utf8',
      timeout: 60_000,
    }),
  );
}

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
      assert.equal(command('isolate', spec).status, 'isolated');
      assert.equal(git(repo, 'remote'), '');
      assert.equal(git(repo, 'for-each-ref', '--format=%(refname)'), `refs/heads/${spec.branch}`);
      const reset = () =>
        mutateSlotGit(
          vars,
          {},
          { defaultBranch: 'main', blindBaseSha: baseSha, targetTrees: [baseSha] },
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
      const [saved] = (await slotParkedInventory(vars, localExec)).receipts;
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
    assert.equal(readFileSync(path.join(repo, 'private-input.txt'), 'utf8'), 'preserved\n');
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
