/** Unsaved editor drafts. They live outside the resource store, so its resets and caps keep them. */

export const DRAFT_SCHEMA_VERSION = 1;
export const DRAFT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** 'stale-run': the slot serves another run now. 'hidden': the user can no longer read the slot. */
export type DraftState = 'current' | 'stale-run' | 'hidden';

export interface DraftKey {
  /** `resourceStoreScopeId` of the gateway profile and principal generation. */
  scopeId: string;
  slotId: string;
  runId: string | null;
  path: string;
}

export interface DraftInput extends DraftKey {
  baseContent: string;
  /** SHA-256 of the base bytes; null when the file did not exist. */
  baseHash: string | null;
  editedContent: string;
  state: DraftState;
}

export interface Draft extends DraftInput {
  /** When the base or edited content last changed. */
  updatedAt: number;
  /** When this client first recorded the current state. */
  stateEnteredAt: number;
}

export interface StoredDraft extends Draft {
  id: string;
}

/** The storage seam: IndexedDB in a browser, memory in tests. */
export interface DraftStorage {
  get(id: string): Promise<StoredDraft | undefined>;
  put(draft: StoredDraft): Promise<void>;
  delete(id: string): Promise<void>;
  /** Every draft, or one scope's drafts. */
  list(scopeId?: string): Promise<StoredDraft[]>;
  close(): void;
}

export interface DraftStore {
  /** Keeps `stateEnteredAt` while the state is unchanged, and `updatedAt` while the content is. */
  put(draft: DraftInput): Promise<Draft>;
  get(key: DraftKey): Promise<Draft | undefined>;
  list(scopeId: string, slotId?: string): Promise<Draft[]>;
  delete(key: DraftKey): Promise<void>;
  /** Drafts whose edited content differs from their base, in any state. */
  countUnsaved(scopeId: string): Promise<number>;
  deleteScope(scopeId: string): Promise<void>;
  /** Deletes drafts more than 30 days after they entered 'stale-run' or 'hidden'. */
  sweep(): Promise<number>;
  close(): void;
}

function draftId({ scopeId, slotId, runId, path }: DraftKey): string {
  return JSON.stringify([scopeId, slotId, runId, path]);
}

function draft({ id: _id, ...stored }: StoredDraft): Draft {
  return stored;
}

export function createDraftStore(storage: DraftStorage, now: () => number = Date.now): DraftStore {
  return {
    async put(input) {
      const id = draftId(input);
      const previous = await storage.get(id);
      const time = now();
      const stored: StoredDraft = {
        id,
        scopeId: input.scopeId,
        slotId: input.slotId,
        runId: input.runId,
        path: input.path,
        baseContent: input.baseContent,
        baseHash: input.baseHash,
        editedContent: input.editedContent,
        state: input.state,
        updatedAt:
          previous &&
          previous.baseContent === input.baseContent &&
          previous.baseHash === input.baseHash &&
          previous.editedContent === input.editedContent
            ? previous.updatedAt
            : time,
        stateEnteredAt: previous?.state === input.state ? previous.stateEnteredAt : time,
      };
      await storage.put(stored);
      return draft(stored);
    },
    async get(key) {
      const stored = await storage.get(draftId(key));
      return stored && draft(stored);
    },
    async list(scopeId, slotId) {
      return (await storage.list(scopeId))
        .filter((stored) => slotId === undefined || stored.slotId === slotId)
        .map(draft);
    },
    delete: (key) => storage.delete(draftId(key)),
    async countUnsaved(scopeId) {
      return (await storage.list(scopeId)).filter(
        (stored) => stored.editedContent !== stored.baseContent,
      ).length;
    },
    async deleteScope(scopeId) {
      for (const stored of await storage.list(scopeId)) await storage.delete(stored.id);
    },
    async sweep() {
      const time = now();
      let deleted = 0;
      for (const stored of await storage.list())
        if (stored.state !== 'current' && time - stored.stateEnteredAt > DRAFT_RETENTION_MS) {
          await storage.delete(stored.id);
          deleted++;
        }
      return deleted;
    },
    close: () => storage.close(),
  };
}

export function createMemoryDraftStorage(): DraftStorage {
  const drafts = new Map<string, StoredDraft>();
  return {
    async get(id) {
      const stored = drafts.get(id);
      return stored && { ...stored };
    },
    async put(stored) {
      drafts.set(stored.id, { ...stored });
    },
    async delete(id) {
      drafts.delete(id);
    },
    async list(scopeId) {
      return [...drafts.values()]
        .filter((stored) => scopeId === undefined || stored.scopeId === scopeId)
        .map((stored) => ({ ...stored }));
    },
    close() {},
  };
}

const DRAFTS = 'drafts';
/** Each entry upgrades the database from the previous version. */
const migrations: Array<(database: IDBDatabase) => void> = [
  (database) =>
    database.createObjectStore(DRAFTS, { keyPath: 'id' }).createIndex('scopeId', 'scopeId'),
];

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** One database for every tab of this origin, upgraded through `migrations`. */
export async function openIndexedDbDraftStorage(name = 'farmslot-drafts'): Promise<DraftStorage> {
  const opening = indexedDB.open(name, DRAFT_SCHEMA_VERSION);
  opening.onupgradeneeded = (event) => {
    for (let version = event.oldVersion; version < DRAFT_SCHEMA_VERSION; version++)
      migrations[version](opening.result);
  };
  const database = await settle(opening);
  // Another tab's newer schema waits for this connection to close.
  database.onversionchange = () => database.close();
  const objects = (mode: IDBTransactionMode) =>
    database.transaction(DRAFTS, mode).objectStore(DRAFTS);
  return {
    get: (id) => settle(objects('readonly').get(id) as IDBRequest<StoredDraft | undefined>),
    async put(stored) {
      await settle(objects('readwrite').put(stored));
    },
    async delete(id) {
      await settle(objects('readwrite').delete(id));
    },
    list: (scopeId) =>
      settle(
        (scopeId === undefined
          ? objects('readonly').getAll()
          : objects('readonly').index('scopeId').getAll(scopeId)) as IDBRequest<StoredDraft[]>,
      ),
    close: () => database.close(),
  };
}
