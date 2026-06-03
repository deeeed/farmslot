// chat/chat-store.ts — In-memory session store with debounced persistence

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  type ChatMessage,
  type ChatSession,
  type ChatSessionSummary,
  GLOBAL_CHAT_SESSION_ID,
} from '@farmslot/protocol';

import { getCopilotDir } from './chat-memory.js';

const GLOBAL_SESSION_ID = GLOBAL_CHAT_SESSION_ID;
const LEGACY_DEFAULT_SESSION_ID = 'default';
const PERSIST_DEBOUNCE_MS = 2000;
const SESSION_ID_MAX_LENGTH = 160;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

const sessions = new Map<string, ChatSession>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasErrorCode(err: unknown, code: string): boolean {
  return err instanceof Error && Reflect.get(err, 'code') === code;
}

function timestampMs(value: string | undefined): number {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function latestTimestamp(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return timestampMs(a) >= timestampMs(b) ? a : b;
}

function earliestTimestamp(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return timestampMs(a) <= timestampMs(b) ? a : b;
}

function mergeSessionsByMessageId(a: ChatSession, b: ChatSession): ChatSession {
  if (a.id !== b.id) throw new Error(`Cannot merge different chat sessions: ${a.id} vs ${b.id}`);
  const newer = timestampMs(a.updatedAt) >= timestampMs(b.updatedAt) ? a : b;
  const older = newer === a ? b : a;
  const messagesById = new Map<string, ChatMessage>();
  for (const message of older.messages) messagesById.set(message.id, message);
  for (const message of newer.messages) messagesById.set(message.id, message);
  return {
    ...newer,
    id: newer.id,
    messages: [...messagesById.values()].sort(
      (left, right) => timestampMs(left.timestamp) - timestampMs(right.timestamp),
    ),
    title: newer.title ?? older.title,
    pinned: newer.pinned ?? older.pinned,
    createdAt: earliestTimestamp(a.createdAt, b.createdAt) ?? newer.createdAt,
    updatedAt: latestTimestamp(a.updatedAt, b.updatedAt) ?? newer.updatedAt,
    lastSavedAt: latestTimestamp(a.lastSavedAt, b.lastSavedAt),
  };
}

function inferSessionScope(sessionId: string): ChatSessionSummary['scope'] {
  if (sessionId === 'global') return 'global';
  if (sessionId.startsWith('run:')) return 'run';
  if (sessionId.startsWith('family:')) return 'family';
  if (sessionId.startsWith('slot:')) return 'slot';
  if (sessionId.startsWith('manual:')) return 'manual';
  // Migration orphan path: legacy on-disk session ids without one of the
  // known prefixes (e.g. `test-clear-...` from old test runs) land here.
  // restoreSession() defaults pinned=true on these so they don't auto-purge,
  // and "Delete ephemeral" only sweeps pinned=false rows — operators can
  // still remove them via per-row Delete in the history modal.
  return 'unknown';
}

function defaultSessionTitle(sessionId: string): string {
  const separator = sessionId.indexOf(':');
  const scope = inferSessionScope(sessionId);
  const id = separator >= 0 ? sessionId.slice(separator + 1) : '';
  if (scope === 'global') return 'Shared chat';
  if (scope === 'run' && id) return `Run ${id}`;
  if (scope === 'family' && id) return `Family ${id}`;
  if (scope === 'slot' && id) return `Slot ${id}`;
  if (scope === 'manual') return 'New chat';
  return sessionId;
}

function previewText(message: ChatMessage | undefined): string | undefined {
  if (!message?.content.trim()) return undefined;
  return message.content.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function titleFromPrompt(text: string): string {
  const title = text.replace(/\s+/g, ' ').trim().slice(0, 64);
  return title || 'New chat';
}

function isEmptyEphemeralSession(session: ChatSession): boolean {
  // Predicate consumed by listSessionSummaries() — empty ephemerals of any
  // scope are filtered out of session SUMMARIES (the UI history list).
  // getAllSessions() is unfiltered and still returns them; the in-memory
  // entry is short-lived because chatNew on a stale id no longer
  // materialises one, but a freshly-created manual session sits here until
  // its first message lands.
  return !isPinned(session) && session.messages.length === 0;
}

function isPinned(session: ChatSession): boolean {
  // Global is always pinned. Sessions restored from disk default to pinned
  // (they were persisted before, so the operator clearly wanted them kept).
  // Manual sessions default to ephemeral until pinned via chat.sessionPin.
  // Asymmetry: chatClear('global') is allowed (drops messages, keeps session
  // file), chatSessionDelete('global') is rejected (the shared chat is the
  // operator's home; we never let an action delete it from underneath them).
  if (session.pinned !== undefined) return session.pinned;
  return session.id === GLOBAL_SESSION_ID;
}

export function summarizeSession(session: ChatSession): ChatSessionSummary {
  const lastPreview = previewText(session.messages.at(-1));
  return {
    id: session.id,
    title: session.title ?? defaultSessionTitle(session.id),
    scope: inferSessionScope(session.id),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    pinned: isPinned(session),
    ...(lastPreview ? { lastPreview } : {}),
    ...(session.lastSavedAt ? { lastSavedAt: session.lastSavedAt } : {}),
  };
}

function restoreSession(session: ChatSession): ChatSession {
  // Sessions on disk pre-date the ephemeral flag. Treat any restored session
  // without an explicit pinned value as pinned=true — the operator persisted
  // it before, so we keep saving it.
  if (session.pinned === undefined) session.pinned = true;
  const existing = sessions.get(session.id);
  const restored = existing ? mergeSessionsByMessageId(session, existing) : session;
  sessions.set(session.id, restored);
  return restored;
}

async function writeSessionFile(filePath: string, session: ChatSession): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  await writeFile(tmpPath, JSON.stringify(session, null, 2), 'utf-8');
  await rename(tmpPath, filePath);
}

export function initChatStore(): void {
  // Load persisted sessions in background — don't block startup
  loadPersistedSessions().catch((err) => {
    console.error(`[chat-store] load error: ${errorMessage(err)}`);
  });
}

export async function loadPersistedSessions(): Promise<void> {
  const sessionsDir = path.join(getCopilotDir(), 'sessions');
  try {
    const files = await readdir(sessionsDir);
    const fileSet = new Set(files);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const filePath = path.join(sessionsDir, file);
        const content = await readFile(filePath, 'utf-8');
        const session: ChatSession = JSON.parse(content);
        session.id = normalizeSessionId(session.id);
        const canonicalFile = chatSessionFileName(session.id);
        const canonicalPath = path.join(sessionsDir, canonicalFile);
        if (file !== canonicalFile && fileSet.has(canonicalFile)) {
          const canonicalContent = await readFile(canonicalPath, 'utf-8');
          const canonicalSession: ChatSession = JSON.parse(canonicalContent);
          canonicalSession.id = normalizeSessionId(canonicalSession.id);
          const merged = restoreSession(mergeSessionsByMessageId(canonicalSession, session));
          await writeSessionFile(canonicalPath, merged);
          await unlink(filePath);
          console.log(
            `[chat-store] merged legacy duplicate session file ${file} into ${canonicalFile}`,
          );
          continue;
        }
        const restored = restoreSession(session);
        console.log(
          `[chat-store] restored session ${restored.id} (${restored.messages.length} msgs)`,
        );
        if (file !== canonicalFile) {
          try {
            await writeSessionFile(canonicalPath, restored);
            await unlink(filePath);
            console.log(
              `[chat-store] canonicalized legacy session file ${file} -> ${canonicalFile}`,
            );
          } catch (err) {
            // The in-memory session is already usable; retry canonicalization on the next startup.
            console.warn(
              `[chat-store] failed to canonicalize legacy session file ${file} -> ${canonicalFile}: ${errorMessage(err)}`,
            );
          }
        }
      } catch (err) {
        // Corrupt or unsafe session files should not block gateway startup.
        console.warn(`[chat-store] skipped session file ${file}: ${errorMessage(err)}`);
      }
    }
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return;
    throw err;
  }
}

export function normalizeSessionId(sessionId?: string): string {
  const id = (sessionId ?? GLOBAL_SESSION_ID).trim();
  if (!id || id === LEGACY_DEFAULT_SESSION_ID) return GLOBAL_SESSION_ID;
  if (id.length > SESSION_ID_MAX_LENGTH)
    throw new Error(`Invalid chat session ID: exceeds ${SESSION_ID_MAX_LENGTH} characters`);
  // Dot is allowed for semver-ish/manual IDs; separators are filename-encoded before persistence.
  if (!SESSION_ID_RE.test(id)) throw new Error(`Invalid chat session ID: ${id}`);
  return id;
}

export function chatSessionFileName(sessionId: string): string {
  return `${encodeURIComponent(normalizeSessionId(sessionId))}.json`;
}

export function getOrCreateSession(sessionId?: string): ChatSession {
  const id = normalizeSessionId(sessionId);
  let session = sessions.get(id);
  if (!session) {
    const now = new Date().toISOString();
    // Global is the always-on shared chat — pinned. Other implicit sessions
    // (run:/family:/slot:) only exist if persisted on disk before; new ones
    // start ephemeral.
    session = {
      id,
      title: defaultSessionTitle(id),
      messages: [],
      createdAt: now,
      updatedAt: now,
      pinned: id === GLOBAL_SESSION_ID,
    };
    sessions.set(id, session);
  }
  return session;
}

const MAX_SESSION_TITLE_LENGTH = 200;

export function createChatSession(
  params: { sessionId?: string; title?: string; pinned?: boolean } = {},
): ChatSession {
  const id = normalizeSessionId(params.sessionId ?? `manual:${randomUUID()}`);
  const existing = sessions.get(id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const trimmed = params.title?.trim();
  const session: ChatSession = {
    id,
    title: trimmed ? trimmed.slice(0, MAX_SESSION_TITLE_LENGTH) : defaultSessionTitle(id),
    messages: [],
    createdAt: now,
    updatedAt: now,
    pinned: params.pinned ?? false,
  };
  sessions.set(id, session);
  return session;
}

export function getSession(sessionId?: string): ChatSession | null {
  return sessions.get(normalizeSessionId(sessionId)) ?? null;
}

export function appendMessage(sessionId: string | undefined, message: ChatMessage): void {
  const session = getOrCreateSession(sessionId);
  if (message.role === 'user' && !session.messages.some((item) => item.role === 'user')) {
    session.title = titleFromPrompt(message.content);
  }
  session.messages.push(message);
  session.updatedAt = new Date().toISOString();
  schedulePersist(session.id);
}

export function clearSession(sessionId?: string): void {
  const id = normalizeSessionId(sessionId);
  const existing = sessions.get(id);
  if (existing) {
    const now = new Date().toISOString();
    existing.messages = [];
    existing.updatedAt = now;
    schedulePersist(id);
  }
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  const id = normalizeSessionId(sessionId);
  // Store-layer guard so any caller (RPC handler, run-engine cleanup, fixture
  // seeder, future internal callsite) is protected, not just methods/chat.ts.
  if (id === GLOBAL_SESSION_ID) {
    throw new Error('Cannot delete the shared global chat session');
  }
  const existed = sessions.delete(id);
  const timer = persistTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    persistTimers.delete(id);
  }
  const filePath = path.join(getCopilotDir(), 'sessions', chatSessionFileName(id));
  try {
    await unlink(filePath);
    return true;
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) return existed;
    throw err;
  }
}

export async function deleteSessions(sessionIds: string[]): Promise<number> {
  // Mirror deleteSession: refuse the whole batch atomically if it includes
  // global. Filtering would silently drop the operator's intent.
  const ids = sessionIds.map((id) => normalizeSessionId(id));
  if (ids.includes(GLOBAL_SESSION_ID)) {
    throw new Error('Cannot delete the shared global chat session');
  }
  let count = 0;
  for (const id of ids) {
    if (await deleteSession(id)) count += 1;
  }
  return count;
}

export async function pinSession(sessionId: string): Promise<ChatSession | null> {
  const id = normalizeSessionId(sessionId);
  const session = sessions.get(id);
  if (!session) return null;
  if (session.pinned !== true) {
    session.pinned = true;
    session.updatedAt = new Date().toISOString();
  }
  await persistSession(id);
  return session;
}

export function markSessionSaved(sessionId?: string, savedPath?: string): void {
  const id = normalizeSessionId(sessionId);
  const session = sessions.get(id);
  if (session) {
    session.lastSavedAt = new Date().toISOString();
    void savedPath; // path info is in the event, no need to store
    schedulePersist(id);
  }
}

export function getAllSessions(): ChatSession[] {
  return [...sessions.values()];
}

export function listSessionSummaries(): ChatSessionSummary[] {
  return getAllSessions()
    .filter((session) => !isEmptyEphemeralSession(session))
    .map(summarizeSession)
    .sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt));
}

export function getSessionMessages(sessionId?: string, limit?: number): ChatMessage[] {
  const session = getSession(sessionId);
  if (!session) return [];
  const msgs = session.messages;
  return limit ? msgs.slice(-limit) : msgs;
}

function schedulePersist(sessionId: string): void {
  // Normalize at entry so persistTimers always indexes by the canonical id.
  // deleteSession() clears by canonical id; without normalization here a
  // schedule under e.g. 'Default' could survive a delete under 'default'
  // and resurrect the file post-unlink.
  const id = normalizeSessionId(sessionId);
  const session = sessions.get(id);
  // Ephemeral sessions live in memory only. Pinning a session triggers an
  // immediate persist via pinSession(), bypassing the debounce.
  if (!session || !isPinned(session)) return;
  const existing = persistTimers.get(id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    persistTimers.delete(id);
    persistSession(id).catch((err) => {
      console.error(`[chat-store] persist error: ${errorMessage(err)}`);
    });
  }, PERSIST_DEBOUNCE_MS);
  persistTimers.set(id, timer);
}

async function persistSession(sessionId: string): Promise<void> {
  const id = normalizeSessionId(sessionId);
  const session = sessions.get(id);
  if (!session) return;
  if (!isPinned(session)) return;
  const sessionsDir = path.join(getCopilotDir(), 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, chatSessionFileName(id));
  await writeSessionFile(filePath, session);
}

export function generateMessageId(): string {
  return randomUUID();
}
