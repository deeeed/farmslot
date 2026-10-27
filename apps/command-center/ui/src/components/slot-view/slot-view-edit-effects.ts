import type { Draft, DraftKey, DraftStore } from '@farmslot/local-store/drafts';
import { type FsReadResult, type FsWriteResult, Methods } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { gateway } from '../../gateway-client.js';
import {
  getEditorDraftScopeId,
  getResourceCache,
  getResourceNativeOwnerId,
} from '../../resource-cache.js';

import type { SlotView } from './slot-view.js';
import {
  slotConditionalWrites,
  slotViewAutosaveAllowed,
  slotViewDraftState,
  type SlotViewReadOnlyReason,
  slotViewReadOnlyReason,
  slotViewReadRefused,
  slotViewSaveRefusal,
} from './slot-view-edit-model.js';

/** The pause in typing before an autosave. */
export const SLOT_VIEW_AUTOSAVE_PAUSE_MS = 1500;

/** Slots whose `fs.read` this scope's user was refused; their drafts stay hidden (decision 6). */
const refusedSlots = new Map<string, Set<string>>();

/** Records whether the user may read this slot's files, from the read just observed. */
export function noteSlotViewReadAccess(view: SlotView, path: string, readable: boolean): void {
  const scopeId = getEditorDraftScopeId();
  if (!scopeId) return;
  const refused =
    !readable && slotViewReadRefused(getResourceCache()?.read(slotViewFileQuery(view, path)).error);
  const slots = refusedSlots.get(scopeId) ?? new Set<string>();
  if (refused === slots.has(view.slotId)) return;
  if (refused) slots.add(view.slotId);
  else slots.delete(view.slotId);
  refusedSlots.set(scopeId, slots);
  void refreshSlotViewDrafts(view);
}

/** Decision 4's capability and host, and the run binding, for any write to this slot. */
function slotViewWriteBlock(view: SlotView) {
  return {
    connected: gateway.connectionState === 'connected',
    capability: gateway.authenticatedConnection?.capabilities?.conditionalFileWrites === true,
    host:
      !view._conditionalWritesRefused &&
      slotConditionalWrites(view._slot, view._nodesQuery.state.data?.nodes),
    // A workspace shown for a run the slot no longer serves takes no writes for it.
    staleRun: Boolean(
      view._linkedRun && view._slot && (view._slot.currentRunId ?? null) !== view._linkedRun.id,
    ),
  };
}

/** Why the open file is read-only (decision 4), or undefined when it can be edited. */
export function slotViewReadOnly(view: SlotView, path: string): SlotViewReadOnlyReason | undefined {
  return slotViewReadOnlyReason({
    ...slotViewWriteBlock(view),
    ready: view._workspaceReads.ready,
    content: view._liveFileContents.get(path),
    hash: view._liveFileHashes.get(path),
  });
}

export function slotViewEditable(view: SlotView, path: string): boolean {
  return view._isLive && slotViewReadOnly(view, path) === undefined;
}

/** Writes that are not on an open file's text: the slot itself must take checked writes. */
export function slotViewWritable(view: SlotView): boolean {
  const block = slotViewWriteBlock(view);
  return view._isLive && block.connected && block.capability && block.host && !block.staleRun;
}

function draftKey(view: SlotView, path: string, runId = view._slot?.currentRunId ?? null) {
  const scopeId = getEditorDraftScopeId();
  return scopeId ? { scopeId, slotId: view.slotId, runId, path } : undefined;
}

/** A draft's identity: the scope, slot, run and path it was made for. */
function draftIdentity(key: DraftKey): string {
  return JSON.stringify([key.scopeId, key.slotId, key.runId, key.path]);
}

/**
 * Autosave permission belongs to one draft identity. The same slot view shows other slots and
 * runs, so a path alone would lend one draft's permission to another.
 */
function armingKey(view: SlotView, path: string): string | undefined {
  const key = draftKey(view, path);
  return key && draftIdentity(key);
}

/** Identities with a save in flight: their drafts are kept, so the reply can tell what changed. */
const savesInFlight = new Set<string>();
/** Each identity's draft writes run in order, so an edit and a save's reply never interleave. */
const draftWrites = new Map<string, Promise<unknown>>();

function inOrder<T>(identity: string, write: () => Promise<T>): Promise<T> {
  const next = (draftWrites.get(identity) ?? Promise.resolve()).then(write);
  const settled = next.catch(() => undefined);
  draftWrites.set(identity, settled);
  void settled.then(() => {
    if (draftWrites.get(identity) === settled) draftWrites.delete(identity);
  });
  return next;
}

function armSlotViewAutosave(view: SlotView, path: string): void {
  const key = armingKey(view, path);
  if (key) view._autosaveArmed.set(key, gateway.resourceConnectionId);
}

/** Another slot or run drops every permission given for the previous one. */
function retireOtherArming(view: SlotView): void {
  const current = armingKey(view, '');
  const prefix = current?.slice(0, current.lastIndexOf(','));
  for (const key of view._autosaveArmed.keys())
    if (!prefix || !key.startsWith(`${prefix},`)) view._autosaveArmed.delete(key);
}

/**
 * Drafts rules 3 to 5: every draft of the scope takes its state from the ready fleet record, the
 * 30-day sweep runs, and the slot's visible drafts are listed. Hidden drafts are not listed.
 */
export async function refreshSlotViewDrafts(view: SlotView): Promise<void> {
  // Each change starts a refresh; only the latest one may replace what the view shows.
  const refresh = ++view._draftRefresh;
  retireOtherArming(view);
  const store = view._draftStore;
  const scopeId = getEditorDraftScopeId();
  if (!store || !scopeId) {
    view._slotDrafts = [];
    return;
  }
  // Loaded when drafts are, so the workspace effects keep a light import graph.
  const { getState } = await import('../../state.js');
  const state = getState();
  const fleet = {
    ready: state.fleetObservation.status === 'ready',
    slots: state.fleet?.slots ?? [],
  };
  const refused = refusedSlots.get(scopeId) ?? new Set<string>();
  for (const draft of await store.list(scopeId)) {
    const next = slotViewDraftState(draft, fleet, refused);
    if (next && next !== draft.state) await store.put({ ...draft, state: next });
  }
  await store.sweep();
  const drafts = await store.list(scopeId, view.slotId);
  if (refresh !== view._draftRefresh || scopeId !== getEditorDraftScopeId()) return;
  view._slotDrafts = drafts.filter((draft) => draft.state !== 'hidden');
  const runId = view._slot?.currentRunId ?? null;
  view._fileDrafts = new Map(
    drafts
      .filter((draft) => draft.state === 'current' && draft.runId === runId)
      .map((draft) => [draft.path, draft]),
  );
}

/** Every edit updates the file's draft; an edit back to the base removes it. */
export async function editSlotViewFile(
  view: SlotView,
  path: string,
  content: string,
): Promise<void> {
  const store = view._draftStore;
  const key = draftKey(view, path);
  if (!store || !key || !slotViewEditable(view, path)) return;
  const identity = draftIdentity(key);
  await inOrder(identity, async () => {
    if (armingKey(view, path) !== identity) return;
    const existing = view._fileDrafts.get(path);
    const baseContent = existing?.baseContent ?? view._liveFileContents.get(path) ?? '';
    const baseHash = existing ? existing.baseHash : (view._liveFileHashes.get(path) ?? null);
    // While a save is in flight the draft stays, even back at its base: that is still an edit
    // the reply must keep over the saved text.
    if (content === baseContent && !savesInFlight.has(identity)) {
      view._fileDrafts = new Map([...view._fileDrafts].filter(([file]) => file !== path));
      await store.delete(key);
      return;
    }
    // A draft started by typing on this connection autosaves; a restored one waits for a save.
    if (!existing) armSlotViewAutosave(view, path);
    const draft = await store.put({
      ...key,
      baseContent,
      baseHash,
      editedContent: content,
      state: 'current',
    });
    view._fileDrafts = new Map(view._fileDrafts).set(path, draft);
    scheduleSlotViewAutosave(view, path);
  });
  void refreshSlotViewDrafts(view);
}

export function scheduleSlotViewAutosave(view: SlotView, path: string): void {
  clearTimeout(view._autosaveTimer);
  const scheduled = armingKey(view, path);
  view._autosaveTimer = setTimeout(async () => {
    const { getState, isFleetCurrent } = await import('../../state.js');
    const slot = getState().fleet?.slots.find((candidate) => candidate.slot === view.slotId);
    // The draft that paused must still be the one shown: same scope, slot, run and path.
    const key = armingKey(view, path);
    if (
      key !== undefined &&
      key === scheduled &&
      view._activeFile === path &&
      view._fileDrafts.has(path) &&
      slotViewAutosaveAllowed({
        fleetCurrent: isFleetCurrent(),
        slot,
        armed: view._autosaveArmed.get(key) === gateway.resourceConnectionId,
      })
    )
      void saveSlotViewDraft(view, path);
  }, SLOT_VIEW_AUTOSAVE_PAUSE_MS);
}

/** The shared `fs.read` query a slot view's workspace read observes for this path. */
export function slotViewFileQuery(view: SlotView, path: string) {
  const runId = view._linkedRun?.id;
  return resourceQuery<FsReadResult>(
    Methods.FS_READ,
    { slotId: view.slotId, path, ...(runId ? { runId } : {}) },
    getResourceNativeOwnerId(),
  );
}

/** A refused save keeps the draft; the file is read again so both versions can be shown. */
async function showSlotViewConflict(view: SlotView, path: string, mine: string): Promise<void> {
  const current = await getResourceCache()?.retry(slotViewFileQuery(view, path));
  const theirs = current?.data;
  view._saveConflict = {
    path,
    mine,
    theirs: theirs?.content,
    theirsHash: theirs?.hash ?? null,
  };
}

/**
 * Saves the file's draft with its base hash and the run it was made for. A refusal keeps the
 * draft: a content conflict shows both versions, a run conflict leaves a read-only draft, and a
 * host without conditional writes makes the editor read-only.
 */
export async function saveSlotViewDraft(view: SlotView, path: string): Promise<boolean> {
  const draft = view._fileDrafts.get(path);
  const store = view._draftStore;
  if (!draft || !store || view._saveFeedback === 'saving') return false;
  const identity = draftIdentity(draft);
  const content = draft.editedContent;
  savesInFlight.add(identity);
  view._saveFeedback = 'saving';
  view._editNotice = '';
  view._saveRefused = '';
  if (view._fileChangedNotice === path) view._fileChangedNotice = '';
  let result: FsWriteResult;
  try {
    result = await gateway.request<FsWriteResult>(Methods.FS_WRITE, {
      slotId: draft.slotId,
      path,
      content,
      expectedHash: draft.baseHash,
      runId: draft.runId,
    });
  } catch (error) {
    await inOrder(identity, () => refuseSlotViewSave(view, store, draft, error));
    return false;
  }
  await inOrder(identity, () => completeSlotViewSave(view, store, draft, content, result));
  return true;
}

/**
 * The reply belongs to the draft that was sent, not to whatever the view shows now. Text that
 * differs from what was sent, a return to the old base included, stays a draft over the saved
 * bytes. Only while that draft is still shown does the reply touch the view or its autosave.
 */
async function completeSlotViewSave(
  view: SlotView,
  store: DraftStore,
  sent: Draft,
  content: string,
  result: FsWriteResult,
): Promise<void> {
  const identity = draftIdentity(sent);
  savesInFlight.delete(identity);
  const latest = await store.get(sent);
  const kept =
    latest && latest.editedContent !== content
      ? await store.put({
          ...latest,
          baseContent: content,
          baseHash: result.hash ?? latest.baseHash,
        })
      : undefined;
  if (!kept) await store.delete(sent);
  const path = sent.path;
  if (armingKey(view, path) !== identity) {
    view._saveFeedback = '';
    return;
  }
  view._fileDrafts = kept
    ? new Map(view._fileDrafts).set(path, kept)
    : new Map([...view._fileDrafts].filter(([file]) => file !== path));
  view._liveFileContents = new Map(view._liveFileContents).set(path, content);
  view._liveFileHashes = new Map(view._liveFileHashes).set(path, result.hash);
  // A later read with other bytes is a worker's write over this save.
  if (result.hash) view._userSaves.set(path, { hash: result.hash, content });
  armSlotViewAutosave(view, path);
  view._saveConflict = undefined;
  view._saveFeedback = 'saved';
  setTimeout(() => {
    if (view._saveFeedback === 'saved') view._saveFeedback = '';
  }, 2000);
  if (kept) scheduleSlotViewAutosave(view, path);
  void refreshSlotViewDrafts(view);
}

/** A refusal keeps the latest text of the draft that was sent; another slot's view is untouched. */
async function refuseSlotViewSave(
  view: SlotView,
  store: DraftStore,
  sent: Draft,
  error: unknown,
): Promise<void> {
  const identity = draftIdentity(sent);
  savesInFlight.delete(identity);
  view._saveFeedback = '';
  const latest = (await store.get(sent)) ?? sent;
  const refusal = slotViewSaveRefusal(error);
  if (refusal?.kind === 'run') await store.put({ ...latest, state: 'stale-run' });
  const path = sent.path;
  if (armingKey(view, path) !== identity) return;
  if (refusal?.kind !== 'hash') view._saveRefused = path;
  if (refusal?.kind === 'hash') await showSlotViewConflict(view, path, latest.editedContent);
  else if (refusal?.kind === 'run') {
    view._fileDrafts = new Map([...view._fileDrafts].filter(([file]) => file !== path));
    view._editNotice =
      'The slot now serves another run. Your edit is kept as a read-only draft to copy.';
  } else if (refusal?.kind === 'unsupported') {
    view._conditionalWritesRefused = true;
    view._editNotice = "This slot's node cannot check edits, so the editor is read-only.";
  } else
    view._editNotice = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
  void refreshSlotViewDrafts(view);
}

/** Conflicts: the user keeps their version, saved over the file as it now is. */
export async function keepMineSlotViewConflict(view: SlotView): Promise<void> {
  const conflict = view._saveConflict;
  const draft = conflict && view._fileDrafts.get(conflict.path);
  const store = view._draftStore;
  if (!conflict || !draft || !store) return;
  const rebased = await store.put({
    ...draft,
    baseContent: conflict.theirs ?? '',
    baseHash: conflict.theirsHash,
  });
  view._fileDrafts = new Map(view._fileDrafts).set(conflict.path, rebased);
  await saveSlotViewDraft(view, conflict.path);
}

/** Conflicts: the user keeps the file as it now is, and the draft goes. */
export async function keepTheirsSlotViewConflict(view: SlotView): Promise<void> {
  const conflict = view._saveConflict;
  const draft = conflict && view._fileDrafts.get(conflict.path);
  if (!conflict) return;
  if (draft) await view._draftStore?.delete(draft);
  view._fileDrafts = new Map([...view._fileDrafts].filter(([file]) => file !== conflict.path));
  if (conflict.theirs !== undefined) {
    view._liveFileContents = new Map(view._liveFileContents).set(conflict.path, conflict.theirs);
    view._liveFileHashes = new Map(view._liveFileHashes).set(
      conflict.path,
      conflict.theirsHash ?? undefined,
    );
  }
  view._saveConflict = undefined;
  view._editorRevision++;
  void refreshSlotViewDrafts(view);
}

/**
 * Worker writes: a file the user saved that now reads as other bytes was changed by someone
 * else. The editor says so and keeps the user's version as a draft, which waits for a save.
 */
export async function noteSlotViewFileRead(
  view: SlotView,
  path: string,
  content: string,
  hash: string | undefined,
): Promise<void> {
  const saved = view._userSaves.get(path);
  if (!saved || !hash || hash === saved.hash) return;
  view._userSaves.delete(path);
  if (content === saved.content || view._fileDrafts.has(path)) return;
  const key = draftKey(view, path);
  if (!key || !view._draftStore) return;
  const draft: Draft = await view._draftStore.put({
    ...key,
    baseContent: content,
    baseHash: hash,
    editedContent: saved.content,
    state: 'current',
  });
  const armed = armingKey(view, path);
  if (armed) view._autosaveArmed.delete(armed);
  view._fileDrafts = new Map(view._fileDrafts).set(path, draft);
  view._fileChangedNotice = path;
  void refreshSlotViewDrafts(view);
}

/** The proof reads this from `file-save-state`'s `data-state`. */
export function slotViewSaveState(
  view: SlotView,
  path: string,
): 'saved' | 'saving' | 'draft' | 'conflict' | 'refused' {
  if (view._saveFeedback === 'saving') return 'saving';
  if (view._saveConflict?.path === path) return 'conflict';
  if (view._saveRefused === path) return 'refused';
  return view._fileDrafts.has(path) ? 'draft' : 'saved';
}

/** A read-only draft for a run that is no longer current can be copied. */
export async function copySlotViewDraft(draft: Draft): Promise<void> {
  await navigator.clipboard.writeText(draft.editedContent);
}

export async function discardSlotViewDraft(view: SlotView, draft: DraftKey): Promise<void> {
  await view._draftStore?.delete(draft);
  if (draft.slotId === view.slotId && view._fileDrafts.get(draft.path)?.runId === draft.runId) {
    view._fileDrafts = new Map([...view._fileDrafts].filter(([file]) => file !== draft.path));
    view._editorRevision++;
  }
  await refreshSlotViewDrafts(view);
}
