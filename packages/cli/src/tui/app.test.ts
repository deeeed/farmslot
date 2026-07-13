import assert from 'node:assert/strict';
import test from 'node:test';

import { render } from 'ink-testing-library';
import { createElement } from 'react';

import type { EventFrame } from '@farmslot/protocol';

import type { GatewayConnection } from '../gateway-client.js';

import { App } from './app.js';

function fakeConnection(): GatewayConnection & { closed: boolean } {
  const responses: Record<string, unknown> = {
    'fleet.status': {
      fleet: {
        checkedAt: '2026-07-13T00:00:00Z',
        stale: false,
        summary: { total: 1, ready: 1, busy: 0, held: 0, manual: 0, disabled: 0, blocked: 0 },
        slots: [
          {
            slot: 'demo-ff-1',
            machine: 'demo',
            lifecycle: 'ready',
            agent: 'idle',
            branch: 'main',
            dispatchable: true,
            taskId: null,
          },
        ],
      },
    },
    'backlog.list': {
      items: [
        {
          id: 'item-1',
          sourceRef: 'MANUAL-000001',
          status: 'ready',
          priority: 1,
          project: 'demo',
          title: 'demo item',
        },
      ],
    },
    'run.list': { runs: [] },
  };
  const connection = {
    closed: false,
    call<T>(method: string): Promise<T> {
      const payload = responses[method];
      if (!payload) throw new Error(`Unexpected method in test: ${method}`);
      return Promise.resolve(payload as T);
    },
    onEvent(_handler: (event: EventFrame) => void): () => void {
      return () => {};
    },
    close(): void {
      connection.closed = true;
    },
  };
  return connection;
}

test('App renders the fleet surface from gateway data', async () => {
  const connection = fakeConnection();
  const { lastFrame, unmount } = render(
    createElement(App, { connection, gatewayUrl: 'ws://test:1' }),
  );
  // Let the initial refresh (useEffect → RPC promises) commit.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const frame = lastFrame() ?? '';
  assert.match(frame, /farmslot tui/u);
  assert.match(frame, /1:fleet/u);
  assert.match(frame, /demo-ff-1/u);
  unmount();
});

test('App switches to the backlog surface on "2"', async () => {
  const connection = fakeConnection();
  const { lastFrame, stdin, unmount } = render(
    createElement(App, { connection, gatewayUrl: 'ws://test:1' }),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  stdin.write('2');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(lastFrame() ?? '', /MANUAL-000001/u);
  unmount();
});
