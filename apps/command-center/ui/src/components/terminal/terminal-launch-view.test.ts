import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { Methods, type NodesListResult, type TmuxWorkerRef } from '@farmslot/protocol';
import type { ResourceQueryState } from '@farmslot/protocol/client-cache';

import { litBindings, litText } from '../../testing/lit-text.js';

const filters = { projects: [] as string[], machines: [] as string[] };
const calls: Array<{ method: string; params: unknown }> = [];
const worker: TmuxWorkerRef = {
  nodeId: 'mini',
  session: 'cc-terminal-unique',
  paneId: '%7',
  target: '%7',
};
class FixtureQuery {
  belongsToWorkspace = true;
  state: ResourceQueryState<NodesListResult> = {
    status: 'ready',
    data: {
      nodes: [
        { machine: 'mini', pid: 1, connectedAt: 'now' },
        { machine: 'macpro', pid: 2, connectedAt: 'now' },
      ],
      gatewayProtocolVersion: 'test',
    },
  };
  setQuery() {}
}
mock.module('../shared/resource-query-controller.js', {
  namedExports: {
    ResourceQueryController: FixtureQuery,
    canActOn: (state: ResourceQueryState<unknown>) => state.status === 'ready',
  },
});
mock.module('../chat/native-session-view.js', { namedExports: {} });
mock.module('../shared/choice-picker.js', { namedExports: {} });
mock.module('../../state.js', {
  namedExports: { getState: () => ({ globalFilters: filters }), subscribe: () => () => {} },
});
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return { worker, pid: 123 };
      },
    },
  },
});
Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '#terminal' } });
const { TerminalLaunchView } = await import('./terminal-launch-view.js');

test('new native sessions mount the shipped launcher and preserve the route/session target', () => {
  const view = new TerminalLaunchView();
  view.selection = 'view=new&transport=native&executionNodeId=mini&sessionId=native-existing';
  const rendered = Reflect.get(view, 'render').call(view);
  assert.match(litText(rendered), /native-session-view/);
  assert.doesNotMatch(litText(rendered), /Start terminal/);
  assert(litBindings(rendered, '.initialSessionId=').includes('native-existing'));
  assert(litBindings(rendered, '.initialExecutionNodeId=').includes('mini'));
});
test('a regular launch sends only its chosen machine then opens the existing terminal viewer URL', async () => {
  calls.length = 0;
  filters.machines = [];
  const view = new TerminalLaunchView();
  view.selection = 'view=new&transport=tmux&executionNodeId=mini';
  await Reflect.get(view, 'createTerminal').call(view);
  assert.deepEqual(calls, [
    { method: Methods.TMUX_WORKER_CREATE_SESSION, params: { nodeId: 'mini' } },
  ]);
  assert.match(location.hash, /^#terminal\?worker=/);
  assert.deepEqual(
    JSON.parse(new URLSearchParams(location.hash.split('?')[1]).get('worker')!),
    worker,
  );
});
test('unavailable or globally filtered URL targets stay selected, explain why, and never create elsewhere', async () => {
  calls.length = 0;
  const view = new TerminalLaunchView();
  view.selection = 'view=new&transport=tmux&executionNodeId=offline-node';
  await Reflect.get(view, 'createTerminal').call(view);
  assert.match(litText(Reflect.get(view, 'render').call(view)), /not connected/);
  assert.equal(Reflect.get(view, 'machine'), 'offline-node');
  view.selection = 'view=new&transport=tmux&executionNodeId=mini';
  filters.machines = ['macpro'];
  await Reflect.get(view, 'createTerminal').call(view);
  assert.match(litText(Reflect.get(view, 'render').call(view)), /outside the Machines filter/);
  assert.equal(Reflect.get(view, 'machine'), 'mini');
  assert.equal(calls.length, 0);
  filters.machines = [];
});

test('switching launch type retains the machine selected by the nested native launcher in the live URL', () => {
  const view = new TerminalLaunchView();
  view.selection = 'view=new&transport=native&executionNodeId=mini';
  location.hash =
    '#terminal?view=new&transport=native&executionNodeId=macpro&cwd=%2FUsers%2Fmacpro%2Fwork&custom=true';
  Reflect.get(view, 'navigate').call(view, 'tmux');
  let params = new URLSearchParams(location.hash.split('?')[1]);
  assert.equal(params.get('executionNodeId'), 'macpro');
  assert.equal(params.get('cwd'), '/Users/macpro/work');
  Reflect.get(view, 'navigate').call(view, 'tmux', 'mini');
  params = new URLSearchParams(location.hash.split('?')[1]);
  assert.equal(params.get('executionNodeId'), 'mini');
  assert.equal(params.has('cwd'), false);
  assert.equal(params.has('custom'), false);
});
