import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock, test } from 'node:test';

import {
  createDraftStore,
  createMemoryDraftStorage,
  type Draft,
  type DraftStorage,
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
let retryRead: () => Promise<unknown> = async () => ({ status: 'ready', data: currentFile });
mock.module('../../resource-cache.js', {
  namedExports: {
    getEditorDraftScopeId: () => scopeId,
    getResourceNativeOwnerId: () => undefined,
    getResourceCache: () => ({
      retry: () => retryRead(),
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
const commands = await import('./slot-view-file-command-effects.js');
const { retireDraftScope } = await import('../../draft-scopes.js');
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
    _conditionalWritesRefused: new Set(),
    _nodesQuery: { state: { data: { nodes: [] } } },
    _workspaceReads: { ready: true, stateOf: () => ({ status: 'ready' }) },
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
  // Each test runs on its own connection, so a scope retired by an earlier one is open again.
  gateway.resourceConnectionId++;
  writes.length = 0;
  reply = async () => ({ ok: true });
  scopeId = 'scope-a';
  fleetCurrent = true;
  fleetSlots = [slot()];
  currentFile = undefined;
  retryRead = async () => ({ status: 'ready', data: currentFile });
  now = Date.parse('2026-10-27T00:00:00Z');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return createDraftStore(createMemoryDraftStorage(), () => now);
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Memory storage whose writes wait while held, as a slow IndexedDB transaction would. */
function slowStorage() {
  const memory = createMemoryDraftStorage();
  let held: (() => void)[] | undefined;
  let holding: readonly string[] = [];
  const wait = async (op: string) => {
    if (held && holding.includes(op)) await new Promise<void>((resolve) => held?.push(resolve));
  };
  const storage: DraftStorage = {
    get: (id) => memory.get(id),
    put: async (draft) => {
      await wait('put');
      await memory.put(draft);
    },
    delete: async (id) => {
      await wait('delete');
      await memory.delete(id);
    },
    list: (scope) => memory.list(scope),
    close: () => memory.close(),
  };
  return {
    store: createDraftStore(storage, () => now),
    hold: (...ops: Array<'put' | 'delete'>) => {
      held = [];
      holding = ops.length ? ops : ['put', 'delete'];
    },
    release: () => {
      const waiting = held ?? [];
      held = undefined;
      for (const resume of waiting) resume();
    },
  };
}

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
  assert.equal(effects.slotViewReadOnly(view, 'src/value.ts'), 'host');
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
  assert.equal(effects.slotViewFileChangedPath(view), '');
  const worker = 'export const value = 11; // worker\n';
  await effects.noteSlotViewFileRead(view, 'src/value.ts', worker, sha256(worker));
  assert.equal(effects.slotViewFileChangedPath(view), 'src/value.ts');
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

test('undoing back to the base while a save is pending keeps that undo as a draft', async (t) => {
  const store = reset(t);
  const view = makeView(store);
  const sent = 'export const value = 24;\n';
  let answer!: (reply: unknown) => void;
  reply = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  await effects.editSlotViewFile(view, 'src/value.ts', sent);
  const saving = effects.saveSlotViewDraft(view, 'src/value.ts');
  await flush();
  // The user undoes to the text the file had before the save.
  await effects.editSlotViewFile(view, 'src/value.ts', base);
  answer({ ok: true, hash: sha256(sent) });
  assert.equal(await saving, true);
  const [kept] = await store.list('scope-a');
  assert.deepEqual(
    { base: kept.baseContent, baseHash: kept.baseHash, edited: kept.editedContent },
    { base: sent, baseHash: sha256(sent), edited: base },
  );
  assert.equal(view._fileDrafts.get('src/value.ts')?.editedContent, base);
});

test("a late save reply for slot A never touches slot B's draft at the same path", async (t) => {
  const store = reset(t);
  const slotB = slot({ slot: 'slot-b', currentRunId: 'run-b' });
  fleetSlots = [slot(), slotB];
  const view = makeView(store);
  const sent = 'export const value = 40;\n';
  let answer!: (reply: unknown) => void;
  reply = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  await effects.editSlotViewFile(view, 'src/value.ts', sent);
  const saving = effects.saveSlotViewDraft(view, 'src/value.ts');
  await flush();
  // Before A replies, the view moves to slot B and shows B's restored draft at that path.
  const restored = await store.put(
    draftFor({ slotId: 'slot-b', runId: 'run-b', editedContent: 'export const value = 41;\n' }),
  );
  Object.assign(view, { slotId: 'slot-b', _slot: slotB });
  await effects.refreshSlotViewDrafts(view);
  answer({ ok: true, hash: sha256(sent) });
  assert.equal(await saving, true);
  t.mock.timers.tick(effects.SLOT_VIEW_AUTOSAVE_PAUSE_MS);
  await flush();
  assert.deepEqual(
    writes.map(({ params }) => params.slotId),
    ['slot-a'],
    'B is never sent',
  );
  const [stillB] = await store.list('scope-a', 'slot-b');
  assert.deepEqual(
    { base: stillB.baseContent, baseHash: stillB.baseHash, edited: stillB.editedContent },
    { base: restored.baseContent, baseHash: restored.baseHash, edited: restored.editedContent },
  );
  assert.equal(view._fileDrafts.get('src/value.ts')?.slotId, 'slot-b');
  assert.equal(
    [...view._autosaveArmed.keys()].some((key) => key.includes('slot-b')),
    false,
    "B's restored draft stays unarmed",
  );
  assert.equal(view._liveFileContents.get('src/value.ts'), base, "B's view keeps its own file");
  assert.deepEqual(await store.list('scope-a', 'slot-a'), [], "A's reply resolved A's draft");
});

test('an edit queued behind a slow draft write is kept for its slot when the view moves on', async (t) => {
  reset(t);
  const { store, hold, release } = slowStorage();
  const slotB = slot({ slot: 'slot-b', currentRunId: 'run-b' });
  fleetSlots = [slot(), slotB];
  const view = makeView(store);
  hold();
  const first = effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 80;\n');
  await flush();
  const second = effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 81;\n');
  await flush();
  // Both edits were accepted on slot A; the view moves to slot B before they are written.
  Object.assign(view, { slotId: 'slot-b', _slot: slotB });
  release();
  await Promise.all([first, second]);
  t.mock.timers.tick(effects.SLOT_VIEW_AUTOSAVE_PAUSE_MS);
  await flush();
  assert.deepEqual(
    (await store.list('scope-a', 'slot-a')).map(({ editedContent }) => editedContent),
    ['export const value = 81;\n'],
    'A keeps the last edit typed in it',
  );
  assert.equal(view._fileDrafts.size, 0, "B's view shows none of A's drafts");
  assert.equal(writes.length, 0);

  Object.assign(view, { slotId: 'slot-a', _slot: fleetSlots[0] });
  await effects.refreshSlotViewDrafts(view);
  assert.equal(view._fileDrafts.get('src/value.ts')?.editedContent, 'export const value = 81;\n');
});

test('a conflict read back after the view moved to another slot is never shown there', async (t) => {
  const store = reset(t);
  const slotB = slot({ slot: 'slot-b', currentRunId: 'run-b' });
  fleetSlots = [slot(), slotB];
  const view = makeView(store);
  const theirs = 'export const value = 90;\n';
  reply = async () => {
    throw Object.assign(new Error('changed'), {
      code: 'FS_CONFLICT',
      details: { reason: 'hash', currentHash: sha256(theirs) },
    });
  };
  let reread!: () => void;
  retryRead = () =>
    new Promise((resolve) => {
      reread = () => resolve({ status: 'ready', data: { content: theirs, hash: sha256(theirs) } });
    });
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 91;\n');
  const saving = effects.saveSlotViewDraft(view, 'src/value.ts');
  await flush();
  // While A's file is read again, the view moves to slot B and its draft at the same path.
  const restored = await store.put(
    draftFor({ slotId: 'slot-b', runId: 'run-b', editedContent: 'export const value = 92;\n' }),
  );
  Object.assign(view, { slotId: 'slot-b', _slot: slotB });
  await effects.refreshSlotViewDrafts(view);
  reread();
  assert.equal(await saving, false);
  assert.equal(view._saveConflict, undefined);
  assert.equal(effects.slotViewSaveState(view, 'src/value.ts'), 'draft');
  await effects.keepTheirsSlotViewConflict(view);
  assert.equal(view._fileDrafts.get('src/value.ts')?.editedContent, restored.editedContent);
  assert.equal(view._liveFileContents.get('src/value.ts'), base);
  assert.deepEqual(
    (await store.list('scope-a')).map(({ slotId, editedContent }) => [slotId, editedContent]),
    [
      ['slot-a', 'export const value = 91;\n'],
      ['slot-b', restored.editedContent],
    ],
  );
});

test("a draft typed while another file's save is pending autosaves once that save settles", async (t) => {
  for (const outcome of ['saved', 'failed'] as const) {
    const store = reset(t);
    const view = makeView(store, {
      _liveFileContents: new Map([
        ['src/value.ts', base],
        ['src/other.ts', base],
      ]),
      _liveFileHashes: new Map([
        ['src/value.ts', sha256(base)],
        ['src/other.ts', sha256(base)],
      ]),
    });
    let settle!: () => void;
    reply = (write) =>
      write.params.path === 'src/other.ts'
        ? Promise.resolve({ ok: true, hash: sha256(String(write.params.content)) })
        : new Promise((resolve, reject) => {
            settle = () =>
              outcome === 'saved'
                ? resolve({ ok: true, hash: sha256(String(write.params.content)) })
                : reject(new Error('Gateway request timed out'));
          });
    await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 100;\n');
    const saving = effects.saveSlotViewDraft(view, 'src/value.ts');
    await flush();
    view._activeFile = 'src/other.ts';
    await effects.editSlotViewFile(view, 'src/other.ts', 'export const other = 101;\n');
    t.mock.timers.tick(effects.SLOT_VIEW_AUTOSAVE_PAUSE_MS);
    await flush();
    assert.equal(writes.length, 1, `${outcome}: the pause came while a save was in flight`);
    settle();
    await saving;
    t.mock.timers.tick(effects.SLOT_VIEW_AUTOSAVE_PAUSE_MS);
    await flush();
    assert.deepEqual(
      writes.map(({ params }) => params.path),
      ['src/value.ts', 'src/other.ts'],
      outcome,
    );
    t.mock.timers.reset();
  }
});

test("keeping the current file after the view moved on leaves the other slot's draft alone", async (t) => {
  reset(t);
  const { store, hold, release } = slowStorage();
  const slotB = slot({ slot: 'slot-b', currentRunId: 'run-b' });
  fleetSlots = [slot(), slotB];
  const view = makeView(store);
  const theirs = 'export const value = 110;\n';
  currentFile = { content: theirs, hash: sha256(theirs) };
  reply = async () => {
    throw Object.assign(new Error('changed'), { code: 'FS_CONFLICT', details: { reason: 'hash' } });
  };
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 111;\n');
  await effects.saveSlotViewDraft(view, 'src/value.ts');
  assert.equal(view._saveConflict?.path, 'src/value.ts');
  await flush();
  const restored = await store.put(
    draftFor({ slotId: 'slot-b', runId: 'run-b', editedContent: 'export const value = 112;\n' }),
  );
  hold();
  const keeping = effects.keepTheirsSlotViewConflict(view);
  await flush();
  Object.assign(view, {
    slotId: 'slot-b',
    _slot: slotB,
    _fileDrafts: new Map([['src/value.ts', restored]]),
  });
  release();
  await keeping;
  assert.equal(view._fileDrafts.get('src/value.ts')?.editedContent, restored.editedContent);
  assert.equal(view._liveFileContents.get('src/value.ts'), base);
  assert.equal(view._editorRevision, 0, "B's editor keeps its text");
  assert.deepEqual(
    (await store.list('scope-a')).map(({ slotId }) => slotId),
    ['slot-b'],
    "A's draft went as asked",
  );
});

test('keeping my version after the view moved on rebases the draft for later and saves nothing', async (t) => {
  reset(t);
  const { store, hold, release } = slowStorage();
  const slotB = slot({ slot: 'slot-b', currentRunId: 'run-b' });
  fleetSlots = [slot(), slotB];
  const view = makeView(store);
  const theirs = 'export const value = 130;\n';
  const mine = 'export const value = 131;\n';
  currentFile = { content: theirs, hash: sha256(theirs) };
  reply = async (write) => {
    if (write.params.expectedHash === sha256(theirs))
      return { ok: true, hash: sha256(String(write.params.content)) };
    throw Object.assign(new Error('changed'), { code: 'FS_CONFLICT', details: { reason: 'hash' } });
  };
  await effects.editSlotViewFile(view, 'src/value.ts', mine);
  await effects.saveSlotViewDraft(view, 'src/value.ts');
  assert.equal(view._saveConflict?.path, 'src/value.ts');
  await flush();
  hold();
  const keeping = effects.keepMineSlotViewConflict(view);
  await flush();
  Object.assign(view, { slotId: 'slot-b', _slot: slotB, _fileDrafts: new Map() });
  release();
  await keeping;
  assert.equal(writes.length, 1, 'only the refused save was sent');
  assert.equal(view._fileDrafts.size, 0);
  const [kept] = await store.list('scope-a', 'slot-a');
  assert.deepEqual(
    { base: kept.baseContent, baseHash: kept.baseHash, edited: kept.editedContent },
    { base: theirs, baseHash: sha256(theirs), edited: mine },
  );
});

test("a worker's write noticed after the view moved on is kept for its slot, not shown on the other", async (t) => {
  reset(t);
  const { store, hold, release } = slowStorage();
  const slotB = slot({ slot: 'slot-b', currentRunId: 'run-b' });
  fleetSlots = [slot(), slotB];
  const view = makeView(store);
  const mine = 'export const value = 120;\n';
  reply = async () => ({ ok: true, hash: sha256(mine) });
  await effects.editSlotViewFile(view, 'src/value.ts', mine);
  assert.equal(await effects.saveSlotViewDraft(view, 'src/value.ts'), true);
  await flush();
  const worker = 'export const value = 121; // worker\n';
  hold();
  const noting = effects.noteSlotViewFileRead(view, 'src/value.ts', worker, sha256(worker));
  await flush();
  Object.assign(view, { slotId: 'slot-b', _slot: slotB });
  release();
  await noting;
  assert.equal(view._fileChangedNotice, '');
  assert.equal(view._fileDrafts.has('src/value.ts'), false);
  const [kept] = await store.list('scope-a', 'slot-a');
  assert.deepEqual(
    { base: kept.baseContent, edited: kept.editedContent },
    { base: worker, edited: mine },
  );
});

test("a file's own read decides whether it is editable, not the workspace's other reads", async (t) => {
  const store = reset(t);
  const asked: unknown[] = [];
  const view = makeView(store, {
    _liveFileContents: new Map([
      ['src/value.ts', base],
      ['src/other.ts', base],
    ]),
    _liveFileHashes: new Map([
      ['src/value.ts', sha256(base)],
      ['src/other.ts', sha256(base)],
    ]),
    // The tree's read is refreshing, so the workspace as a whole is not ready.
    _workspaceReads: {
      ready: false,
      stateOf: (method: string, params: { path: string }) => {
        asked.push([method, params]);
        return { status: params.path === 'src/value.ts' ? 'ready' : 'loading' };
      },
    },
  });
  assert.equal(effects.slotViewReadOnly(view, 'src/value.ts'), undefined);
  assert.deepEqual(asked[0], ['fs.read', { slotId: 'slot-a', path: 'src/value.ts' }]);
  assert.equal(effects.slotViewReadOnly(view, 'src/other.ts'), 'hash');
});

test('a node that cannot check edits leaves only its own slot read-only', async (t) => {
  const store = reset(t);
  const slotB = slot({
    slot: 'slot-b',
    machine: 'mac-b',
    health: { ssh: 'OK' },
    currentRunId: 'run-b',
  } as Partial<SlotStatus>);
  fleetSlots = [slot(), slotB];
  const nodeB = {
    machine: 'mac-b',
    pid: 1,
    connectedAt: '2026-10-27T00:00:00Z',
    conditionalWrites: true,
  };
  const nodes = (list: unknown[]) => ({ state: { data: { nodes: list } } });
  const view = makeView(store, { slotId: 'slot-b', _slot: slotB, _nodesQuery: nodes([nodeB]) });
  reply = async () => {
    throw Object.assign(new Error('old node'), { code: 'FS_PRECONDITION_UNSUPPORTED' });
  };
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 140;\n');
  assert.equal(await effects.saveSlotViewDraft(view, 'src/value.ts'), false);
  assert.equal(effects.slotViewReadOnly(view, 'src/value.ts'), 'host');

  Object.assign(view, { slotId: 'slot-a', _slot: fleetSlots[0] });
  assert.equal(effects.slotViewReadOnly(view, 'src/value.ts'), undefined, 'slot A stays editable');
  Object.assign(view, { slotId: 'slot-b', _slot: slotB });
  assert.equal(effects.slotViewReadOnly(view, 'src/value.ts'), 'host', 'slot B stays read-only');

  // B's node reconnecting is asked again.
  Object.assign(view, { _nodesQuery: nodes([{ ...nodeB, connectedAt: '2026-10-27T01:00:00Z' }]) });
  assert.equal(effects.slotViewReadOnly(view, 'src/value.ts'), undefined);
});

test('signing out drops the edits still queued for its scope, and none comes back', async (t) => {
  reset(t);
  const { store, hold, release } = slowStorage();
  const view = makeView(store);
  hold('put');
  const first = effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 150;\n');
  await flush();
  const second = effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 151;\n');
  await flush();
  // The user confirms sign-out while the first edit is still being written.
  const signingOut = retireDraftScope(store, 'scope-a');
  await flush();
  release();
  await Promise.all([first, second, signingOut]);
  assert.deepEqual(await store.list('scope-a'), []);
  assert.equal(view._fileDrafts.size, 0);

  // Nothing typed or saved on this connection writes the scope again.
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 152;\n');
  assert.deepEqual(await store.list('scope-a'), []);
  view._fileDrafts = new Map([
    ['src/value.ts', { ...draftFor(), updatedAt: 0, stateEnteredAt: 0 }],
  ]);
  assert.equal(await effects.saveSlotViewDraft(view, 'src/value.ts'), false);
  assert.equal(writes.length, 0);

  // Signing in again is a later connection: the scope takes drafts again.
  gateway.resourceConnectionId++;
  view._fileDrafts = new Map();
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 153;\n');
  assert.deepEqual(
    (await store.list('scope-a')).map(({ editedContent }) => editedContent),
    ['export const value = 153;\n'],
  );
});

test('a save whose reply comes after sign-out leaves no draft behind', async (t) => {
  for (const outcome of ['saved', 'refused for its run'] as const) {
    const store = reset(t);
    const view = makeView(store);
    let answer!: () => void;
    reply = (write) =>
      new Promise((resolve, reject) => {
        answer = () =>
          outcome === 'saved'
            ? resolve({ ok: true, hash: sha256(String(write.params.content)) })
            : reject(
                Object.assign(new Error('moved'), {
                  code: 'FS_CONFLICT',
                  details: { reason: 'run', currentRunId: 'run-3' },
                }),
              );
      });
    await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 160;\n');
    const saving = effects.saveSlotViewDraft(view, 'src/value.ts');
    await flush();
    await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 161;\n');
    await retireDraftScope(store, 'scope-a');
    answer();
    await saving;
    assert.deepEqual(await store.list('scope-a'), [], outcome);
    t.mock.timers.reset();
  }
});

test('Save pressed on slot A never saves the draft slot B shows by the time A is stored', async (t) => {
  reset(t);
  const { store, hold, release } = slowStorage();
  const slotB = slot({ slot: 'slot-b', currentRunId: 'run-b' });
  fleetSlots = [slot(), slotB];
  const view = makeView(store, {
    _openFiles: [{ path: 'src/value.ts', type: 'file', pinned: true }],
    _isRecoveryBlocked: false,
    _pinFile: () => {},
    _diagnostics: [],
    querySelector: () => ({ _editor: { getValue: () => 'export const value = 170;\n' } }),
  });
  hold();
  const saving = commands.saveSlotViewFile(view);
  await flush();
  const restored = {
    ...draftFor({ slotId: 'slot-b', runId: 'run-b' }),
    updatedAt: 0,
    stateEnteredAt: 0,
  };
  Object.assign(view, {
    slotId: 'slot-b',
    _slot: slotB,
    _fileDrafts: new Map([['src/value.ts', restored]]),
  });
  release();
  await saving;
  assert.deepEqual(writes, [], 'neither slot is written without its own Save');
  assert.deepEqual(
    (await store.list('scope-a', 'slot-a')).map(({ editedContent }) => editedContent),
    ['export const value = 170;\n'],
    "A's text is kept as its draft",
  );
});

test('a draft another slot left in the view is never saved, and leaves it at once', async (t) => {
  const store = reset(t);
  const slotB = slot({ slot: 'slot-b', currentRunId: 'run-b' });
  fleetSlots = [slot(), slotB];
  const view = makeView(store);
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 180;\n');
  // The view moves to slot B before its drafts are listed again.
  Object.assign(view, { slotId: 'slot-b', _slot: slotB });
  assert.equal(await effects.saveSlotViewDraft(view, 'src/value.ts'), false);
  assert.deepEqual(writes, []);
  void effects.refreshSlotViewDrafts(view);
  assert.equal(view._fileDrafts.size, 0, 'dropped before the store answers');
  await flush();
});

test("slot A's save, refusal and worker notice never carry over to slot B's file", async (t) => {
  const store = reset(t);
  const slotB = slot({ slot: 'slot-b', currentRunId: 'run-b' });
  fleetSlots = [slot(), slotB];
  const view = makeView(store);
  const mine = 'export const value = 190;\n';
  reply = async () => ({ ok: true, hash: sha256(mine) });
  await effects.editSlotViewFile(view, 'src/value.ts', mine);
  assert.equal(await effects.saveSlotViewDraft(view, 'src/value.ts'), true);
  // On slot B, the same path holds other bytes: that is B's file, not a worker's write over A's.
  Object.assign(view, { slotId: 'slot-b', _slot: slotB });
  const other = 'export const value = 191; // slot b\n';
  await effects.noteSlotViewFileRead(view, 'src/value.ts', other, sha256(other));
  assert.deepEqual(await store.list('scope-a', 'slot-b'), []);
  assert.equal(effects.slotViewFileChangedPath(view), '');

  // A worker's notice and a refusal on A stay on A.
  Object.assign(view, { slotId: 'slot-a', _slot: fleetSlots[0] });
  const worker = 'export const value = 192; // worker\n';
  await effects.noteSlotViewFileRead(view, 'src/value.ts', worker, sha256(worker));
  assert.equal(effects.slotViewFileChangedPath(view), 'src/value.ts');
  Object.assign(view, { slotId: 'slot-b', _slot: slotB });
  assert.equal(effects.slotViewFileChangedPath(view), '');
  Object.assign(view, { slotId: 'slot-a', _slot: fleetSlots[0] });
  reply = async () => {
    throw new Error('Gateway request timed out');
  };
  await effects.saveSlotViewDraft(view, 'src/value.ts');
  assert.equal(effects.slotViewSaveState(view, 'src/value.ts'), 'refused');
  Object.assign(view, { slotId: 'slot-b', _slot: slotB, _fileDrafts: new Map() });
  assert.equal(effects.slotViewSaveState(view, 'src/value.ts'), 'saved');
  assert.equal(effects.slotViewFileChangedPath(view), '');
});

test("discarding a draft after the scope changed leaves the new scope's draft shown", async (t) => {
  reset(t);
  const { store, hold, release } = slowStorage();
  await store.put(draftFor());
  const view = makeView(store);
  await effects.refreshSlotViewDrafts(view);
  const [old] = view._slotDrafts;
  hold('delete');
  const discarding = effects.discardSlotViewDraft(view, old);
  await flush();
  // Another principal signs in; its own draft at the same slot, run and path is shown.
  scopeId = 'scope-b';
  const next = await store.put(
    draftFor({ scopeId: 'scope-b', editedContent: 'export const value = 200;\n' }),
  );
  view._fileDrafts = new Map([['src/value.ts', next]]);
  release();
  await discarding;
  assert.equal(view._fileDrafts.get('src/value.ts')?.scopeId, 'scope-b');
  assert.equal(view._editorRevision, 0);
});

test('a reconnect while sign-out runs never reopens the scope before sign-out has ended', async (t) => {
  reset(t);
  const { store, hold, release } = slowStorage();
  const other = 'export const other = 1;\n';
  const view = makeView(store, {
    _liveFileContents: new Map([
      ['src/value.ts', base],
      ['src/other.ts', other],
    ]),
    _liveFileHashes: new Map([
      ['src/value.ts', sha256(base)],
      ['src/other.ts', sha256(other)],
    ]),
  });
  hold('put');
  const first = effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 210;\n');
  await flush();
  let ended!: () => void;
  const signingOut = retireDraftScope(
    store,
    'scope-a',
    () =>
      new Promise<void>((resolve) => {
        ended = resolve;
      }),
  );
  await flush();
  // The socket reconnects while the held put keeps sign-out waiting; credentials are still live.
  gateway.resourceConnectionId++;
  release();
  await first;
  await flush();
  // After recovery, another file is edited, and again after a second reconnect.
  await effects.editSlotViewFile(view, 'src/other.ts', 'export const other = 2;\n');
  gateway.resourceConnectionId++;
  await effects.editSlotViewFile(view, 'src/other.ts', 'export const other = 3;\n');
  ended();
  await signingOut;
  assert.deepEqual(await store.list('scope-a'), []);

  // The connection sign-out ended on writes nothing; a sign-in on a later one writes again.
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 211;\n');
  assert.deepEqual(await store.list('scope-a'), []);
  gateway.resourceConnectionId++;
  await effects.editSlotViewFile(view, 'src/value.ts', 'export const value = 212;\n');
  assert.deepEqual(
    (await store.list('scope-a')).map(({ editedContent }) => editedContent),
    ['export const value = 212;\n'],
  );
});
