import type { TmuxWorkerRef } from '@farmslot/protocol';

/** Unsent terminal drafts, one per tmux pane. Older per-slot drafts are not read. */
export const VOICE_DRAFT_STORAGE_PREFIX = '@farmslot:terminal:draft:';

export interface PersistedVoiceDraft {
  pane: string;
  transcript: string;
  draft: string;
  updatedAt: string;
}

/** A pane keeps its draft whichever link opened it. */
export function voiceDraftPane(worker: Pick<TmuxWorkerRef, 'nodeId' | 'paneId' | 'target'>) {
  return `${worker.nodeId}:${worker.paneId ?? worker.target}`;
}

export function voiceDraftStorageKey(pane: string): string {
  return `${VOICE_DRAFT_STORAGE_PREFIX}${encodeURIComponent(pane)}`;
}

export function buildPersistedVoiceDraft({
  pane,
  transcript,
  draft,
  now = new Date(),
}: {
  pane: string;
  transcript: string;
  draft: string;
  now?: Date;
}): PersistedVoiceDraft | null {
  const normalizedPane = pane.trim();
  const normalizedTranscript = transcript.trim();
  const normalizedDraft = draft.trim();
  if (!normalizedPane || (!normalizedTranscript && !normalizedDraft)) return null;
  return {
    pane: normalizedPane,
    transcript: normalizedTranscript,
    draft: normalizedDraft,
    updatedAt: now.toISOString(),
  };
}

export function parsePersistedVoiceDraft(
  raw: string | null,
  expectedPane: string,
): PersistedVoiceDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedVoiceDraft> | null;
    if (!parsed || parsed.pane !== expectedPane) return null;
    return buildPersistedVoiceDraft({
      pane: parsed.pane,
      transcript: typeof parsed.transcript === 'string' ? parsed.transcript : '',
      draft: typeof parsed.draft === 'string' ? parsed.draft : '',
      now: parsePersistedDate(parsed.updatedAt),
    });
  } catch {
    // Draft persistence is a convenience layer; malformed AsyncStorage should not
    // block the terminal. Returning null lets the caller replace it on next edit.
    return null;
  }
}

function parsePersistedDate(value: unknown): Date {
  if (typeof value !== 'string') return new Date(0);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}
