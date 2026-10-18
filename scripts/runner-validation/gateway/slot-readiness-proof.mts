// Manual public-RPC proof. No physical slot, native app, or real tmux server.
// Run: node --import tsx --experimental-test-module-mocks <this-file> [baseline <base-ref>]
import '../lib/no-inherited-git-location.mjs';

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';
import type { SlotCheckResult } from '@farmslot/protocol';

const code =
  process.env.FARMSLOT_PROOF_CODE_ROOT || fileURLToPath(new URL('../../../', import.meta.url));
const baseline = process.argv[2] === 'baseline';
const output = process.env.FARMSLOT_PROOF_OUTPUT_DIR;
assert.ok(output, 'set FARMSLOT_PROOF_OUTPUT_DIR to retained receipts');
mkdirSync(output, { recursive: true });
const root = mkdtempSync(path.join(os.tmpdir(), 'slot-readiness-rpc-'));
for (const key of Object.keys(process.env)) {
  if (/^FARMSLOT_|^GATEWAY_|^NODE_TOKEN$|^GW_URL$|^TMUX|^GIT_CONFIG/.test(key))
    delete process.env[key];
}
Object.assign(process.env, {
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  SCREEN_CONTROL_SOCKET: path.join(root, 'screen.sock'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});
for (const d of ['home', 'pool', 'projects/proof/fixtures', 'runs', 'repo', 'bin'])
  mkdirSync(path.join(root, d), { recursive: true });
for (const n of [
  'scripts',
  'CLAUDE.md',
  'package.json',
  'packages',
  'schemas',
  'services',
  'node_modules',
])
  symlinkSync(path.join(code, n), path.join(root, n));
writeFileSync(
  path.join(root, 'bin/tmux'),
  '#!/bin/sh\ncase "$1" in has-session|list-*|display-message|capture-pane) exit 1 ;; *) exit 0 ;; esac\n',
  { mode: 0o755 },
);
for (const n of ['claude', 'codex', 'cursor', 'agent'])
  writeFileSync(path.join(root, 'bin', n), '#!/bin/sh\necho "proof version 1.0"\n', {
    mode: 0o755,
  });
process.env.PATH = path.join(root, 'bin') + ':' + process.env.PATH;
mock.module(path.join(code, 'services/gateway/src/runtime/pty-stream.ts'), {
  namedExports: {
    onPtyExit: () => () => {},
    ptyExitHandlerCountForTests: () => 0,
    subscribePty: () => {
      throw new Error('no PTY in this proof');
    },
    unsubscribePty: () => {},
    unsubscribeAllPty: () => {},
    writePty: () => {
      throw new Error('no PTY in this proof');
    },
    resizePty: () => {},
    hasPty: () => false,
    reinitTmuxSession: () => {},
  },
});
if (baseline) {
  assert.ok(process.argv[3], 'pass the expected baseline commit');
  assert.equal(
    execFileSync('git', ['-C', code, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    process.argv[3],
  );
}
const repo = path.join(root, 'repo');
function git(...args: string[]) {
  return execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
  }).trim();
}
git('init', '--initial-branch=main');
git('config', 'user.name', 'Readiness proof');
git('config', 'user.email', 'proof@example.invalid');
writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
git('add', '.');
git('commit', '-m', 'test: seed readiness fixture');
git('checkout', '-b', 'preserved-feature');
writeFileSync(path.join(repo, 'tracked.txt'), 'retained edit\n');
git('config', 'commit.gpgsign', 'false');
const seed =
  'CONSENSYS_SKILLS_DIR=../consensys-skills\nSKILLS_DOMAINS=perps,agentic\nSKILLS_MATURITY=experimental\n';
writeFileSync(path.join(root, 'projects/proof/fixtures/skills.local'), seed);
writeFileSync(
  path.join(repo, '.skills.local'),
  seed.replace('../consensys-skills', path.join(root, 'consensys-skills')) +
    `METAMASK_SKILLS_TARGET_REPO=core\nMETAMASK_SKILLS_DIR=${path.join(root, 'metamask-skills')}\n`,
);
writeFileSync(path.join(root, 'projects/proof/fixtures/ignore'), 'temp/\n.agents/\n');
writeFileSync(path.join(repo, '.git/info/exclude'), 'temp/\n.agents/\n.skills-cache/\n');
writeFileSync(path.join(repo, 'health-state'), 'ready\n');
writeFileSync(path.join(repo, 'server.log'), 'server started\n');
utimesSync(path.join(repo, 'server.log'), new Date(0), new Date(0));
writeFileSync(
  path.join(root, 'home/git-identity.json'),
  JSON.stringify({
    'user.name': 'Readiness proof',
    'user.email': 'proof@example.invalid',
    'commit.gpgsign': 'true',
  }),
);
writeFileSync(
  path.join(root, 'pool/fixture.json'),
  JSON.stringify({
    machine: os.hostname(),
    host: 'localhost',
    project: 'proof',
    platform: 'cli',
    env: { METAMASK_SKILLS_DIR: path.join(root, 'metamask-skills') },
    slots: [{ id: 'readiness-slot', repo, session: 'readiness-slot' }],
  }),
);
writeFileSync(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({
    name: 'proof',
    repo_url: 'git@github.com:MetaMask/core.git',
    default_branch: 'main',
    paths: { runtime_dir: '.agent', artifact_dir: '.task' },
    hooks: { health_check: 'cat health-state', dev_server_check: 'true' },
    health: { ready_indicator: 'ready', dev_server_log: 'server.log' },
    fixtures: {
      templates: [
        { src: 'skills.local', dst: '.skills.local' },
        { src: 'ignore', dst: '.git/info/exclude' },
      ],
    },
    prepare: {
      default: 'attach',
      profiles: {
        attach: { phases: ['health'], requires: ['health_ok'], fallback: 'fallback' },
        fallback: { phases: ['health'] },
      },
    },
  }),
);
writeFileSync(
  path.join(root, '.farm-status.json'),
  JSON.stringify({ slots: [{ slot: 'readiness-slot', lifecycle: 'ready' }] }),
);
const { loadProjectVars } = await import(path.join(code, 'services/gateway/src/core/config.ts'));
await loadProjectVars('proof');
const { createGatewayAuthRuntime, initializeGatewayIdentity } = await import(
  path.join(code, 'services/gateway/src/security/auth.ts')
);
const auth = createGatewayAuthRuntime();
initializeGatewayIdentity(auth, { host: '127.0.0.1' });
const { createWebSocketServer } = await import(path.join(code, 'services/gateway/src/server.ts'));
const { GatewayClient } = await import(path.join(code, 'packages/cli/src/gateway-client.ts'));
const server = createServer((_req, res) => res.end('isolated readiness proof'));
const wss = createWebSocketServer(server, auth);
try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    timeout: 20000,
    credential: null,
  });
  const before = {
    head: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current'),
    tracked: readFileSync(path.join(repo, 'tracked.txt'), 'utf8'),
  };
  const checks = await client.call<SlotCheckResult>('slot.check', { slotId: 'readiness-slot' });
  writeFileSync(path.join(output, 'checks-debug.json'), JSON.stringify(checks, null, 2));
  const fixture = checks.checks.find((s) => s.name === 'fixture:.skills.local');
  const ignore = checks.checks.find((s) => s.name === 'fixture:.git/info/exclude');
  assert.equal(ignore?.status, baseline ? 'fail' : 'pass');
  const log = checks.checks.find((s) => s.name === 'devserver.log');
  assert.equal(fixture?.status, baseline ? 'fail' : 'pass');
  assert.equal(log?.status, baseline ? 'fail' : 'pass');
  await client.call('slot.prepare', {
    slotId: 'readiness-slot',
    prepareProfile: 'attach',
    strictProfile: true,
  });
  const signing = execFileSync(
    'git',
    ['-C', repo, 'config', '--local', '--get', 'commit.gpgsign'],
    { encoding: 'utf8' },
  ).trim();
  assert.equal(signing, baseline ? 'false' : 'true');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, 'health-state'), 'cold\n');
  await assert.rejects(
    client.call('slot.prepare', {
      slotId: 'readiness-slot',
      prepareProfile: 'attach',
      strictProfile: true,
    }),
  );
  const coldSigning = execFileSync(
    'git',
    ['-C', repo, 'config', '--local', '--get', 'commit.gpgsign'],
    { encoding: 'utf8' },
  ).trim();
  assert.equal(coldSigning, baseline ? 'false' : 'true');
  assert.equal(git('rev-parse', 'HEAD'), before.head);
  assert.equal(git('branch', '--show-current'), before.branch);
  assert.equal(readFileSync(path.join(repo, 'tracked.txt'), 'utf8'), before.tracked);
  const proof = {
    baseline,
    fixture,
    ignore,
    log,
    signing,
    headAndDirtyFilePreserved: true,
    publicRpc: ['slot.check', 'slot.prepare'],
    scope:
      'isolated production Gateway/client and real Git/files; tmux fixture only; no physical runtime proof',
    root,
  };
  writeFileSync(
    path.join(output, `rpc-${baseline ? 'baseline' : 'head'}.json`),
    JSON.stringify(proof, null, 2) + '\n',
  );
  console.log(JSON.stringify(proof));
} finally {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
