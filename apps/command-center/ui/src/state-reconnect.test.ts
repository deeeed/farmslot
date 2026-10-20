import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { installFakeGateway } from './testing/fake-gateway.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    parentRunId: null,
    lane: 'production',
    flowType: 'fix-bug',
    status: 'monitoring',
    project: 'farm',
    ticketOrPr: 'owner/repo#1',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: 'gpt-5.5', runner: 'codex' },
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  } as Run;
}

test('the workspace survives a gateway restart and clears only for another account', async (t) => {
  const fakeGateway = installFakeGateway(t, 'operator-a');

  const { gateway } = await import('./gateway-client.js');
  const { getState, initState, isHydrating, onWorkspaceOwnerChange, updateRuns } =
    await import('./state.js');
  t.after(() => gateway.disconnect());
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  };

  initState();
  await gateway.setAuthCredentials({ token: 'operator-a-secret' });
  gateway.connect();
  await flush();
  assert.equal(gateway.connectionState, 'connected');
  updateRuns([makeRun()]);
  assert.equal(getState().runs.length, 1);
  let ownerChanges = 0;

  await t.test('a reconnect with the same principal keeps runs', async () => {
    // A gateway restart or network blip keeps the runs on screen, marked as stale.
    fakeGateway.holdAuth = true;
    fakeGateway.restart();
    await flush();
    assert.notEqual(gateway.connectionState, 'connected');
    assert.deepEqual(
      getState().runs.map((run) => run.id),
      ['run-1'],
    );
    assert.equal(getState().workspaceAccess, 'farm');
    assert.equal(isHydrating(getState(), 'runs'), true);
    t.after(onWorkspaceOwnerChange(() => (ownerChanges += 1)));

    // Reconnecting as the same principal keeps them until the bootstrap replaces them.
    fakeGateway.holdAuth = false;
    gateway.reconnect();
    await flush();
    assert.equal(gateway.connectionState, 'connected');
    assert.equal(gateway.authenticatedPrincipalId, 'operator-a');
    assert.deepEqual(
      getState().runs.map((run) => run.id),
      ['run-1'],
    );
    // The views stay mounted: nothing tears them down for the same account.
    assert.equal(ownerChanges, 0);
  });

  await t.test('a reconnect as a different principal clears', async () => {
    // Reconnecting as a different principal clears the previous account's workspace.
    fakeGateway.principalId = 'operator-b';
    fakeGateway.restart();
    gateway.reconnect();
    await flush();
    assert.equal(gateway.connectionState, 'connected');
    assert.equal(gateway.authenticatedPrincipalId, 'operator-b');
    assert.deepEqual(getState().runs, []);
    assert.equal(ownerChanges, 1);
  });

  await t.test('a credential change on this client clears at once', async () => {
    // Changing credentials on this client clears at once, before any reconnect.
    updateRuns([makeRun({ id: 'run-2' })]);
    await gateway.setAuthCredentials({ token: 'operator-c-secret' });
    assert.deepEqual(getState().runs, []);
    assert.equal(getState().workspaceAccess, 'none');
    assert.equal(ownerChanges, 2);
  });

  await t.test('sign-out clears', async () => {
    gateway.connect();
    await flush();
    assert.equal(gateway.connectionState, 'connected');
    updateRuns([makeRun({ id: 'run-3' })]);
    await gateway.signOut();
    assert.equal(gateway.connectionState, 'auth_required');
    assert.deepEqual(getState().runs, []);
    assert.equal(getState().workspaceAccess, 'none');
    assert.equal(ownerChanges, 4);
  });
});
