import type { Draft, DraftKey, DraftStore } from '@farmslot/local-store/drafts';
import { type FsReadResult, type FsWriteResult, Methods } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { type DraftScopeWriter, draftScopeWriter } from '../../draft-scopes.js';
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

let appState: Promise<typeof import('../../state.js')> | undefined;

/**
 * The app state, imported once on first use so the workspace effects keep a light import graph.
 * Later uses resolve at once instead of each paying for a module resolution.
 */
function loadAppState() {
  appState ??= import('../../state.js').catch((error: unknown) => {
    appState = undefined;
    throw error;
  });
  return appState;
}

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

/**
 * The slot a refusal to check edits was learned for, and its node as it was then: the node
 * reconnecting, or changing what it advertises, is asked again.
 */
function conditionalWritesKey(view: SlotView): string {
  const machine = view._slot?.machine ?? null;
  const node = view._nodesQuery.state.data?.nodes.find((entry) => entry.machine === machine);
  return JSON.stringify([
    view.slotId,
    machine,
    node?.connectedAt ?? null,
    node?.conditionalWrites ?? null,
  ]);
}

/** The shown slot's node cannot check edits: that slot alone goes read-only. */
export function refuseSlotViewConditionalWrites(view: SlotView): void {
  view._conditionalWritesRefused = new Set(view._conditionalWritesRefused).add(
    conditionalWritesKey(view),
  );
}

/** Decision 4's capability and host, and the run binding, for any write to this slot. */
function slotViewWriteBlock(view: SlotView) {
  return {
    connected: gateway.connectionState === 'connected',
    capability: gateway.authenticatedConnection?.capabilities?.conditionalFileWrites === true,
    host:
      !view._conditionalWritesRefused.has(conditionalWritesKey(view)) &&
      slotConditionalWrites(view._slot, view._nodesQuery.state.data?.nodes),
    // A workspace shown for a run the slot no longer serves takes no writes for it.
    staleRun: Boolean(
      view._linkedRun && view._slot && (view._slot.currentRunId ?? null) !== view._linkedRun.id,
    ),
  };
}

/**
 * Why the open file is read-only (decision 4), or undefined when it can be edited. Readiness is
 * the file's own `fs.read`, not the whole workspace: other reads refreshing never block it.
 */
export function slotViewReadOnly(view: SlotView, path: string): SlotViewReadOnlyReason | undefined {
  return slotViewReadOnlyReason({
    ...slotViewWriteBlock(view),
    ready:
      view._workspaceReads.stateOf(Methods.FS_READ, { slotId: view.slotId, path })?.status ===
      'ready',
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

/** The identity of the draft the view shows at this path: scope, slot, run and path. */
export function slotViewDraftIdentity(view: SlotView, path: string): string | undefined {
  return armingKey(view, path);
}

/** The view still shows this draft: same scope, slot, run and path. */
function shows(view: SlotView, identity: string, path: string): boolean {
  return armingKey(view, path) === identity;
}

/**
 * The shown draft's autosave, when a save for another draft held it back: the view takes one
 * save at a time. A draft is never retried after its own refusal.
 */
function resumeShownAutosave(view: SlotView, settled: string): void {
  const path = view._activeFile;
  const identity = armingKey(view, path);
  const draft = view._fileDrafts.get(path);
  if (
    identity &&
    identity !== settled &&
    draft &&
    draft.editedContent !== draft.baseContent &&
    view._autosaveArmed.get(identity) === gateway.resourceConnectionId
  )
    scheduleSlotViewAutosave(view, path);
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
  // Another slot's, run's or scope's drafts leave the view at once, before the store answers.
  const shown = [...view._fileDrafts].filter(
    ([path, draft]) => draftIdentity(draft) === armingKey(view, path),
  );
  if (shown.length !== view._fileDrafts.size) view._fileDrafts = new Map(shown);
  const store = view._draftStore;
  const scopeId = getEditorDraftScopeId();
  if (!store || !scopeId) {
    view._slotDrafts = [];
    return;
  }
  const writer = draftScopeWriter(scopeId);
  const { getState } = await loadAppState();
  const state = getState();
  const fleet = {
    ready: state.fleetObservation.status === 'ready',
    slots: state.fleet?.slots ?? [],
  };
  const refused = refusedSlots.get(scopeId) ?? new Set<string>();
  for (const draft of await store.list(scopeId)) {
    const next = slotViewDraftState(draft, fleet, refused);
    if (next && next !== draft.state)
      await writer.write(() => store.put({ ...draft, state: next }));
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

/**
 * Every edit updates the file's draft; an edit back to the base removes it. An accepted edit is
 * kept under the draft it was typed in, even when the view moves on before its turn comes; only
 * the draft still shown is published, armed and scheduled.
 */
export async function editSlotViewFile(
  view: SlotView,
  path: string,
  content: string,
): Promise<void> {
  const store = view._draftStore;
  const key = draftKey(view, path);
  if (!store || !key || !slotViewEditable(view, path)) return;
  const identity = draftIdentity(key);
  const writer = draftScopeWriter(key.scopeId);
  // The file as last read is the base of a draft this edit starts.
  const liveContent = view._liveFileContents.get(path) ?? '';
  const liveHash = view._liveFileHashes.get(path) ?? null;
  await inOrder(identity, async () => {
    const existing = await store.get(key);
    const baseContent = existing?.baseContent ?? liveContent;
    const baseHash = existing ? existing.baseHash : liveHash;
    // While a save is in flight the draft stays, even back at its base: that is still an edit
    // the reply must keep over the saved text.
    const draft =
      content === baseContent && !savesInFlight.has(identity)
        ? undefined
        : await writer.write(() =>
            store.put({
              ...key,
              baseContent,
              baseHash,
              editedContent: content,
              state: 'current',
            }),
          );
    // A retired scope (sign-out, another principal) takes no more edits, nor shows them.
    if (!writer.live()) return;
    if (!draft) await store.delete(key);
    if (!shows(view, identity, path)) return;
    if (!draft) {
      view._fileDrafts = new Map([...view._fileDrafts].filter(([file]) => file !== path));
      return;
    }
    // A draft started by typing on this connection autosaves; a restored one waits for a save.
    if (!existing) armSlotViewAutosave(view, path);
    view._fileDrafts = new Map(view._fileDrafts).set(path, draft);
    scheduleSlotViewAutosave(view, path);
  });
  void refreshSlotViewDrafts(view);
}

export function scheduleSlotViewAutosave(view: SlotView, path: string): void {
  clearTimeout(view._autosaveTimer);
  const scheduled = armingKey(view, path);
  view._autosaveTimer = setTimeout(async () => {
    const { getState, isFleetCurrent } = await loadAppState();
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
async function readSlotViewConflict(view: SlotView, path: string, mine: string) {
  const current = await getResourceCache()?.retry(slotViewFileQuery(view, path));
  const theirs = current?.data;
  return { path, mine, theirs: theirs?.content, theirsHash: theirs?.hash ?? null };
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
  const writer = draftScopeWriter(draft.scopeId);
  // Only the draft the view shows is saved, and never one of a retired scope.
  if (identity !== armingKey(view, path) || !writer.live()) return false;
  const content = draft.editedContent;
  savesInFlight.add(identity);
  view._saveFeedback = 'saving';
  view._editNotice = '';
  view._saveRefused = '';
  if (view._fileChangedNotice === identity) view._fileChangedNotice = '';
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
    await inOrder(identity, () => refuseSlotViewSave(view, store, writer, draft, error));
    return false;
  }
  await inOrder(identity, () => completeSlotViewSave(view, store, writer, draft, content, result));
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
  writer: DraftScopeWriter,
  sent: Draft,
  content: string,
  result: FsWriteResult,
): Promise<void> {
  const identity = draftIdentity(sent);
  savesInFlight.delete(identity);
  const latest = await store.get(sent);
  const kept =
    latest && latest.editedContent !== content
      ? await writer.write(() =>
          store.put({
            ...latest,
            baseContent: content,
            baseHash: result.hash ?? latest.baseHash,
          }),
        )
      : undefined;
  if (!kept) await store.delete(sent);
  const path = sent.path;
  if (!shows(view, identity, path)) {
    view._saveFeedback = '';
    resumeShownAutosave(view, identity);
    return;
  }
  view._fileDrafts = kept
    ? new Map(view._fileDrafts).set(path, kept)
    : new Map([...view._fileDrafts].filter(([file]) => file !== path));
  view._liveFileContents = new Map(view._liveFileContents).set(path, content);
  view._liveFileHashes = new Map(view._liveFileHashes).set(path, result.hash);
  // A later read with other bytes is a worker's write over this save.
  if (result.hash) view._userSaves.set(identity, { hash: result.hash, content });
  armSlotViewAutosave(view, path);
  view._saveConflict = undefined;
  view._saveFeedback = 'saved';
  setTimeout(() => {
    if (view._saveFeedback === 'saved') view._saveFeedback = '';
  }, 2000);
  if (kept) scheduleSlotViewAutosave(view, path);
  resumeShownAutosave(view, identity);
  void refreshSlotViewDrafts(view);
}

/**
 * A refusal keeps the latest text of the draft that was sent. The view hears of it only while it
 * still shows that draft, checked again after the file is read for a conflict.
 */
async function refuseSlotViewSave(
  view: SlotView,
  store: DraftStore,
  writer: DraftScopeWriter,
  sent: Draft,
  error: unknown,
): Promise<void> {
  const identity = draftIdentity(sent);
  savesInFlight.delete(identity);
  view._saveFeedback = '';
  const latest = (await store.get(sent)) ?? sent;
  const refusal = slotViewSaveRefusal(error);
  if (refusal?.kind === 'run')
    await writer.write(() => store.put({ ...latest, state: 'stale-run' }));
  const path = sent.path;
  const conflict =
    refusal?.kind === 'hash' && shows(view, identity, path)
      ? await readSlotViewConflict(view, path, latest.editedContent)
      : undefined;
  if (!shows(view, identity, path)) {
    resumeShownAutosave(view, identity);
    return;
  }
  if (refusal?.kind !== 'hash') view._saveRefused = identity;
  if (conflict) view._saveConflict = conflict;
  else if (refusal?.kind === 'run') {
    view._fileDrafts = new Map([...view._fileDrafts].filter(([file]) => file !== path));
    view._editNotice =
      'The slot now serves another run. Your edit is kept as a read-only draft to copy.';
  } else if (refusal?.kind === 'unsupported') {
    refuseSlotViewConditionalWrites(view);
    view._editNotice = "This slot's node cannot check edits, so the editor is read-only.";
  } else if (refusal?.kind !== 'hash')
    view._editNotice = `Save failed: ${error instanceof Error ? error.message : String(error)}`;
  resumeShownAutosave(view, identity);
  void refreshSlotViewDrafts(view);
}

/** Conflicts: the user keeps their version, saved over the file as it now is. */
export async function keepMineSlotViewConflict(view: SlotView): Promise<void> {
  const conflict = view._saveConflict;
  const draft = conflict && view._fileDrafts.get(conflict.path);
  const store = view._draftStore;
  if (!conflict || !draft || !store) return;
  const identity = draftIdentity(draft);
  const rebased = await draftScopeWriter(draft.scopeId).write(() =>
    store.put({
      ...draft,
      baseContent: conflict.theirs ?? '',
      baseHash: conflict.theirsHash,
    }),
  );
  // Navigated away: the stored draft is rebased, and saving it waits for the user.
  if (!rebased || !shows(view, identity, conflict.path)) return;
  view._fileDrafts = new Map(view._fileDrafts).set(conflict.path, rebased);
  await saveSlotViewDraft(view, conflict.path);
}

/** Conflicts: the user keeps the file as it now is, and the draft goes. */
export async function keepTheirsSlotViewConflict(view: SlotView): Promise<void> {
  const conflict = view._saveConflict;
  const draft = conflict && view._fileDrafts.get(conflict.path);
  if (!conflict) return;
  const identity = armingKey(view, conflict.path);
  if (draft) await view._draftStore?.delete(draft);
  if (!identity || !shows(view, identity, conflict.path)) return;
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
  // Saves are told apart per draft identity: another slot's save at this path is not this one.
  const key = draftKey(view, path);
  const store = view._draftStore;
  const identity = key && draftIdentity(key);
  const saved = identity && view._userSaves.get(identity);
  if (!key || !store || !identity || !saved || !hash || hash === saved.hash) return;
  view._userSaves.delete(identity);
  if (content === saved.content || view._fileDrafts.has(path)) return;
  const draft = await draftScopeWriter(key.scopeId).write(() =>
    store.put({
      ...key,
      baseContent: content,
      baseHash: hash,
      editedContent: saved.content,
      state: 'current',
    }),
  );
  // Kept under the draft it belongs to; the view hears of it only while it shows that draft.
  view._autosaveArmed.delete(identity);
  if (!draft || !shows(view, identity, path)) return;
  view._fileDrafts = new Map(view._fileDrafts).set(path, draft);
  view._fileChangedNotice = identity;
  void refreshSlotViewDrafts(view);
}

/** The file a worker changed after the user's save, while the view still shows its draft. */
export function slotViewFileChangedPath(view: SlotView): string {
  const notice = view._fileChangedNotice;
  const identity: unknown = notice ? JSON.parse(notice) : undefined;
  const path: unknown = Array.isArray(identity) ? identity[3] : undefined;
  return typeof path === 'string' && armingKey(view, path) === notice ? path : '';
}

/** The proof reads this from `file-save-state`'s `data-state`. */
export function slotViewSaveState(
  view: SlotView,
  path: string,
): 'saved' | 'saving' | 'draft' | 'conflict' | 'refused' {
  if (view._saveFeedback === 'saving') return 'saving';
  if (view._saveConflict?.path === path) return 'conflict';
  if (view._saveRefused && view._saveRefused === armingKey(view, path)) return 'refused';
  return view._fileDrafts.has(path) ? 'draft' : 'saved';
}

/** A read-only draft for a run that is no longer current can be copied. */
export async function copySlotViewDraft(draft: Draft): Promise<void> {
  await navigator.clipboard.writeText(draft.editedContent);
}

export async function discardSlotViewDraft(view: SlotView, draft: DraftKey): Promise<void> {
  await view._draftStore?.delete(draft);
  const shown = view._fileDrafts.get(draft.path);
  if (shown && draftIdentity(shown) === draftIdentity(draft)) {
    view._fileDrafts = new Map([...view._fileDrafts].filter(([file]) => file !== draft.path));
    view._editorRevision++;
  }
  await refreshSlotViewDrafts(view);
}
