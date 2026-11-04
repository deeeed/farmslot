import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { NodeTmuxPane, TmuxWorkerSummary } from '@farmslot/protocol';

let connected = true;
let allowed = true;
let requireMetadata = false;
const requests: Array<{ method: string; params: { argv: string[] } }> = [];
const node = {};
mock.module('../fleet/machine-registry.js', {
  namedExports: { getNode: () => (connected ? node : undefined) },
});
mock.module('../fleet/state.js', {
  namedExports: { loadPoolConfigs: async () => [{ machine: 'mini' }] },
});
mock.module('../fleet/node-rpc.js', {
  namedExports: {
    sendNodeRequest: async (actual: object, method: string, params: { argv: string[] }) => {
      assert.equal(actual, node);
      requests.push({ method, params });
      if (requests.length > 1)
        return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
      const session = params.argv.at(-1);
      assert.match(session ?? '', /^cc-terminal-[0-9a-f-]{36}$/);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          session,
          window: '2',
          pane: '1',
          paneId: '%77',
          pid: 12345,
          cwd: '/Users/real-user',
          command: 'zsh',
          title: 'User shell',
          windowName: 'shell',
        }),
        stderr: '',
      };
    },
  },
});
mock.module('../resources/worker-changes.js', {
  namedExports: { publishWorkerResources: () => {} },
});
mock.module('./tmux-workers.js', {
  namedExports: {
    tmuxWorkerAllowedByConfig: (_config: unknown, worker: TmuxWorkerSummary) =>
      allowed &&
      (!requireMetadata ||
        (worker.command === 'zsh' &&
          worker.title === 'User shell' &&
          worker.ref.windowName === 'shell')),
    tmuxWorkerFromNodePane: ({ nodeId, pane }: { nodeId: string; pane: NodeTmuxPane }) => ({
      ref: { nodeId, ...pane },
      command: pane.command,
      title: pane.title,
    }),
  },
});
const { tmuxWorkerCreateSession } = await import('./tmux-worker-create.js');

test('regular terminal creation uses a fresh isolated session and actual node home, never a run/slot target', async () => {
  requests.length = 0;
  const result = await tmuxWorkerCreateSession({ nodeId: 'mini' });
  assert.equal(result.worker.nodeId, 'mini');
  assert.equal(result.worker.target, '%77');
  assert.equal(result.pid, 12345);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'exec');
  assert.match(requests[0].params.argv[2], /homedir/);
  assert.equal(result.worker.window, '2');
});
test('unknown/disconnected machines and injected launch fields fail before execution', async () => {
  requests.length = 0;
  connected = false;
  try {
    await assert.rejects(tmuxWorkerCreateSession({ nodeId: 'mini' }), /not connected/);
  } finally {
    connected = true;
  }
  await assert.rejects(tmuxWorkerCreateSession({ nodeId: 'unknown' }), /not connected/);
  await assert.rejects(
    // @ts-expect-error Public creation accepts only a machine, never a command.
    tmuxWorkerCreateSession({ nodeId: 'mini', command: 'unsafe' }),
    /Choose a terminal machine/,
  );
  assert.equal(requests.length, 0);
});
test('a filtered new session is cleaned up through exact pane identity without touching other work', async () => {
  requests.length = 0;
  allowed = false;
  try {
    await assert.rejects(tmuxWorkerCreateSession({ nodeId: 'mini' }), /excludes new terminal/);
  } finally {
    allowed = true;
  }
  assert.equal(requests.length, 2);
  const cleanup = JSON.parse(requests[1].params.argv.at(-1)!);
  assert.equal(cleanup.worker.paneId, '%77');
  assert.equal(cleanup.expectedPid, 12345);
});

test('machine policy sees actual command, title and window metadata before allowing the new pane', async () => {
  requests.length = 0;
  requireMetadata = true;
  try {
    const created = await tmuxWorkerCreateSession({ nodeId: 'mini' });
    assert.equal(created.worker.windowName, 'shell');
    assert.equal(requests.length, 1);
  } finally {
    requireMetadata = false;
  }
});
