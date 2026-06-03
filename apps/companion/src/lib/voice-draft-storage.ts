export const VOICE_DRAFT_STORAGE_PREFIX = '@farmslot:voiceCopilot:draft:';

export interface PersistedVoiceDraft {
  slotId: string;
  transcript: string;
  draft: string;
  updatedAt: string;
}

export function voiceDraftStorageKey(slotId: string): string {
  return `${VOICE_DRAFT_STORAGE_PREFIX}${encodeURIComponent(slotId)}`;
}

export function buildPersistedVoiceDraft({
  slotId,
  transcript,
  draft,
  now = new Date(),
}: {
  slotId: string;
  transcript: string;
  draft: string;
  now?: Date;
}): PersistedVoiceDraft | null {
  const normalizedSlotId = slotId.trim();
  const normalizedTranscript = transcript.trim();
  const normalizedDraft = draft.trim();
  if (!normalizedSlotId || (!normalizedTranscript && !normalizedDraft)) return null;
  return {
    slotId: normalizedSlotId,
    transcript: normalizedTranscript,
    draft: normalizedDraft,
    updatedAt: now.toISOString(),
  };
}

export function parsePersistedVoiceDraft(
  raw: string | null,
  expectedSlotId: string,
): PersistedVoiceDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedVoiceDraft> | null;
    if (!parsed || parsed.slotId !== expectedSlotId) return null;
    return buildPersistedVoiceDraft({
      slotId: parsed.slotId,
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
