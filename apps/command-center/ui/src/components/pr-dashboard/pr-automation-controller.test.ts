import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { ReactiveControllerHost } from 'lit';

import type { ResourceQuery, ResourceQueryState } from '@farmslot/protocol/client-cache';

const requests: string[] = [];
let epoch = 1;
let owner = 'first';
let complete: ((value: object) => void) | undefined;
const connectionListeners = new Set<() => void>();
const gateway = {
  connectionState: 'connected',
  get connectionEpoch() {
    return epoch;
  },
  onConnectionChange: (listener: () => void) => {
    connectionListeners.add(listener);
    return () => {
      connectionListeners.delete(listener);
    };
  },
  request(method: string) {
    requests.push(method);
    if (method === 'config.githubAccounts') return Promise.resolve({ accounts: [] });
    return new Promise((resolve) => {
      complete = resolve;
    });
  },
};
class Observation {
  static all: Observation[] = [];
  ready = true;
  retries = 0;
  state: ResourceQueryState<unknown> = { status: 'loading' };
  query?: ResourceQuery<unknown>;
  constructor(
    _host: ReactiveControllerHost,
    private readonly changed?: (state: ResourceQueryState<unknown>) => void,
  ) {
    Observation.all.push(this);
  }
  setQuery(query: ResourceQuery<unknown>) {
    this.query = query;
  }
  requireReady() {
    if (!this.ready) throw new Error('Current read required');
  }
  async retry() {
    this.retries++;
    return this.state;
  }
  publish(state: ResourceQueryState<unknown>) {
    this.state = state;
    this.changed?.(state);
  }
}
mock.module('../../gateway-client.js', { namedExports: { gateway } });
mock.module('../../state.js', {
  namedExports: { getState: () => ({ fleet: { slots: [] } }), subscribe: () => () => {} },
});
mock.module('../../resource-cache.js', { namedExports: { getResourceWorkspaceKey: () => owner } });
mock.module('../shared/resource-query-controller.js', {
  namedExports: { ResourceQueryController: Observation },
});
const { PRAutomationController } = await import('./pr-automation-controller.js');
const host: ReactiveControllerHost = {
  addController() {},
  removeController() {},
  requestUpdate() {},
  updateComplete: Promise.resolve(true),
};

test('PR consumers observe canonical reads; stale actions and previous-owner command replies are refused', async () => {
  const controller = new PRAutomationController(host);
  controller.hostConnected();
  const queries = Observation.all;
  const watches = queries.find((value) => value.query?.method === 'prWatch.list');
  const rules = queries.find((value) => value.query?.method === 'prRules.list');
  const push = queries.find((value) => value.query?.method === 'prPush.list');
  assert(watches && rules && push);
  assert(
    !requests.some((method) => ['prWatch.list', 'prRules.list', 'prPush.list'].includes(method)),
  );
  watches.publish({ status: 'ready', data: { monitors: [] } });
  rules.publish({ status: 'ready', data: { teams: [], rules: [], intents: [] } });
  push.publish({ status: 'ready', data: { attention: [], devices: [], deliveries: [] } });
  watches.ready = false;
  assert.equal(controller.connected, false);
  assert.equal(await controller.mutate('prWatch.lifecycle', {}), undefined);
  assert(!requests.includes('prWatch.lifecycle'));
  watches.ready = true;
  const pending = controller.mutate('prWatch.lifecycle', {});
  assert(requests.includes('prWatch.lifecycle'));
  owner = 'replacement';
  epoch++;
  assert(complete);
  complete({ changed: true });
  assert.equal(await pending, undefined);
  assert.equal(controller.actionError, '');
  controller.hostDisconnected();
});

test('configuration Retry targets only failed reads on a live transport', async () => {
  const controller = new PRAutomationController(host);
  const observations = Observation.all.slice(-5);
  controller.hostConnected();
  const watches = observations.find((value) => value.query?.method === 'prWatch.list');
  const rules = observations.find((value) => value.query?.method === 'prRules.list');
  const push = observations.find((value) => value.query?.method === 'prPush.list');
  assert(watches && rules && push);
  watches.publish({ status: 'ready', data: { monitors: [] } });
  rules.publish({ status: 'ready', data: { teams: [], rules: [], intents: [] } });
  push.publish({ status: 'ready', data: { attention: [], devices: [], deliveries: [] } });
  await controller.retryReadErrors();
  assert.equal(rules.retries, 0, 'Healthy configuration does not need an explicit reread');
  rules.publish({ status: 'error', error: { code: 'SOURCE_UNAVAILABLE', message: 'Read failed' } });
  await controller.retryReadErrors();
  assert.equal(rules.retries, 1);
  assert.equal(watches.retries, 0);
  assert.equal(push.retries, 0);
  gateway.connectionState = 'disconnected';
  assert.equal(controller.canRetryRead, false);
  await controller.retryReadErrors();
  assert.equal(rules.retries, 1, 'Disconnected Retry never queues a read');
  gateway.connectionState = 'connected';
  controller.hostDisconnected();
});

test('transport loss preserves observed PR data, while an observer owner reset removes it', () => {
  const controller = new PRAutomationController(host);
  const observations = Observation.all.slice(-5);
  controller.hostConnected();
  const watches = observations.find((value) => value.query?.method === 'prWatch.list');
  assert(watches);
  watches.publish({ status: 'stale', data: { monitors: [{ id: 'saved-monitor' }] } });
  gateway.connectionState = 'disconnected';
  for (const listener of connectionListeners) listener();
  assert.equal(controller.monitors.monitors[0]?.id, 'saved-monitor');
  assert.equal(controller.connected, false);
  watches.publish({ status: 'loading' });
  assert.deepEqual(controller.monitors, { monitors: [] });
  controller.hostDisconnected();
  gateway.connectionState = 'connected';
});
