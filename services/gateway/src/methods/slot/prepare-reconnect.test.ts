import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import { WebSocket } from 'ws';

import type { SlotVars } from '../../core/config.js';

let execute: (
  vars: SlotVars,
  cmd: string,
  options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
const forbidden = () => {
  throw new Error('No local process or tmux in prepare reconnect fixture');
};
mock.module('../../core/index.js', {
  namedExports: {
    execLocal: forbidden,
    execOnSlot: (vars: SlotVars, cmd: string, options: { cwd?: string; timeout?: number }) =>
      execute(vars, cmd, options),
    farmslotRoot: '/fixture',
    isLocal: () => false,
    isMissingProjectConfigError: () => false,
    loadProjectVars: forbidden,
    loadSlotVars: forbidden,
    readSlotField: forbidden,
  },
});
mock.module('../../core/tmux.js', {
  namedExports: {
    resolveTmuxSession: async () => 'prepare-fixture',
    shellQuote: (text: string) => JSON.stringify(text),
    tmuxShellSnippet: (command: string) => `tmux ${command}`,
  },
});
mock.module('../../fleet/state.js', { namedExports: { loadFleetStatus: forbidden } });
mock.module('./shared.js', {
  namedExports: { DEFAULT_GATEWAY_PORT: 7801, sanitizePhaseName: (phase: string) => phase },
});
const { handleNodeResponse, nodeExec, withNodeReconnectWait } =
  await import('../../fleet/node-rpc.js');
const { registerNode, unregisterByWs } = await import('../../fleet/machine-registry.js');
const { runPrepareCommand } = await import('./prepare-command.js');
const { releasePrepareSentinel } = await import('./prepare-sentinel.js');

test('cancel during active deps stops its window and scope before releasing the sentinel', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prepare-reconnect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const machine = 'prepare-fixture-node',
    controller = new AbortController();
  let cancelled = false,
    launched = false;
  const effects: string[] = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    send(raw: string, callback?: () => void) {
      const { id, params } = JSON.parse(raw);
      const cmd = String(params.cmd);
      callback?.();
      if (cmd.includes('respawn-pane -k')) {
        launched = true;
        cancelled = true;
        controller.abort();
        effects.push('launch');
      }
      if (launched && cmd.includes('kill-window')) effects.push('stop-window');
      if (cmd.includes('expected_scope') || cmd.includes('foreign=true'))
        effects.push('reap-scope');
      if (cmd.includes('rm -rf')) {
        assert(effects.includes('stop-window'));
        assert(effects.includes('reap-scope'));
        effects.push('unlock');
      }
      handleNodeResponse(id, true, { stdout: '', stderr: '', exitCode: 0 });
    },
  });
  const ws = socket as WebSocket;
  registerNode(machine, 1, ws);
  t.after(() => unregisterByWs(ws));
  execute = (vars, cmd, options) =>
    nodeExec(vars.machine, cmd, options?.cwd ?? vars.remoteRepo, {
      timeout: options?.timeout,
      noRetry: true,
    });
  const vars: SlotVars = {
    slotId: 'fixture-slot',
    machine,
    platform: 'cli',
    host: 'remote.invalid',
    sshUser: 'fixture',
    osType: 'macos',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: '/fixture',
    session: 'prepare-fixture',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: '',
    remoteRepo: '/fixture',
    projectName: 'fixture',
    resourceVars: {},
  };
  const result = await withNodeReconnectWait(
    async () => {
      try {
        return await runPrepareCommand(vars, path.join(root, 'prepare.log'), 'install-deps', {
          phase: 'deps',
          windowLabel: 'saved-run',
          signal: controller.signal,
          tailPollIntervalMs: 1,
          prepareScope: { token: 'saved-scope', identityPath: '/fixture/.agent/prepare.identity' },
        });
      } finally {
        await releasePrepareSentinel({
          vars,
          lockDir: '/fixture/.agent',
          lockPath: '/fixture/.agent/.preparing.lock',
        });
      }
    },
    () => {
      if (cancelled) throw new Error('Run stopped while awaiting its execution node');
    },
  );
  assert.equal(result.exitCode, 130);
  assert.deepEqual(effects, ['launch', 'stop-window', 'reap-scope', 'unlock']);
});
