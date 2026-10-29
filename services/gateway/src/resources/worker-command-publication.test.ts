import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';

import type { WebSocket } from 'ws';

import type { NodeTmuxPane } from '@farmslot/protocol';
import { type ResourceKey, resourceKeyId } from '@farmslot/protocol/client-cache';

import '../runtime/mock-pty.test-support.js';

import * as realFleet from '../fleet/state.js';
import * as realRunStore from '../runs/store.js';

// Only inventory/config routing is replaced. No operator files or node commands
// are reached; the real gateway command, RPC response checks and publisher run.
mock.module('../fleet/state.js', {
  namedExports: {
    ...realFleet,
    loadPoolConfigs: async () => [],
    loadFleetStatus: async () => ({ slots: [] }),
  },
});
mock.module('../runs/store.js', { namedExports: { ...realRunStore, getAllRuns: () => [] } });
const { registerNode, unregisterByWs } = await import('../fleet/machine-registry.js');
const { handleNodeResponse } = await import('../fleet/node-rpc.js');
const { rememberNodeTmuxPaneSnapshot, tmuxWorkerEndSession } =
  await import('../methods/tmux-workers.js');
const { resourceRevisions } = await import('./revisions.js');

test('explicit worker snapshots and confirmed session removal publish exact farm/node keys after acknowledgement', async (t) => {
  const machine = 'worker-command-proof';
  const pane: NodeTmuxPane = {
    session: 'owned-session',
    window: '0',
    pane: '0',
    paneId: '%7',
    target: 'owned-session:0.0',
    pid: 101,
  };
  let confirmed = false;
  let executions = 0;
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1,
    send(raw: string) {
      const frame = JSON.parse(raw) as { id: string; method: string };
      assert(['tmux.panes', 'exec'].includes(frame.method));
      if (frame.method === 'exec') executions++;
      handleNodeResponse(
        frame.id,
        true,
        frame.method === 'tmux.panes'
          ? { panes: [pane] }
          : {
              exitCode: 0,
              stdout: JSON.stringify({ ok: confirmed }),
              stderr: '',
            },
        undefined,
        undefined,
        ws,
      );
    },
  }) as unknown as WebSocket;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    unregisterByWs(ws);
    resourceRevisions.dispose();
    resourceRevisions.setPublisher(() => {});
    t.mock.timers.reset();
  });
  registerNode(machine, 1, ws);
  resourceRevisions.dispose();
  const keys: ResourceKey[] = [];
  const expected: ResourceKey[] = [
    { family: 'workers', scope: 'farm' },
    { family: 'workers', nodeId: machine },
  ];
  resourceRevisions.setPublisher((packet) =>
    keys.push(...packet.changes.map((change) => change.key)),
  );
  const publication = async (changed: boolean) => {
    await Promise.resolve();
    t.mock.timers.tick(201);
    assert.deepEqual(
      keys.map(resourceKeyId).sort(),
      changed ? expected.map(resourceKeyId).sort() : [],
    );
    keys.length = 0;
  };
  rememberNodeTmuxPaneSnapshot({ nodeId: machine, observedAt: Date.now(), panes: [pane] });
  await publication(true);
  const worker = {
    nodeId: machine,
    session: pane.session,
    target: pane.target,
    paneId: pane.paneId,
  };
  await assert.rejects(tmuxWorkerEndSession({ worker, expectedPid: 999 }), /Session changed/);
  assert.equal(executions, 0, 'Stale identity must not send an execution request');
  await publication(false);
  await assert.rejects(tmuxWorkerEndSession({ worker, expectedPid: 101 }), /not confirmed/);
  await publication(false);
  confirmed = true;
  assert.deepEqual(await tmuxWorkerEndSession({ worker, expectedPid: 101 }), { ok: true });
  assert.equal(executions, 2);
  await publication(true);
});
