import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import type { ReviewWorkspaceAdmission } from './admission.js';

const runs = new Map<string, Run>();
const persisted: Run[] = [];
// The gateway lifecycle recipe covers real tmux cleanup; these tests isolate Git ownership.
mock.module('../runtime/workspace-terminal.js', {
  namedExports: { workspaceTerminalOperation: async () => [] },
});
let nativeStateRoot = '';
mock.module('../runs/store.js', {
  namedExports: {
    getRun: (id: string) => runs.get(id),
    updateRun: (id: string, patch: Partial<Run>) => Object.assign(runs.get(id)!, patch),
    persistRunNow: async (run: Run) => {
      persisted.push(structuredClone(run));
    },
  },
});
mock.module('../runners/native/node.js', {
  namedExports: {
    execNativeNodeArgv: () => {
      throw new Error('Unexpected remote workspace execution');
    },
    routeNativeExecution: async (owner: string, _method: string, params: { sessionId: string }) => {
      const stateDirectory = path.join(
        nativeStateRoot,
        'workers',
        createHash('sha256').update(owner).digest('hex'),
        params.sessionId,
      );
      mkdirSync(stateDirectory, { recursive: true });
      return { stateDirectory };
    },
  },
});
mock.module('../fleet/node-rpc.js', {
  namedExports: {
    nodeExec: () => {
      throw new Error('Unexpected remote shell execution');
    },
    nodeExecArgv: () => {
      throw new Error('Unexpected remote argv execution');
    },
  },
});
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'owner';
const { REVIEW_WORKSPACE_SCRIPT, allocateReviewWorkspace, cleanupReviewWorkspace } =
  await import('./workspace.js');

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'review-workspace-git-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'upstream');
  const root = path.join(directory, 'managed');
  mkdirSync(source);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: source,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init');
  writeFileSync(path.join(source, 'source.txt'), 'base\n');
  writeFileSync(path.join(source, '.gitignore'), 'ignored.tmp\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  writeFileSync(path.join(source, 'source.txt'), 'head\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'head');
  const headSha = git('rev-parse', 'HEAD');
  const identity = {
    runId: 'review-run',
    workspaceId: randomUUID(),
    owner: 'owner',
    project: 'farm',
    machine: 'machine',
    executionNodeId: 'local',
    repositoryUrl: source,
    headSha,
    baseSha,
  };
  const workspace = path.join(root, 'runs', identity.workspaceId);
  const cacheKey = createHash('sha256')
    .update(
      JSON.stringify({
        owner: identity.owner,
        project: identity.project,
        repositoryUrl: identity.repositoryUrl,
      }),
    )
    .digest('hex');
  const cache = path.join(root, 'repositories', cacheKey);
  const execute = (
    action = 'allocate',
    changes: Record<string, unknown> = {},
    allowCancelled = false,
  ) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          REVIEW_WORKSPACE_SCRIPT,
          JSON.stringify({ root, identity: { ...identity, ...changes }, action, allowCancelled }),
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  return { directory, source, root, git, identity, workspace, cache, cacheKey, execute };
}

test('cancellation before allocation is durable, idempotent and cleanable without a cache', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.execute('cancel'), { state: 'cancelled' });
  assert.deepEqual(f.execute('cancel'), { state: 'cancelled' });
  assert.throws(() => f.execute(), /Workspace operation was cancelled/);
  assert(!existsSync(f.cache));
  assert(!existsSync(path.join(f.workspace, 'source')));
  assert.throws(() => f.execute('cleanup'), /Workspace operation was cancelled/);
  assert.deepEqual(f.execute('cleanup', {}, true), { state: 'cleaned' });
  assert.deepEqual(f.execute('cleanup', {}, true), { state: 'cleaned' });
  assert.throws(() => f.execute(), /Workspace operation was cancelled/);
});

test('cancellation refuses another identity for the same workspace', (t) => {
  const f = fixture(t);
  f.execute();
  assert.throws(() => f.execute('cancel', { runId: 'another-run' }), /identity conflict/);
  assert.deepEqual(f.execute(), { state: 'ready' });
  assert(!existsSync(path.join(f.workspace, 'cancel.json')));
});

test('review allocation pins real commits, retries without fetching, and retains reports on cleanup', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.execute(), { state: 'ready' });
  const checkout = path.join(f.workspace, 'source');
  assert.equal(readFileSync(path.join(checkout, 'source.txt'), 'utf8'), 'head\n');
  assert.equal(
    execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    f.identity.headSha,
  );
  assert.throws(
    () =>
      execFileSync('git', ['-C', checkout, 'symbolic-ref', '-q', '--short', 'HEAD'], {
        encoding: 'utf8',
        stdio: 'ignore',
      }),
    (error: unknown) => (error as { status: number }).status === 1,
  );
});

test('ready retry survives unavailable upstream and cleanup retains exact source identity and cache refs', (t) => {
  const f = fixture(t);
  f.execute();
  const report = path.join(f.workspace, 'task', 'artifacts', 'review.md');
  writeFileSync(report, 'review findings');
  const sourceSnapshot = readFileSync(path.join(f.workspace, 'identity.json'), 'utf8');
  rmSync(f.source, { recursive: true });
  assert.deepEqual(f.execute(), { state: 'ready' });
  assert.deepEqual(f.execute('cleanup'), { state: 'cleaned' });
  assert.deepEqual(f.execute('cleanup'), { state: 'cleaned' });
  assert.equal(existsSync(path.join(f.workspace, 'source')), false);
  assert.equal(readFileSync(report, 'utf8'), 'review findings');
  assert.equal(readFileSync(path.join(f.workspace, 'identity.json'), 'utf8'), sourceSnapshot);
  for (const [kind, sha] of [
    ['head', f.identity.headSha],
    ['base', f.identity.baseSha],
  ]) {
    assert.equal(
      execFileSync(
        'git',
        ['--git-dir', f.cache, 'rev-parse', `refs/reviews/${f.identity.workspaceId}/${kind}`],
        { encoding: 'utf8' },
      ).trim(),
      sha,
    );
  }
  assert.throws(() => f.execute(), /Workspace was cleaned/);
});

test('changed source identity and dirty checkout fail closed without discarding operator data', (t) => {
  const f = fixture(t);
  f.execute();
  assert.throws(() => f.execute('allocate', { headSha: f.identity.baseSha }), /identity conflict/);
  const unexpected = path.join(f.workspace, 'source', 'unexpected.txt');
  writeFileSync(unexpected, 'retain me');
  assert.throws(() => f.execute('cleanup'), /refusing to discard/);
  assert.equal(readFileSync(unexpected, 'utf8'), 'retain me');
  rmSync(unexpected);
  writeFileSync(path.join(f.workspace, 'source', 'ignored.tmp'), 'ignored but valuable');
  assert.throws(() => f.execute('cleanup'), /refusing to discard/);
});

test('node allocation rejects substituted checkout and output directories', (t) => {
  const f = fixture(t);
  f.execute();
  const task = path.join(f.workspace, 'task');
  rmSync(task, { recursive: true });
  symlinkSync(f.source, task);
  assert.throws(() => f.execute(), /directory is not owned/);
  assert.equal(readFileSync(path.join(f.source, 'source.txt'), 'utf8'), 'head\n');
  rmSync(path.join(f.workspace, 'identity.json'));
  assert.throws(() => f.execute(), /no ownership marker/);
});

test('allocator persists binding before Git, rechecks generation, and requires process closure for cleanup', async (t) => {
  const f = fixture(t);
  nativeStateRoot = path.join(f.directory, 'native-sessions');
  const run = {
    id: f.identity.runId,
    flowType: 'review-pr',
    transport: 'native',
    slotId: null,
    nativeOwnerPrincipalId: 'owner',
    project: 'farm',
    reviewWorkspaceTarget: { machine: 'machine' },
    engineState: { generation: 1 },
    reviewWorkspaceSubject: {
      repositoryUrl: f.source,
      headSha: f.identity.headSha,
      baseSha: f.identity.baseSha,
    },
  } as Run;
  runs.set(run.id, run);
  const admission = {
    project: { name: 'farm', repoUrl: f.source },
    pool: { machine: 'machine', host: 'localhost' },
    executionNodeId: 'local',
  } as ReviewWorkspaceAdmission;
  const options = { ...run.reviewWorkspaceSubject!, assertCurrent: () => undefined };
  const originalPersistCount = persisted.length;
  let checkpoint = 0;
  await assert.rejects(
    allocateReviewWorkspace(run.id, admission, {
      ...options,
      assertCurrent: () => {
        checkpoint += 1;
        if (checkpoint === 3) run.engineState!.generation = 2;
      },
    }),
    /generation changed/,
  );
  assert.equal(persisted.length, originalPersistCount + 1);
  assert.equal(existsSync(run.reviewWorkspace!.checkoutPath), false);
  const binding = await allocateReviewWorkspace(run.id, admission, options);
  assert.deepEqual(binding, persisted.at(-1)!.reviewWorkspace);
  assert.equal(readFileSync(path.join(binding.checkoutPath, 'source.txt'), 'utf8'), 'head\n');
  assert.equal(binding.artifactPath, path.join(binding.taskPath, 'artifacts'));
  assert.equal(binding.checkoutPath.startsWith(binding.taskPath), false);
  run.reviewWorkspace!.support = {
    path: path.join(path.dirname(binding.taskPath), 'frozen-support'),
    sha256: 'a'.repeat(64),
    sources: [],
    skills: [],
    environment: {},
  };
  assert.deepEqual(
    (await allocateReviewWorkspace(run.id, admission, options)).support,
    run.reviewWorkspace!.support,
  );
  run.agentContexts = [{ nativeSession: { ownerPrincipalId: 'owner' } }] as Run['agentContexts'];
  await assert.rejects(
    cleanupReviewWorkspace(run.id, { assertCurrent: () => undefined }),
    /process closure/,
  );
  assert.equal(existsSync(binding.checkoutPath), true);
  run.agentContexts![0].nativeSession!.closedAt = new Date().toISOString();
  await cleanupReviewWorkspace(run.id, { assertCurrent: () => undefined });
  assert.equal(existsSync(binding.checkoutPath), false);
});

async function waitUntil(predicate: () => boolean, timeout = 30000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Process fixture did not reach its checkpoint');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function killAllocator(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
}

for (const phase of ['init-cache', 'fetch', 'add-worktree', 'remove-worktree']) {
  test(`a killed allocator recovers ${phase} and stops the exact surviving Git group`, async (t) => {
    const f = fixture(t);
    if (phase === 'remove-worktree') f.execute();
    let sibling: { workspaceId: string; runId: string } | undefined;
    if (phase === 'add-worktree') {
      sibling = { workspaceId: randomUUID(), runId: 'other-review-run' };
      f.execute('allocate', sibling);
    }
    const report = path.join(f.workspace, 'task', 'artifacts', 'review.md');
    const checkpoint = path.join(f.directory, 'git-checkpoint.json');
    const wrapperDirectory = path.join(f.directory, 'bin');
    mkdirSync(wrapperDirectory);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const wrapper = `#!${process.execPath}
const fs = require('node:fs');
const {spawnSync,spawn} = require('node:child_process');
const args = process.argv.slice(2);
const phase = ${JSON.stringify(phase)};
const root = ${JSON.stringify(f.root)};
const cache = ${JSON.stringify(f.cache)};
const checkpoint = ${JSON.stringify(checkpoint)};
const matches = phase === 'init-cache' ? args.includes('init') : phase === 'fetch' ? args.includes('fetch') : phase === 'add-worktree' ? args.includes('worktree') && args.includes('add') : args.includes('worktree') && args.includes('remove');
if (matches) {
  if (phase === 'init-cache') fs.mkdirSync(cache,{recursive:true});
  else if (phase === 'fetch') fs.writeFileSync(require('node:path').join(cache,'FETCH_HEAD.lock'),'interrupted fetch');
  else {
    const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});
    if(result.status!==0)process.exit(result.status || 1);
  }
  // A surviving helper must be stopped together with the gated Git process.
  const helper=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  fs.writeFileSync(checkpoint,JSON.stringify({pid:process.pid,helper:helper.pid}));
  setInterval(()=>{},1000);
} else {
 const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});
 process.exit(result.status || 0);
}
`;
    writeFileSync(path.join(wrapperDirectory, 'git'), wrapper, { mode: 0o755 });
    const child = spawn(
      process.execPath,
      [
        '-e',
        REVIEW_WORKSPACE_SCRIPT,
        JSON.stringify({
          root: f.root,
          identity: f.identity,
          action: phase === 'remove-worktree' ? 'cleanup' : 'allocate',
        }),
      ],
      {
        env: { ...process.env, PATH: `${wrapperDirectory}:${process.env.PATH}` },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    await waitUntil(() => existsSync(checkpoint));
    mkdirSync(path.dirname(report), { recursive: true });
    writeFileSync(report, 'retained through interrupted git');
    const operationPath = readlinkSync(path.join(f.root, 'locks', f.cacheKey));
    const commands = readdirSync(path.join(operationPath, 'commands')).map((id) =>
      path.join(operationPath, 'commands', id),
    );
    const command = commands.find(
      (directory) =>
        JSON.parse(readFileSync(path.join(directory, 'request.json'), 'utf8')).phase === phase,
    )!;
    const supervisor = JSON.parse(readFileSync(path.join(command, 'supervisor.json'), 'utf8'));
    const gitIdentity = JSON.parse(readFileSync(path.join(command, 'git.json'), 'utf8'));
    const checkpointState = JSON.parse(readFileSync(checkpoint, 'utf8'));
    assert.equal(gitIdentity.pid, checkpointState.pid);
    assert.throws(() => f.execute(), /REVIEW_WORKSPACE_OPERATION_PENDING/);
    await killAllocator(child);
    process.kill(supervisor.pid, 0);
    if (phase === 'add-worktree') {
      process.kill(supervisor.pid, 'SIGKILL');
      await waitUntil(() => {
        try {
          process.kill(supervisor.pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
          throw error;
        }
      });
    }
    process.kill(checkpointState.helper, 0);
    if (phase === 'add-worktree') {
      const identityFile = path.join(command, 'git.json');
      writeFileSync(
        identityFile,
        JSON.stringify({ ...gitIdentity, start: 'different process lifetime' }),
      );
      assert.throws(() => f.execute(), /process group ownership is unconfirmed/);
      process.kill(checkpointState.helper, 0);
      writeFileSync(identityFile, JSON.stringify(gitIdentity));
    }
    assert.deepEqual(f.execute(phase === 'remove-worktree' ? 'cleanup' : 'allocate'), {
      state: phase === 'remove-worktree' ? 'cleaned' : 'ready',
    });
    assert.equal(readFileSync(report, 'utf8'), 'retained through interrupted git');
    assert.equal(existsSync(path.join(f.cache, 'FETCH_HEAD.lock')), false);
    const live = execFileSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' }).split('\n');
    assert.equal(
      live.some((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
        return match && Number(match[2]) === supervisor.pid && !match[3].startsWith('Z');
      }),
      false,
    );
    if (phase === 'add-worktree') assert.ok(readdirSync(path.join(f.workspace, 'recovery')).length);
    assert.ok(existsSync(path.join(operationPath, 'recovered.json')));
    if (sibling) {
      assert.equal(
        readFileSync(
          path.join(f.root, 'runs', sibling.workspaceId, 'source', 'source.txt'),
          'utf8',
        ),
        'head\n',
      );
      assert.deepEqual(f.execute('cleanup', sibling), { state: 'cleaned' });
    }
  });
}
