// Private authenticated baseline proof. No worker is launched or task delivered.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { RunCreateResult, RunGetResult } from '@farmslot/protocol';
import type { GatewayConnection } from '../../../packages/cli/src/gateway-client.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'pr-signature-ref-'));
const output = path.resolve(process.env.FARMSLOT_PROOF_OUTPUT_DIR ?? 'temp/pr-signature-ref-proof');
const workspace = path.join(root, 'workspace');
const home = path.join(root, 'home');
const repo = path.join(root, 'checkout');
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_ROOT: workspace,
  FARMSLOT_WORKSPACE: '',
  FARMSLOT_HOME: home,
  FARMSLOT_POOL_DIR: path.join(workspace, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(workspace, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'scratch.json'), JSON.stringify({ root }) + '\n');
for (const name of ['scripts', 'services/gateway', 'pool', 'projects/proof'])
  await mkdir(path.join(workspace, name), { recursive: true });
await writeFile(path.join(workspace, 'CLAUDE.md'), '# Private proof\n');
await writeFile(path.join(workspace, 'scripts/dev.sh'), '# Private proof\n');
await writeFile(
  path.join(workspace, 'services/gateway/package.json'),
  '{"name":"@farmslot/gateway"}',
);
await writeFile(
  path.join(workspace, 'projects/proof/project.json'),
  JSON.stringify({
    name: 'proof',
    default_branch: 'main',
    hooks: {},
    scripted: { commands: { proof: { command: 'true' } } },
  }),
);
await writeFile(
  path.join(workspace, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    ssh_user: os.userInfo().username,
    project: 'proof',
    platform: 'cli',
    slots: [{ id: 'signature-proof', repo, session: 'signature-proof' }],
  }),
);
await writeFile(path.join(root, 'status.json'), '{"slots":[]}');
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
    encoding: 'utf8',
  }).trim();
}
const author = path.join(root, 'author'),
  remote = path.join(root, 'origin.git');
git(root, 'init', '-q', '-b', 'main', author);
git(author, 'config', 'user.name', 'Fixture');
git(author, 'config', 'user.email', 'fixture@example.invalid');
git(author, 'config', 'commit.gpgsign', 'false');
git(author, 'commit', '-q', '--allow-empty', '-m', 'test: trusted base');
git(root, 'init', '-q', '--bare', remote);
git(author, 'remote', 'add', 'origin', remote);
git(author, 'push', '-q', 'origin', 'main');
git(author, 'checkout', '-q', '-b', 'unfetched-pr-fixture');
git(author, 'commit', '-q', '--allow-empty', '-m', 'test: published author');
const published = git(author, 'rev-parse', 'HEAD');
git(author, 'push', '-q', 'origin', 'unfetched-pr-fixture');
git(root, 'clone', '-q', '--no-local', '--single-branch', '--branch', 'main', remote, repo);
assert.notEqual(
  spawnSync('git', ['-C', repo, 'cat-file', '-e', published], { encoding: 'utf8' }).status,
  0,
);
const key = path.join(root, 'fixture-key');
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
for (const [name, value] of Object.entries({
  'user.name': 'Fixture',
  'user.email': 'fixture@example.invalid',
  'gpg.format': 'ssh',
  'user.signingkey': key,
  'commit.gpgsign': 'true',
}))
  git(repo, 'config', name, value);
git(repo, 'checkout', '-q', '-b', 'previous-finished-task');
git(repo, 'commit', '-q', '--allow-empty', '-m', 'test: signed finished task');
const signedHead = git(repo, 'rev-parse', 'HEAD');
const { loadSlotVars } = await import('../../../services/gateway/src/core/config.js');
const vars = await loadSlotVars('signature-proof');
const store = await import('../../../services/gateway/src/runs/store.js');
const { recordRetainedPrBaseline } =
  await import('../../../services/gateway/src/methods/dispatch/worktree-baseline.js');
const { createGatewayAuthRuntime } = await import('../../../services/gateway/src/security/auth.js');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
const person = auth.writer.createPrincipal({ type: 'person', displayName: 'Signature fixture' }, [
  { role: 'admin', scope: { kind: 'global' } },
]);
const credential = auth.writer.issueCredential(person.id, 'Disposable fixture');
const grant = auth.writer.exchangePersonCredential(credential.secret, {
  deviceName: 'Fixture',
  deviceKind: 'cli',
});
const { createWebSocketServer } = await import('../../../services/gateway/src/server.js');
const { GatewayClient } = await import('../../../packages/cli/src/gateway-client.js');
const server = createServer(),
  wss = createWebSocketServer(server, auth);
let client: GatewayConnection | undefined;
async function create(branch: string): Promise<RunCreateResult> {
  assert(client);
  for (const run of store.getAllRuns()) {
    store.updateRun(run.id, { status: 'done' });
    await store.deleteRun(run.id);
  }
  return client.call<RunCreateResult>('run.create', {
    project: 'proof',
    flowType: 'update-branch',
    mode: 'autonomous',
    lane: 'comparison',
    variant: 'fixture',
    runner: 'scripted',
    scripted: { mode: 'command', commandRef: 'proof' },
    transport: 'tmux',
    ticketOrPr: 'example/proof#138',
    branch,
    prNumber: 138,
    slotId: 'signature-proof',
    ticketData: {
      source: 'manual',
      title: 'Materialize the signature base',
      description: '',
      affectedArea: '',
      acceptanceCriteria: [],
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
  });
}
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  client = await new GatewayClient({
    url: `ws://127.0.0.1:${address.port}/ws`,
    credential: { token: grant.accessToken },
    timeout: 30000,
  }).connect();
  const valid = await create('unfetched-pr-fixture');
  assert.equal(
    git(repo, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/unfetched-pr-fixture'),
    '',
  );
  await recordRetainedPrBaseline(valid.run.id, vars);
  const validReadback: RunGetResult = await client.call<RunGetResult>('run.get', {
    runId: valid.run.id,
  });
  assert.equal(validReadback.run.worktreeHeadAtDispatch, signedHead);
  assert.equal(git(repo, 'rev-parse', 'refs/remotes/origin/unfetched-pr-fixture'), published);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), signedHead);
  assert.equal(git(repo, 'branch', '--show-current'), 'previous-finished-task');
  git(repo, 'update-ref', '-d', 'refs/remotes/origin/unfetched-pr-fixture');
  const unsigned = git(
    repo,
    'commit-tree',
    git(repo, 'rev-parse', 'HEAD^{tree}'),
    '-p',
    signedHead,
    '-m',
    'test: unsigned inherited rewrite',
  );
  git(repo, 'update-ref', 'HEAD', unsigned);
  const rejected = await create('unfetched-pr-fixture');
  await assert.rejects(
    recordRetainedPrBaseline(rejected.run.id, vars),
    new RegExp(`Unsigned outgoing commit\\(s\\): ${unsigned.slice(0, 12)}`),
  );
  const rejectedReadback: RunGetResult = await client.call<RunGetResult>('run.get', {
    runId: rejected.run.id,
  });
  assert.equal(rejectedReadback.run.worktreeHeadAtDispatch, undefined);
  const absent = await create('unavailable-pr-fixture');
  await assert.rejects(
    recordRetainedPrBaseline(absent.run.id, vars),
    /Cannot fetch PR branch unavailable-pr-fixture before checking inherited commit signatures/,
  );
  const absentReadback: RunGetResult = await client.call<RunGetResult>('run.get', {
    runId: absent.run.id,
  });
  assert.equal(absentReadback.run.worktreeHeadAtDispatch, undefined);
  git(repo, 'config', 'commit.gpgsign', 'false');
  const disabled = await create('signing-disabled-unfetched-fixture');
  await recordRetainedPrBaseline(disabled.run.id, vars);
  const disabledReadback: RunGetResult = await client.call<RunGetResult>('run.get', {
    runId: disabled.run.id,
  });
  assert.equal(disabledReadback.run.worktreeHeadAtDispatch, unsigned);
  assert.equal(
    git(
      repo,
      'for-each-ref',
      '--format=%(refname)',
      'refs/remotes/origin/signing-disabled-unfetched-fixture',
    ),
    '',
  );
  assert.equal(git(repo, 'rev-parse', 'HEAD'), unsigned);
  assert.equal(git(repo, 'branch', '--show-current'), 'previous-finished-task');
  const result = {
    status: 'PASS',
    singleBranchRefspec: git(repo, 'config', '--get', 'remote.origin.fetch'),
    freshPrObjectInitiallyAbsent: true,
    fetchedExactRemotePr: true,
    signedHead,
    published,
    unsigned,
    signedBaselineCaptured: true,
    unsignedAndFetchFailureLeaveBaselineUnset: true,
    signingDisabledPreserved: true,
    checkoutAndHeadNeverReset: true,
    boundary:
      'Authenticated production run.create/run.get with real retained-dispatch baseline producer and signature guard, real private Git remote and SSH-signed objects. Run scheduler disabled; no worker delivery, live slot, model, app or product run.',
    modelTurns: 0,
  };
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  client?.close();
  for (const connection of wss.clients) connection.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const run of store.getAllRuns()) {
    store.updateRun(run.id, { status: 'done' });
    await store.deleteRun(run.id);
  }
  await rm(root, { recursive: true, force: true });
  await writeFile(
    path.join(output, 'cleanup.json'),
    JSON.stringify({ root, removed: true }) + '\n',
  );
}
process.exit(0);
