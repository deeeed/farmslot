import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

import type { AnalyticsQueryResult } from '@farmslot/protocol';
import type { ResourceQuery, ResourceQueryState } from '@farmslot/protocol/client-cache';

const emptyDuration = { n: 0, p50: null, p90: null, max: null };
const result: AnalyticsQueryResult = {
  generatedAt: '2026-10-24T00:00:00.000Z',
  matchedRuns: 0,
  scannedRuns: 0,
  parseFailures: 0,
  byStatus: {},
  byModel: {},
  tokensByModel: {},
  tokens: emptyDuration,
  byRunner: {},
  byTemplate: {},
  bottleneck: [],
  wall: emptyDuration,
  idle: emptyDuration,
  failureByStep: {},
  failureByReason: {},
  reviewLoops: { distribution: {}, p50: null, p90: null, max: null },
  ci: { resultBreakdown: {}, pollCount: emptyDuration, inlineFixAttempts: emptyDuration },
  nudges: { avg: 0, zeroRate: 0, byModel: {} },
  dimensions: { projects: [], hosts: [], flowTypes: [], runners: [], models: [] },
};

let owner = 'first-owner';
let connection = 1;
const commands: string[] = [];
let resolveCommand:
  | ((result: { scanned: number; written: number; skipped: number }) => void)
  | undefined;
const gateway = {
  get resourceConnectionId() {
    return connection;
  },
  request(method: string) {
    commands.push(method);
    return new Promise((resolve) => {
      resolveCommand = resolve;
    });
  },
};
class QueryController {
  static latest?: QueryController;
  belongsToWorkspace = true;
  ready = true;
  state: ResourceQueryState<AnalyticsQueryResult> = { status: 'ready', data: result };
  selected?: ResourceQuery<AnalyticsQueryResult>;
  retries = 0;
  constructor(
    _host: object,
    private readonly onChange: (state: ResourceQueryState<AnalyticsQueryResult>) => void,
  ) {
    QueryController.latest = this;
  }
  setQuery(query?: ResourceQuery<AnalyticsQueryResult>) {
    this.selected = query;
  }
  async retry() {
    this.retries++;
    return this.state;
  }
  requireReady() {
    if (
      !this.ready ||
      !this.belongsToWorkspace ||
      this.state.status !== 'ready' ||
      !this.state.data
    )
      throw new Error('Wait for a current read before acting.');
    return this.state.data;
  }
  publish(state: ResourceQueryState<AnalyticsQueryResult>) {
    this.state = state;
    this.onChange(state);
  }
}
mock.module('../../gateway-client.js', { namedExports: { gateway } });
mock.module('../../resource-cache.js', { namedExports: { getResourceWorkspaceKey: () => owner } });
mock.module('../shared/resource-query-controller.js', {
  namedExports: { ResourceQueryController: QueryController },
});
const { AnalyticsPanel } = await import('./analytics-panel.js');

function controller(): QueryController {
  const current = QueryController.latest;
  assert(current);
  return current;
}
function invoke(panel: InstanceType<typeof AnalyticsPanel>, method: string, ...args: unknown[]) {
  const handler: unknown = Reflect.get(panel, method);
  assert.equal(typeof handler, 'function');
  if (typeof handler !== 'function') throw new Error(`Missing panel handler ${method}`);
  return handler.apply(panel, args);
}
afterEach(() => {
  commands.length = 0;
  resolveCommand = undefined;
  owner = 'first-owner';
  connection = 1;
});

test('analytics filter selections do not retry an unchanged healthy query', async () => {
  const panel = new AnalyticsPanel();
  await panel.load();
  const query = controller();
  assert.equal(query.selected?.method, 'analytics.query');
  assert.equal(query.retries, 0);
  await panel.load();
  assert.equal(query.retries, 0, 'The shared observer owns updates to the selected query');
  invoke(panel, 'toggleFilter', 'project', 'alpha');
  assert.deepEqual(query.selected?.params, { project: 'alpha' });
  assert.deepEqual(commands, [], 'Read/filter paths never issue commands or direct RPC reads');
});

test('updating a relative time window advances its bound without retrying the old query', async (t) => {
  let now = Date.parse('2026-10-25T01:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  const panel = new AnalyticsPanel();
  invoke(panel, 'setWindow', '24h');
  const query = controller();
  assert.deepEqual(query.selected?.params, { since: '2026-10-24T01:00:00.000Z' });
  const firstId = query.selected?.id;
  now += 60_000;
  await panel.load();
  assert.deepEqual(query.selected?.params, { since: '2026-10-24T01:01:00.000Z' });
  assert.notEqual(query.selected?.id, firstId);
  assert.equal(query.retries, 0);
  invoke(panel, 'setWindow', '');
  assert.deepEqual(query.selected?.params, {});
  assert.deepEqual(commands, []);
});

test('stale analytics refuses the backfill command at invocation time', async () => {
  const panel = new AnalyticsPanel();
  await panel.load();
  controller().ready = false;
  controller().publish({ status: 'stale', data: result, observedAt: Date.now() - 5000 });
  assert.equal(
    Reflect.get(panel, 'result'),
    result,
    'Stale data remains visible within its authority',
  );
  assert.match(String(Reflect.get(panel, 'staleNotice')), /Previous analytics, \d+s old/);
  await invoke(panel, 'runBackfill');
  assert.deepEqual(commands, []);
  assert.match(String(Reflect.get(panel, 'commandError')), /current read/);
});

test('backfill stays a live command and a late previous-owner reply cannot publish a notice', async () => {
  const panel = new AnalyticsPanel();
  await panel.load();
  const pending = invoke(panel, 'runBackfill');
  assert.deepEqual(commands, ['analytics.backfill']);
  owner = 'second-owner';
  connection++;
  controller().belongsToWorkspace = false;
  controller().publish({ status: 'loading' });
  assert.equal(Reflect.get(panel, 'result'), null);
  assert(resolveCommand);
  resolveCommand({ scanned: 3, written: 2, skipped: 1 });
  await pending;
  assert.equal(Reflect.get(panel, 'notice'), '');
  assert.equal(
    controller().retries,
    0,
    'The owning append, not the command callback, refreshes readers',
  );
});
