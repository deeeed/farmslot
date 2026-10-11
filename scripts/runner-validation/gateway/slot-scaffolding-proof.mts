// Manual RPC proof. Use node --import tsx --experimental-test-module-mocks.
// Cases: new, user, copy-failure; baseline additionally needs FARMSLOT_PROOF_BASE_REF.
// Real backend/Git/files, fixture-only tmux, no physical slot or UI mutation.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';

const mode = process.argv[2] || 'new';
const code = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.resolve(
  process.env.FARMSLOT_PROOF_OUTPUT_DIR || path.join(tmpdir(), 'farmslot-scaffolding-proof-output'),
);
const baselineRef = process.env.FARMSLOT_PROOF_BASE_REF;
mkdirSync(output, { recursive: true });
const root = mkdtempSync(path.join(tmpdir(), 'scaffolding-rpc-'));
for (const key of Object.keys(process.env))
  if (/^FARMSLOT_|^GATEWAY_|^NODE_TOKEN$|^GW_URL$|^TMUX/.test(key)) delete process.env[key];
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  GATEWAY_HOST: '127.0.0.1',
  SCREEN_CONTROL_SOCKET: path.join(root, 'screen.sock'),
});
for (const name of ['pool', 'projects/proof-project/tasks/qa/proof', 'runs', 'home', 'repo', 'bin'])
  mkdirSync(path.join(root, name), { recursive: true });
symlinkSync(path.join(code, 'scripts'), path.join(root, 'scripts'));
symlinkSync(path.join(code, 'CLAUDE.md'), path.join(root, 'CLAUDE.md'));
symlinkSync(path.join(code, 'package.json'), path.join(root, 'package.json'));
symlinkSync(path.join(code, 'packages'), path.join(root, 'packages'));
symlinkSync(path.join(code, 'schemas'), path.join(root, 'schemas'));
symlinkSync(path.join(code, 'services'), path.join(root, 'services'));
symlinkSync(path.join(code, 'node_modules'), path.join(root, 'node_modules'));
// The only fixture transport is tmux. It cannot reach a real server.
writeFileSync(
  path.join(root, 'bin/tmux'),
  '#!/bin/sh\ncase "$1" in list-*|capture-pane|display-message|has-session) exit 1 ;; *) exit 0 ;; esac\n',
  { mode: 0o755 },
);
process.env.PATH = path.join(root, 'bin') + ':' + process.env.PATH;
mock.module(path.join(code, 'services/gateway/src/runtime/pty-stream.ts'), {
  namedExports: {
    onPtyExit: () => () => {},
    ptyExitHandlerCountForTests: () => 0,
    subscribePty: () => {
      throw Error('forbidden PTY');
    },
    unsubscribePty: () => {},
    unsubscribeAllPty: () => {},
    writePty: () => {
      throw Error('forbidden PTY');
    },
    resizePty: () => {},
    hasPty: () => false,
    reinitTmuxSession: () => {
      throw Error('forbidden PTY');
    },
  },
});
if (mode === 'baseline') {
  assert.ok(baselineRef, 'baseline mode requires FARMSLOT_PROOF_BASE_REF');
  const prior = execFileSync(
    'git',
    ['-C', code, 'show', `${baselineRef}:services/gateway/src/methods/slot/unmerged-work.ts`],
    { encoding: 'utf8' },
  )
    .replace(
      "'../../core/index.js'",
      JSON.stringify(path.join(code, 'services/gateway/src/core/index.ts')),
    )
    .replace(
      "'../../core/tmux.js'",
      JSON.stringify(path.join(code, 'services/gateway/src/core/tmux.ts')),
    );
  const priorFile = path.join(root, 'baseline.mts');
  writeFileSync(priorFile, prior);
  const base = await import(priorFile);
  mock.module(path.join(code, 'services/gateway/src/methods/slot/unmerged-work.ts'), {
    namedExports: { findUnmergedSlotWork: base.findUnmergedSlotWork },
  });
}
const repo = path.join(root, 'repo');
function git(cwd: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Proof',
      '-c',
      'user.email=proof@example.invalid',
      '-C',
      cwd,
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();
}
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'core.excludesFile', '/dev/null');
writeFileSync(path.join(repo, '.git/info/exclude'), '');
writeFileSync(path.join(repo, 'base.txt'), 'base');
git(repo, 'add', 'base.txt');
git(repo, 'commit', '-qm', 'base');
git(root, 'init', '-q', '--bare', path.join(root, 'origin.git'));
git(repo, 'remote', 'add', 'origin', path.join(root, 'origin.git'));
git(repo, 'push', '-q', 'origin', 'main');
git(repo, 'checkout', '-q', '-b', 'work-scaffolding');
writeFileSync(path.join(repo, 'feature.txt'), 'published');
git(repo, 'add', 'feature.txt');
git(repo, 'commit', '-qm', 'published');
git(repo, 'push', '-q', '-u', 'origin', 'work-scaffolding');
mkdirSync(path.join(repo, '.task/qa/proof/artifacts'), { recursive: true });
writeFileSync(path.join(repo, '.task/qa/proof/TASK.md'), 'completed task');
mkdirSync(path.join(repo, '.task/qa/parked/artifacts'), { recursive: true });
writeFileSync(path.join(repo, '.task/qa/parked/TASK.md'), 'parked task');
writeFileSync(path.join(repo, '.task/qa/parked/artifacts/evidence.txt'), 'parked evidence');
writeFileSync(path.join(repo, '.task/qa/proof/artifacts/evidence.txt'), 'evidence');
mkdirSync(path.join(repo, '.agent/.observability'), { recursive: true });
writeFileSync(path.join(repo, '.agent/.observability/hooks.jsonl'), 'observations');
mkdirSync(path.join(repo, '.agent/browser'), { recursive: true });
writeFileSync(path.join(repo, '.agent/browser/profile.json'), 'warm');
symlinkSync('.agent/.observability', path.join(repo, '.observability'));
writeFileSync(
  path.join(root, 'pool/fixture.json'),
  JSON.stringify({
    machine: 'fixture-node',
    host: 'localhost',
    ssh_user: 'fixture',
    project: 'proof-project',
    platform: 'cli',
    slots: [{ id: 'scaffold-slot', repo, session: 'scaffold-slot' }],
  }),
);
writeFileSync(
  path.join(root, 'projects/proof-project/project.json'),
  JSON.stringify({
    name: 'proof-project',
    default_branch: 'main',
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    hooks: {},
  }),
);
const store = await import(path.join(code, 'services/gateway/src/runs/store.ts'));
const run = store.createRun({
  flowType: 'dev',
  mode: 'autonomous',
  project: 'proof-project',
  ticketOrPr: 'scaffolding RPC proof',
  slotId: 'scaffold-slot',
});
store.updateRun(run.id, {
  status: 'done',
  completedAt: new Date().toISOString(),
  taskFile: path.join(root, 'projects/proof-project/tasks/qa/proof/TASK.md'),
});
writeFileSync(
  path.join(root, '.farm-status.json'),
  JSON.stringify({ slots: [{ slot: 'scaffold-slot' }] }),
);
const { updateSlotStatus } = await import(path.join(code, 'services/gateway/src/core/index.ts'));
await updateSlotStatus('scaffold-slot', {
  lifecycle: 'ready',
  phase: null,
  slot_epoch: 0,
  current_run_id: run.id,
  task_file: 'qa/proof',
  task_id: 'scaffolding proof',
  session: 'scaffold-slot',
});
if (mode === 'user') writeFileSync(path.join(repo, 'user-feature.ts'), 'user work');
if (mode === 'copy-failure') {
  mkdirSync(path.join(root, 'runs/session-archives', run.id), { recursive: true });
  writeFileSync(
    path.join(root, 'runs/session-archives', run.id, 'slot-scaffolding'),
    'blocked output',
  );
}
const { createGatewayAuthRuntime, initializeGatewayIdentity } = await import(
  path.join(code, 'services/gateway/src/security/auth.ts')
);
const auth = createGatewayAuthRuntime();
initializeGatewayIdentity(auth, { host: '127.0.0.1' });
const { createWebSocketServer } = await import(path.join(code, 'services/gateway/src/server.ts'));
const server = createServer((_req, res) => {
  res.writeHead(200);
  res.end('isolated proof');
});
const wss = createWebSocketServer(server, auth);
const { GatewayClient } = await import(path.join(code, 'packages/cli/src/gateway-client.ts'));
let exit = 0;
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${address.port}`,
    timeout: 15000,
    credential: null,
  });
  const before = git(repo, 'status', '--porcelain');
  assert.match(before, /observability/);
  const completionCodes: number[] = [];
  let result;
  let refusal;
  try {
    result = await client.callWithEvents(
      'slot.release',
      { slotId: 'scaffold-slot', expectedRunId: run.id },
      (event) => {
        if (event.event === 'script.complete')
          completionCodes.push((event.payload as { exitCode: number }).exitCode);
      },
    );
  } catch (error) {
    refusal = String(error);
  }
  if (mode === 'copy-failure') assert.deepEqual(completionCodes, [1]);
  if (mode !== 'new') {
    assert.match(
      refusal || '',
      mode === 'copy-failure' ? /Scaffolding collection failed/ : /UNMERGED_WORK/,
    );
    assert.equal(existsSync(path.join(repo, '.task/qa/proof/TASK.md')), true);
    assert.equal(existsSync(path.join(repo, '.observability')), true);
    assert.equal(git(repo, 'branch', '--show-current'), 'work-scaffolding');
    const proof = {
      mode,
      root,
      rpc: 'slot.release',
      refusal,
      sourceRetained: true,
      completionCodes,
      branchRetained: true,
      backendAndGitReal: true,
      tmuxFixtureTransportOnly: true,
      liveSlotMutation: false,
    };
    writeFileSync(
      path.join(output, `rpc-proof-${mode}.json`),
      JSON.stringify(proof, null, 2) + '\n',
    );
    console.log(JSON.stringify(proof));
  } else {
    assert.equal(result.released, true);
    const archives = path.join(root, 'runs/session-archives', run.id, 'slot-scaffolding');
    const archive = path.join(archives, readdirSync(archives)[0], 'scaffolding.tar');
    assert.ok(existsSync(archive));
    const contents = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' });
    assert.match(contents, /\.task\/qa\/proof\/TASK.md/);
    assert.match(contents, /\.agent\/\.observability\/hooks.jsonl/);
    assert.equal(existsSync(path.join(repo, '.task/qa/proof')), false);
    assert.equal(readFileSync(path.join(repo, '.task/qa/parked/TASK.md'), 'utf8'), 'parked task');
    assert.equal(
      readFileSync(path.join(repo, '.task/qa/parked/artifacts/evidence.txt'), 'utf8'),
      'parked evidence',
    );
    assert.doesNotMatch(contents, /qa\/parked/);
    assert.equal(existsSync(path.join(repo, '.observability')), false);
    assert.equal(readFileSync(path.join(repo, '.agent/browser/profile.json'), 'utf8'), 'warm');
    assert.equal(git(repo, 'branch', '--show-current'), 'main');
    const proof = {
      root,
      runId: run.id,
      rpc: 'slot.release',
      released: true,
      completionCodes,
      archive,
      taskAndObservationsPreserved: true,
      ownedSourcesRemoved: true,
      parkedSiblingRetained: true,
      warmResourcesPreserved: true,
      gitReturnedToMain: true,
      backendAndGitReal: true,
      tmuxFixtureTransportOnly: true,
      liveSlotMutation: false,
    };
    writeFileSync(path.join(output, 'rpc-proof-new.json'), JSON.stringify(proof, null, 2) + '\n');
    console.log(JSON.stringify(proof));
  }
} catch (error) {
  exit = 1;
  console.error(error);
  writeFileSync(
    path.join(output, `rpc-proof-failure-${mode}.json`),
    JSON.stringify({ root, error: String(error) }, null, 2),
  );
} finally {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
process.exit(exit);
