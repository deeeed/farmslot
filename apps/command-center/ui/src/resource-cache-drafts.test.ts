import assert from 'node:assert/strict';
import test from 'node:test';

import { installFakeGateway } from './testing/fake-gateway.js';

test("a principal change names the previous account's unsaved drafts, then deletes them", async (t) => {
  const fakeGateway = installFakeGateway(t, 'operator-a');
  fakeGateway.resourceEpoch = 'drafts-epoch';
  fakeGateway.responseForRequest = () => undefined;

  const { gateway } = await import('./gateway-client.js');
  const {
    dismissDeletedDraftNotice,
    disposeResourceCache,
    getDeletedDraftCount,
    getEditorDrafts,
    getEditorDraftScopeId,
    initializeResourceCache,
  } = await import('./resource-cache.js');
  const { resourceStoreScopeId } = await import('@farmslot/protocol/client-cache');
  fakeGateway.beforeRestore = async () => {
    gateway.disconnect();
    await disposeResourceCache();
  };
  const flush = async () => {
    for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };

  initializeResourceCache();
  await gateway.setAuthCredentials({ token: 'operator-a-secret' });
  // Another tab, signed in as another principal of this gateway profile, left drafts behind.
  const drafts = await getEditorDrafts();
  const otherTab = resourceStoreScopeId({
    gatewayUrl: gateway.gatewayUrl,
    principalId: 'operator-x',
    principalGeneration: 0,
  });
  const otherGateway = resourceStoreScopeId({
    gatewayUrl: 'ws://elsewhere.test/ws',
    principalId: 'operator-x',
    principalGeneration: 0,
  });
  const seeded = {
    slotId: 'slot-x',
    runId: null,
    path: 'src/x.ts',
    baseContent: 'x',
    baseHash: null,
    editedContent: 'edited',
    state: 'current' as const,
  };
  await drafts.put({ ...seeded, scopeId: otherTab });
  await drafts.put({ ...seeded, scopeId: otherGateway });
  gateway.connect();
  await flush();
  assert.equal(getDeletedDraftCount(), 1, "the first connect deletes the other principal's drafts");
  assert.deepEqual(await drafts.list(otherTab), []);
  assert.equal((await drafts.list(otherGateway)).length, 1, 'another gateway keeps its drafts');
  dismissDeletedDraftNotice();

  const previous = getEditorDraftScopeId();
  assert.ok(previous);
  const draft = {
    scopeId: previous,
    slotId: 'slot-a',
    runId: null,
    path: 'src/a.ts',
    baseContent: 'a',
    baseHash: null,
    state: 'current' as const,
  };
  await drafts.put({ ...draft, editedContent: 'edited' });
  await drafts.put({ ...draft, path: 'src/b.ts', editedContent: 'edited' });
  // A draft equal to its base holds nothing unsaved.
  await drafts.put({ ...draft, path: 'src/c.ts', editedContent: 'a' });

  // A reconnect as the same principal keeps them.
  gateway.reconnect();
  await flush();
  assert.equal(getEditorDraftScopeId(), previous);
  assert.equal((await drafts.list(previous)).length, 3);
  assert.equal(getDeletedDraftCount(), 0);

  fakeGateway.principalId = 'operator-b';
  gateway.reconnect();
  await flush();
  assert.equal(gateway.authenticatedPrincipalId, 'operator-b');
  assert.notEqual(getEditorDraftScopeId(), previous);
  assert.equal(getDeletedDraftCount(), 2, 'only drafts that differ from their base count');
  assert.deepEqual(await drafts.list(previous), []);
  dismissDeletedDraftNotice();
  assert.equal(getDeletedDraftCount(), 0);

  // Back to the first principal in the same document: B's drafts go the same way.
  const second = getEditorDraftScopeId()!;
  await drafts.put({ ...draft, scopeId: second, editedContent: 'edited by b' });
  fakeGateway.principalId = 'operator-a';
  gateway.reconnect();
  await flush();
  assert.equal(getEditorDraftScopeId(), previous);
  assert.equal(getDeletedDraftCount(), 1, 'the return to A counts what B left unsaved');
  assert.deepEqual(await drafts.list(second), []);
  dismissDeletedDraftNotice();
  // A reconnect as the same principal checks nothing again.
  await drafts.put({ ...draft, scopeId: second, editedContent: 'edited by b again' });
  gateway.reconnect();
  await flush();
  assert.equal(getDeletedDraftCount(), 0);
  assert.equal((await drafts.list(second)).length, 1);

  // Work queued for the scope this document leaves never lands after the change, even when that
  // scope held no drafts to list.
  const { draftScopeWriter } = await import('./draft-scopes.js');
  assert.deepEqual(await drafts.list(previous), []);
  const queued = draftScopeWriter(previous);
  fakeGateway.principalId = 'operator-c';
  gateway.reconnect();
  await flush();
  assert.equal(
    await queued.write(() => drafts.put({ ...draft, editedContent: 'queued before the change' })),
    undefined,
  );
  assert.deepEqual(await drafts.list(previous), []);
});
