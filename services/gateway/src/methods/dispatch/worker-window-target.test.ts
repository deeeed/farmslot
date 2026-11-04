import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import { parse } from 'shell-quote';

import type { AgentRole } from '@farmslot/protocol';

const root = await mkdtemp(path.join(os.tmpdir(), 'worker-window-target-'));
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
});
after(() => rm(root, { recursive: true, force: true }));
for (const dir of ['pool', 'projects/proof', 'home'])
  await mkdir(path.join(root, dir), { recursive: true });
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({
    machine: 'local',
    host: 'localhost',
    project: 'proof',
    platform: 'cli',
    slots: [{ id: 'slot', repo: root, session: 'fixture' }],
  }),
);
await writeFile(
  path.join(root, 'projects/proof/project.json'),
  JSON.stringify({ name: 'proof', default_branch: 'main', hooks: {} }),
);
await import('../../runtime/mock-pty.test-support.js');
const realCore = await import('../../core/index.js');
const windows = new Map<string, { index: number; dead: boolean }>();
const mutations: string[][] = [];
function resolveWindow(target: string): string | undefined {
  const name = target.split(':')[1] ?? '';
  if (name.startsWith('=')) return windows.has(name.slice(1)) ? name.slice(1) : undefined;
  return (
    [...windows].find(([key, value]) => key === name || String(value.index) === name)?.[0] ??
    [...windows.keys()].find((key) => key.startsWith(name))
  );
}
mock.module('../../core/index.js', {
  namedExports: {
    ...realCore,
    execOnSlot: async (_vars: unknown, command: string) => {
      const args = parse(command.split('\n').at(-1) ?? '')
        .filter((part): part is string => typeof part === 'string')
        .slice(1);
      const verb = args[0];
      const target = args[args.indexOf('-t') + 1] ?? '';
      const found = resolveWindow(target);
      const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
      if (verb === 'has-session') return ok();
      if (verb === 'list-windows') return ok('0\n');
      if (verb === 'list-panes') {
        if (!found) return { exitCode: 1, stdout: '', stderr: 'missing window' };
        return ok(args.includes('#{pane_dead}') && windows.get(found)?.dead ? '1\n' : '0\n');
      }
      if (verb === 'display-message') return ok(found ?? '');
      mutations.push(args);
      if (verb === 'new-window') {
        windows.set(args[args.indexOf('-n') + 1]!, { index: windows.size, dead: false });
        return ok();
      }
      assert.ok(['set-window-option', 'set-hook', 'respawn-window'].includes(verb ?? ''), command);
      assert.notEqual(found, 'devserver-log', 'log window must never be treated as a worker');
      assert.ok(found, `mutation has an exact worker target: ${target}`);
      if (verb === 'respawn-window') windows.get(found)!.dead = false;
      return ok();
    },
  },
});
const realTmux = await import('../../core/tmux.js');
mock.module('../../core/tmux.js', {
  namedExports: { ...realTmux, firstWindowTarget: async () => 'fixture:0' },
});
const { loadSlotVars } = await import('../../core/config.js');
const { ensureWorkerRoleTarget } = await import('./execute.js');
const vars = await loadSlotVars('slot');
beforeEach(() => {
  windows.clear();
  mutations.length = 0;
  windows.set('worker', { index: 0, dead: false });
  windows.set('devserver-log', { index: 1, dead: false });
});
for (const [role, name] of [
  ['dev', 'dev'],
  ['fix-bug', 'bugfix'],
  ['review', 'review'],
] satisfies [AgentRole, string][]) {
  test(`missing ${role} window gets its own target beside devserver-log`, async () => {
    const target = await ensureWorkerRoleTarget(vars, 'fixture', 'scripted', role);
    assert.equal(target, `fixture:${name}`, 'persisted target format stays unchanged');
    assert.equal(resolveWindow(target), name);
    assert.ok(windows.has(name), 'a role window was created instead of borrowing a prefix match');
    assert.deepEqual(windows.get('devserver-log'), { index: 1, dead: false });
    assert.equal(mutations.filter((args) => args[0] === 'new-window').length, 1);
  });
}
test('an existing exact role window is reused without creation', async () => {
  windows.set('dev', { index: 2, dead: false });
  const target = await ensureWorkerRoleTarget(vars, 'fixture', 'scripted', 'dev');
  assert.equal(resolveWindow(target), 'dev');
  assert.deepEqual(mutations, []);
});
test('a dead role window respawns only its exact target', async () => {
  windows.set('dev', { index: 2, dead: true });
  const target = await ensureWorkerRoleTarget(vars, 'fixture', 'scripted', 'dev');
  assert.equal(resolveWindow(target), 'dev');
  assert.equal(windows.get('dev')?.dead, false);
  assert.equal(mutations.filter((args) => args[0] === 'respawn-window').length, 1);
});
