import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GATEWAY_COMMAND_METHODS,
  GATEWAY_READ_EXCEPTIONS,
  RESOURCE_QUERY_DEFINITIONS,
  resourceDependenciesForRead,
  resourceQuery,
  type ResourceQueryDefinition,
} from '../../src/client-cache/index.js';

test('every registered read is persisted and bounded (ADR-071 Amendment 2)', () => {
  for (const [method, registered] of Object.entries(RESOURCE_QUERY_DEFINITIONS)) {
    const definition: ResourceQueryDefinition = registered;
    assert.equal(definition.persisted, true, method);
    assert(definition.retention, `${method} needs a retention bound`);
  }
});

test('commands, exceptions and registered reads never overlap', () => {
  const exceptions = Object.values(GATEWAY_READ_EXCEPTIONS).flat();
  for (const method of [...GATEWAY_COMMAND_METHODS, ...exceptions])
    assert(!Object.hasOwn(RESOURCE_QUERY_DEFINITIONS, method), method);
  const commands = new Set<string>(GATEWAY_COMMAND_METHODS);
  for (const method of exceptions) assert(!commands.has(method), method);
});

test('reads screens used to send directly are cached with stable identities', () => {
  const cases: [string, unknown][] = [
    ['runtime.posture.status', { runId: 'run-1' }],
    ['resource.list', { slotId: 'slot-1' }],
    ['resource.pressure.snapshot', { machines: ['b', 'a'], project: 'p' }],
    ['resource.pressure.history', { machine: 'a' }],
    ['resource.device.inventory', { slotId: 'slot-1', refresh: false }],
    ['slot.action.list', { slotId: 'slot-1', placement: 'toolbar' }],
    ['git.files', { slotId: 'slot-1' }],
    ['backlog.spec.get', { itemId: 'item-1' }],
    ['backlog.refinementSession.get', { itemId: 'item-1' }],
    ['roadmap.refinementSession.get', { itemId: 'item-1' }],
    ['chat.history', { sessionId: 'session-1', limit: 50 }],
    ['chat.sessions', {}],
    ['chat.listActions', { sessionId: 'session-1' }],
    ['intelligence.actions.summary', { limit: 20 }],
    ['eval.suite.cap.get', { capGroupId: 'group-1' }],
    ['eval.trial.result.get', { runId: 'run-1' }],
    ['finetune.index', { project: 'p' }],
    ['machine.pause.status', { machine: 'node-a' }],
    ['dispatch.pressureAdmission.get', {}],
    ['native.session.turn.diff', { sessionId: 's', sequence: 3, path: 'src/a.ts' }],
  ];
  for (const [method, params] of cases) {
    const query = resourceQuery(method as keyof typeof RESOURCE_QUERY_DEFINITIONS, params);
    assert.equal(query.persisted, true, method);
    assert.deepEqual(
      resourceDependenciesForRead(method, query.params),
      query.live ? query.dependencies : undefined,
      method,
    );
  }
  assert.equal(
    resourceQuery('resource.pressure.snapshot', { machines: ['b', 'a'] }).id,
    resourceQuery('resource.pressure.snapshot', { machine: 'a', machines: ['b'] }).id,
  );
  assert.equal(
    resourceQuery('chat.history', {}).id,
    resourceQuery('chat.history', { sessionId: 'default' }).id,
  );
  assert.equal(
    resourceQuery('resource.device.inventory', { slotId: 's', refresh: false }).id,
    resourceQuery('resource.device.inventory', { slotId: 's' }).id,
  );
});

test('imperative variants and unsafe selectors stay outside the cache', () => {
  for (const [method, params] of [
    ['resource.device.inventory', { slotId: 's', refresh: true }],
    ['gateway.status', { refresh: true }],
    ['provider.accounts.snapshot', { machines: ['mini'], forceRefresh: true }],
    ['pr.status', { pr: 1, project: 'farm', force: true }],
    ['native.session.turn.diff', { sessionId: 's', sequence: 1, path: '/etc/passwd' }],
    ['native.session.turn.diff', { sessionId: 's', sequence: 1, path: 'a/../../b' }],
    ['backlog.spec.get', { itemId: 'a/b' }],
    ['resource.list', { slotId: 's', force: true }],
  ] as const)
    assert.throws(() => resourceQuery(method, params), method);
});

test('slotless review source is persisted as a frozen snapshot without workspace admission', () => {
  const params = { runId: 'review', base: 'a'.repeat(40), head: 'b'.repeat(40) };
  const query = resourceQuery('git.diff', params);
  assert.equal(query.live, false);
  assert.equal(query.persisted, true);
  assert.equal(query.requiresWorkspaceRead, undefined);
  assert.equal(query.requiresObservedRead, undefined);
  assert.deepEqual(query.dependencies, []);
  assert.equal(query.id, resourceQuery('git.diff', { ...params, slotId: '' }).id);
  assert.equal(resourceDependenciesForRead('git.diff', query.params), undefined);
  assert.throws(() => resourceQuery('git.diff', { runId: 'review' }), /requires base/);
  assert.throws(
    () => resourceQuery('git.show', { runId: 'review', ref: params.head, path: '../outside' }),
    /relative/,
  );
});
