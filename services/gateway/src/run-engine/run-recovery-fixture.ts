import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, type TestContext } from 'node:test';
import { promisify } from 'node:util';

import type { ExecResult, Run } from '@farmslot/protocol';

import { testGatewayIdentity } from '../../../../scripts/lib/test-gateway-identity-source.mjs';
import type { RawProjectJson, SlotVars } from '../core/config.js';

const executeFile = promisify(execFile);
export const root = mkdtempSync(path.join(tmpdir(), 'run-recovery-'));
export const project = 'recovery-fixture';
export const branch = 'feature/published';
export const slotId = 'recovery-slot';
export const repo = path.join(root, 'slot');
export const origin = path.join(root, 'origin.git');
export const commands: string[] = [];
export let panePid = process.pid;
let invalidateProject: (() => void) | undefined;
let invalidateFleet: (() => void) | undefined;

export function setPanePid(pid: number): void {
  panePid = pid;
}

const environment = {
  FARMSLOT_ROOT: root,
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, '.farm-status.json'),
  NODE_TEST_CONTEXT: '1',
};
const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
for (const dir of [
  'scripts',
  'services/gateway',
  'pool',
  `projects/${project}`,
  'home',
  'runs',
  'base',
])
  mkdirSync(path.join(root, dir), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable recovery fixture\n');
writeFileSync(path.join(root, 'scripts/dev.sh'), '');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');

export function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const base = path.join(root, 'base');
git(base, 'init', '-q', '-b', 'main');
git(base, 'config', 'user.name', 'Fixture');
git(base, 'config', 'user.email', 'fixture@example.invalid');
git(base, 'config', 'commit.gpgsign', 'false');
writeFileSync(path.join(base, 'base.txt'), 'base\n');
git(base, 'add', '.');
git(base, 'commit', '-qm', 'test: seed');
execFileSync('git', ['clone', '--bare', base, origin], { stdio: 'ignore' });
git(base, 'remote', 'add', 'origin', origin);
git(base, 'fetch', 'origin');
git(base, 'worktree', 'add', '-b', branch, repo, 'main');
writeFileSync(path.join(repo, 'worker.txt'), 'published work\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'test: published work');
git(repo, 'push', '-u', 'origin', branch);

export function configureProject(extra: Partial<RawProjectJson> = {}): void {
  writeFileSync(
    path.join(root, 'projects', project, 'project.json'),
    JSON.stringify({
      name: project,
      repo_url: 'https://example.invalid/app.git',
      default_branch: 'main',
      prepare: { default_profile: 'git-only', profiles: { 'git-only': { phases: ['git'] } } },
      ...extra,
    }),
  );
  invalidateProject?.();
}
configureProject();
const slots = [
  { id: slotId, repo, session: slotId, resources: { runtime: {} } },
  {
    id: 'recovery-requested',
    repo: path.join(root, 'requested'),
    session: 'recovery-requested',
    resources: {},
  },
];
git(base, 'worktree', 'add', '--detach', slots[1].repo, 'main');
writeFileSync(
  path.join(root, 'pool/local.json'),
  JSON.stringify({ machine: 'fixture', host: 'localhost', project, platform: 'cli', slots }),
);

export function setSlot(owner: string | null = null): void {
  writeFileSync(
    path.join(root, '.farm-status.json'),
    JSON.stringify({
      checked_at: new Date().toISOString(),
      slots: slots.map((slot) => ({
        slot: slot.id,
        machine: 'fixture',
        project,
        platform: 'cli',
        linked_worktree: true,
        branch: git(slot.repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
        head_sha: git(slot.repo, 'rev-parse', 'HEAD'),
        lifecycle: owner && slot.id === slotId ? 'busy' : 'ready',
        phase: owner && slot.id === slotId ? 'working' : null,
        agent: owner && slot.id === slotId ? 'working' : 'idle',
        current_run_id: slot.id === slotId ? owner : null,
        current_family_id: null,
        enabled: true,
        health: { ssh: 'LOCAL' },
      })),
    }),
  );
  invalidateFleet?.();
}
setSlot();

// The production PTY import and every direct tmux child are forbidden. Only
// structured discovery replies below are simulated; Git and provider commands run.
const realExec = await import('../core/exec.js');
async function slotExec(vars: SlotVars, command: string): Promise<ExecResult> {
  commands.push(command);
  if (command.includes('TMUX_BIN') || /\btmux\b/.test(command)) {
    assert.doesNotMatch(
      command,
      /send-keys|send-text|paste-buffer/,
      'no fixture prompt may be typed',
    );
    if (command.includes('#{pane_current_command}'))
      return { exitCode: 0, stdout: `%1|${panePid}|sh`, stderr: '' };
    return { exitCode: 1, stdout: '', stderr: 'fixture has no tmux server' };
  }
  try {
    const result = await executeFile('bash', ['-c', command], {
      cwd: vars.remoteRepo,
      timeout: 2000,
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const result = error as Error & { stdout?: string; stderr?: string; code?: number };
    if (typeof result.code !== 'number') throw error;
    return { exitCode: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
}
mock.module('../core/exec.js', { namedExports: { ...realExec, execOnSlot: slotExec } });
const realCore = await import('../core/index.js');
mock.module('../core/index.js', { namedExports: { ...realCore, execOnSlot: slotExec } });
const configuration = await import('../core/config.js');
invalidateProject = () => configuration.invalidateProjectVarsCache(project);
const fleet = await import('../fleet/state.js');
invalidateFleet = () => fleet.setCachedFleetForTests(null);

export const { loadSlotVars, readSlotRow } = await import('../core/index.js');
export const { createRun, getRun, updateRun, deleteRun } = await import('../runs/store.js');
const { createGatewayAuthRuntime, initializeGatewayIdentity } = await import('../security/auth.js');
const { createWebSocketServer } = await import('../server.js');
const fixtureToken = testGatewayIdentity(environment.FARMSLOT_HOME!);
const auth = createGatewayAuthRuntime({
  FARMSLOT_HOME: environment.FARMSLOT_HOME,
  GATEWAY_HOST: '127.0.0.1',
});
initializeGatewayIdentity(auth, { host: '127.0.0.1' });
const server = createServer();
const wss = createWebSocketServer(server, auth);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const port = address.port;
const { GatewayClient } = await import('../../../../packages/cli/src/gateway-client.js');
const client = new GatewayClient({
  url: `ws://127.0.0.1:${port}`,
  credential: { token: fixtureToken },
  timeout: 3000,
});

export async function rpc<T>(method: string, params: unknown): Promise<T> {
  return client.call<T>(method, params);
}

const runs: Run[] = [];
export function run(t: TestContext, status: Run['status'] = 'monitoring'): Run {
  const value = createRun({
    flowType: 'dev',
    project,
    ticketOrPr: `FIXTURE-${runs.length}`,
    slotId,
    branch,
    prepareProfile: 'git-only',
  });
  runs.push(value);
  t.after(() => updateRun(value.id, { status: 'done' }));
  return updateRun(value.id, { status });
}

export async function close(): Promise<void> {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve, reject) =>
    wss.close((error) => (error ? reject(error) : resolve())),
  );
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  for (const value of runs) {
    updateRun(value.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(value.id);
  }
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
