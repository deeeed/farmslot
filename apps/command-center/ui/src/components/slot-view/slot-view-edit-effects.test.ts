import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock, test } from 'node:test';

import {
  createDraftStore,
  createMemoryDraftStorage,
  type Draft,
  type DraftStore,
} from '@farmslot/local-store/drafts';
import type { SlotStatus } from '@farmslot/protocol';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

type Write = { method: string; params: Record<string, unknown> };
const writes: Write[] = [];
let reply: (write: Write) => Promise<unknown> = async () => ({ ok: true });
const gateway = {
  connectionState: 'connected',
  resourceConnectionId: 1,
  authenticatedConnection: { capabilities: { conditionalFileWrites: true } },
  request: async (method: string, params: Record<string, unknown>) => {
    const write = { method, params };
    writes.push(write);
    return reply(write);
  },
};
mock.module('../../gateway-client.js', { namedExports: { gateway } });

let scopeId = 'scope-a';
let currentFile: { content: string; hash: string } | undefined;
mock.module('../../resource-cache.js', {
  namedExports: {
    getEditorDraftScopeId: () => scopeId,
    getResourceNativeOwnerId: () => undefined,
    getResourceCache: () => ({
      retry: async () => ({ status: 'ready', data: currentFile }),
      read: () => ({ status: 'error', error: { code: 'AUTH_FORBIDDEN', message: 'refused' } }),
    }),
  },
});

let fleetCurrent = true;
let fleetSlots: SlotStatus[] = [];
mock.module('../../state.js', {
  namedExports: {
    getState: () => ({
      fleetObservation: { status: fleetCurrent ? 'ready' : 'stale' },
      fleet: { slots: fleetSlots },
    }),
    isFleetCurrent: () => fleetCurrent,
  },
});

const effects = await import('./slot-view-edit-effects.js');
type View = Parameters<typeof effects.refreshSlotViewDrafts>[0];

const base = 'export const value = 1;\n';
const day = 24 * 60 * 60 * 1000;
let now = Date.parse('2026-10-27T00:00:00Z');

function slot(fields: Partial<SlotStatus> = {}): SlotStatus {
  return {
    slot: 'slot-a',
    machine: 'mac',
    health: { ssh: 'LOCAL' },
    lifecycle: 'ready',
    phase: 'idle',
    currentRunId: 'run-2',
    ...fields,
  } as SlotStatus;
}

function makeView(store: DraftStore, fields: Record<string, unknown> = {}): View {
  return {
    slotId: 'slot-a',
    _slot: slot(),
    _isLive: true,
    _activeFile: 'src/value.ts',
    _linkedRun: null,
    _conditionalWritesRefused: false,
    _nodesQuery: { state: { data: { nodes: [] } } },
    _workspaceReads: { ready: true },
    _liveFileContents: new Map([['src/value.ts', base]]),
    _liveFileHashes: new Map([['src/value.ts', sha256(base)]]),
    _fileDrafts: new Map(),
    _slotDrafts: [],
    _draftStore: store,
    _autosaveArmed: new Map(),
    _userSaves: new Map(),
    _editNotice: '',
    _saveRefused: '',
    _fileChangedNotice: '',
    _editorRevision: 0,
    _draftRefresh: 0,
    _saveFeedback: '',
    ...fields,
  } as unknown as View;
}

function reset(t: import('node:test').TestContext) {
  writes.length = 0;
  reply = async () => ({ ok: true });
  scopeId = 'scope-a';
  fleetCurrent = true;
  fleetSlots = [slot()];
  currentFile = undefined;
  now = Date.parse('2026-10-27T00:00:00Z');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return createDraftStore(createMemoryDraftStorage(), () => now);
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function draftFor(fields: Partial<Draft> = {}) {
  return {
    scopeId: 'scope-a',
    slotId: 'slot-a',
    runId: 'run-2',
    path: 'src/value.ts',
    baseContent: base,
    baseHash: sha256(base),
    editedContent: 'export const value = 2;\n',
    state: 'current' as const,
    ...fields,
  };
}

test("a draft for a run that is no longer the slot's is listed read-only, to copy or discard", async (t) => {
  const store = reset(t);
  await store.put(draftFor({ runId: 'run-1' }));
  const view = makeView(store);
  await effects.refreshSlotViewDrafts(view);
  assert.deepEqual(
    view._slotDrafts.map(({ runId, state }) => [runId, state]),
    [['run-1', 'stale-run']],
  );
  assert.equal(view._fileDrafts.size, 0, 'the editor does not open it as current text');

  const copied: string[] = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text: string) => copied.push(text) } },
  });
  await effects.copySlotViewDraft(view._slotDrafts[0]);
  assert.deepEqual(copied, ['export const value = 2;\n']);
  await effects.discardSlotViewDraft(view, view._slotDrafts[0]);
  assert.deepEqual(view._slotDrafts, []);
  assert.deepEqual(await store.list('scope-a'), []);
});

test('drafts for a slot the user can no longer read are hidden, and return with access', async (t) => {
  const store = reset(t);
  await store.put(draftFor());
  const view = makeView(store);
  fleetSlots = [];
  await effects.refreshSlotViewDrafts(view);
  assert.deepEqual(view._slotDrafts, []);
  assert.equal((await store.list('scope-a'))[0].state, 'hidden');

  fleetSlots = [slot()];
  await effects.refreshSlotViewDrafts(view);
  assert.deepEqual(
    view._slotDrafts.map(({ state }) => state),
    ['current'],
  );

  // A refused read of the slot's files hides them too.
  effects.noteSlotViewReadAccess(view, 'src/value.ts', false);
  await flush();
  assert.deepEqual(view._slotDrafts, []);
  effects.noteSlotViewReadAccess(view, 'src/value.ts', true);
  await flush();
  assert.equal(view._slotDrafts.length, 1);
});

test('stale and hidden drafts are deleted 30 days after entering that state', async (t) => {
  const store = reset(t);
  await store.put(draftFor({ runId: 'run-1', path: 'src/stale.ts' }));
  await store.put(draftFor({ slotId: 'slot-gone', path: 'src/hidden.ts' }));
  await store.put(draftFor({ path: 'src/current.ts' }));
  const view = makeView(store);
  await effects.refreshSlotViewDrafts(view);
  now += 30 * day;
  await effects.refreshSlotViewDrafts(view);
  assert.equal((await store.list('scope-a')).length, 3, 'thirty days have not passed yet');
  now += 1;
  await effects.refreshSlotViewDrafts(view);
  assert.deepEqual(
    (await store.list('scope-a')).map(({ path }) => path),
    ['src/current.ts'],
  );
});

test('autosave runs after a pause only on a ready record whose lifecycle is not busy', async (t) => {
  for (const [label, lifecycle, current, expected] of [
    ['ready record', 'ready', true, 1],
    ['busy slot', 'busy', true, 0],
    ['stale record', 'ready', false, 0],
  ] as const) {
    const store = reset(t);
    fleetCurrent = current;
    fleetSlots = [slot({ lifecycle })];
    const view = makeView(store, { _slot: fleetSlots[0] });
    await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 3;\n');
    t.mock.timers.tick(effects.SLOT_VIEW_AUTOSAVE_PAUSE_MS);
    await flush();
    assert.equal(writes.length, expected, label);
    t.mock.timers.reset();
  }
});

test('a restored draft is never saved automatically; its first save is explicit', async (t) => {
  const store = reset(t);
  await store.put(draftFor());
  const view = makeView(store);
  await effects.refreshSlotViewDrafts(view);
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 4;\n');
  t.mock.timers.tick(effects.SLOT_VIEW_AUTOSAVE_PAUSE_MS);
  await flush();
  assert.equal(writes.length, 0);
  assert.equal(await effects.saveSlotViewDraft(view, 'src/value.ts'), true);
  assert.deepEqual(writes[0].params, {
    slotId: 'slot-a',
    path: 'src/value.ts',
    content: 'export const value = 4;\n',
    expectedHash: sha256(base),
    runId: 'run-2',
  });
});

test('a refused save keeps the draft and shows both versions; the user keeps either', async (t) => {
  const store = reset(t);
  const view = makeView(store);
  const theirs = 'export const value = 9;\n';
  currentFile = { content: theirs, hash: sha256(theirs) };
  reply = async (write) => {
    if (write.params.expectedHash === sha256(theirs))
      return { ok: true, hash: sha256(String(write.params.content)) };
    throw Object.assign(new Error('changed'), {
      code: 'FS_CONFLICT',
      details: { reason: 'hash', currentHash: sha256(theirs) },
    });
  };
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 5;\n');
  assert.equal(await effects.saveSlotViewDraft(view, 'src/value.ts'), false);
  assert.deepEqual(view._saveConflict, {
    path: 'src/value.ts',
    mine: 'export const value = 5;\n',
    theirs,
    theirsHash: sha256(theirs),
  });
  assert.equal((await store.list('scope-a'))[0].editedContent, 'export const value = 5;\n');

  await effects.keepMineSlotViewConflict(view);
  assert.equal(writes.at(-1)?.params.expectedHash, sha256(theirs), 'saved over the current file');
  assert.equal(view._saveConflict, undefined);
  assert.deepEqual(await store.list('scope-a'), []);

  // Keeping the current file instead drops the draft and shows that file.
  reply = async () => {
    throw Object.assign(new Error('changed'), { code: 'FS_CONFLICT', details: { reason: 'hash' } });
  };
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 6;\n');
  await effects.saveSlotViewDraft(view, 'src/value.ts');
  await effects.keepTheirsSlotViewConflict(view);
  assert.equal(view._liveFileContents.get('src/value.ts'), theirs);
  assert.equal(view._editorRevision, 1, 'the editor replaces its text with the current file');
  assert.deepEqual(await store.list('scope-a'), []);
});

test('a save refused for another run leaves a read-only draft; an unchecked host goes read-only', async (t) => {
  const store = reset(t);
  const view = makeView(store);
  reply = async () => {
    throw Object.assign(new Error('moved'), {
      code: 'FS_CONFLICT',
      details: { reason: 'run', currentRunId: 'run-3' },
    });
  };
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 7;\n');
  await effects.saveSlotViewDraft(view, 'src/value.ts');
  assert.equal((await store.list('scope-a'))[0].state, 'stale-run');
  assert.match(view._editNotice, /another run/);

  reply = async () => {
    throw Object.assign(new Error('old node'), { code: 'FS_PRECONDITION_UNSUPPORTED' });
  };
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 8;\n');
  await effects.saveSlotViewDraft(view, 'src/value.ts');
  assert.equal(view._conditionalWritesRefused, true);
  assert.equal(effects.slotViewEditable(view, 'src/value.ts'), false);
});

test("a worker's write over the user's save shows a notice and keeps the user's version", async (t) => {
  const store = reset(t);
  const view = makeView(store);
  const mine = 'export const value = 10;\n';
  reply = async () => ({ ok: true, hash: sha256(mine) });
  await effects.editSlotViewFile(view, 'src/value.ts', mine);
  assert.equal(await effects.saveSlotViewDraft(view, 'src/value.ts'), true);

  // The workspace read reports the user's own save first: nothing to say.
  await effects.noteSlotViewFileRead(view, 'src/value.ts', mine, sha256(mine));
  assert.equal(view._fileChangedNotice, '');
  const worker = 'export const value = 11; // worker\n';
  await effects.noteSlotViewFileRead(view, 'src/value.ts', worker, sha256(worker));
  assert.equal(view._fileChangedNotice, 'src/value.ts');
  const [kept] = await store.list('scope-a');
  assert.deepEqual(
    { base: kept.baseContent, baseHash: kept.baseHash, edited: kept.editedContent },
    { base: worker, baseHash: sha256(worker), edited: mine },
  );
  assert.equal(
    [...view._autosaveArmed.keys()].some((key) => key.includes('src/value.ts')),
    false,
    'its save is explicit',
  );
});

test('typing while a save is pending stays a draft over the saved text', async (t) => {
  const store = reset(t);
  const view = makeView(store);
  const sent = 'export const value = 20;\n';
  const newer = 'export const value = 21;\n';
  let answer!: (reply: unknown) => void;
  reply = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  await effects.editSlotViewFile(view, 'src/value.ts', sent);
  const saving = effects.saveSlotViewDraft(view, 'src/value.ts');
  await flush();
  await effects.editSlotViewFile(view, 'src/value.ts', newer);
  answer({ ok: true, hash: sha256(sent) });
  assert.equal(await saving, true);
  const [kept] = await store.list('scope-a');
  assert.deepEqual(
    { base: kept.baseContent, baseHash: kept.baseHash, edited: kept.editedContent },
    { base: sent, baseHash: sha256(sent), edited: newer },
  );
  assert.equal(view._fileDrafts.get('src/value.ts')?.editedContent, newer);
  assert.equal(view._liveFileContents.get('src/value.ts'), sent);
  assert.equal(effects.slotViewSaveState(view, 'src/value.ts'), 'draft');
});

test('a save that fails without a refusal keeps the newest draft and its autosave as they were', async (t) => {
  const store = reset(t);
  const view = makeView(store);
  const newer = 'export const value = 23;\n';
  let fail!: (error: Error) => void;
  reply = () =>
    new Promise((_, reject) => {
      fail = reject;
    });
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 22;\n');
  const armed = [...view._autosaveArmed];
  const saving = effects.saveSlotViewDraft(view, 'src/value.ts');
  await flush();
  await effects.editSlotViewFile(view, 'src/value.ts', newer);
  fail(new Error('Gateway request timed out'));
  assert.equal(await saving, false);
  const [kept] = await store.list('scope-a');
  assert.deepEqual(
    { base: kept.baseContent, edited: kept.editedContent, state: kept.state },
    { base, edited: newer, state: 'current' },
  );
  assert.deepEqual([...view._autosaveArmed], armed);
  assert.equal(effects.slotViewSaveState(view, 'src/value.ts'), 'refused');
});

test("a restored draft on another slot never inherits the first slot's autosave", async (t) => {
  const store = reset(t);
  const slotB = slot({ slot: 'slot-b', currentRunId: 'run-b' });
  fleetSlots = [slot(), slotB];
  const view = makeView(store);
  // Typing in slot A arms its own draft.
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 30;\n');
  // The same view moves to slot B, which holds a restored draft at the same path.
  await store.put(draftFor({ slotId: 'slot-b', runId: 'run-b' }));
  Object.assign(view, { slotId: 'slot-b', _slot: slotB });
  await effects.refreshSlotViewDrafts(view);
  assert.equal(view._fileDrafts.get('src/value.ts')?.slotId, 'slot-b');
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 31;\n');
  t.mock.timers.tick(effects.SLOT_VIEW_AUTOSAVE_PAUSE_MS);
  await flush();
  assert.equal(writes.length, 0, "slot B's restored draft waits for an explicit save");
  assert.equal(await effects.saveSlotViewDraft(view, 'src/value.ts'), true);
  assert.equal(writes[0].params.slotId, 'slot-b');

  // Back on slot A, its earlier permission is gone too.
  Object.assign(view, { slotId: 'slot-a', _slot: fleetSlots[0] });
  await effects.refreshSlotViewDrafts(view);
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 32;\n');
  t.mock.timers.tick(effects.SLOT_VIEW_AUTOSAVE_PAUSE_MS);
  await flush();
  assert.equal(writes.length, 1);
});
