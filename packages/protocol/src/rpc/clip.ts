// clip.push / clip.list: copy-ready snippets agents hand the farm's admins.

/** Largest clip text in UTF-8 bytes. */
export const CLIP_TEXT_MAX_BYTES = 64 * 1024;
export const CLIP_LABEL_MAX_LENGTH = 120;
export const CLIP_SOURCE_MAX_LENGTH = 120;
/** Clips the gateway keeps for the farm; older ones are dropped. */
export const CLIP_HISTORY_LIMIT = 20;

/** `link` clips hold exactly one http(s) URL in `text`. */
export type ClipKind = 'text' | 'link';

export interface Clip {
  id: string;
  kind: ClipKind;
  text: string;
  label?: string;
  /** The principal that pushed it. */
  principalId: string;
  /** The session that pushed it, e.g. a tmux session name. */
  source?: string;
  createdAt: string;
}

export interface ClipPushParams {
  text: string;
  kind?: ClipKind;
  label?: string;
  source?: string;
}

export interface ClipPushResult {
  clip: Clip;
}

/** Newest first. */
export interface ClipListResult {
  clips: Clip[];
}

/** The URL of a link clip, or undefined when `text` is not one http(s) URL. */
export function clipLinkUrl(text: string): URL | undefined {
  const trimmed = text.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return undefined;
  try {
    return new URL(trimmed);
  } catch {
    // The pattern admits strings URL rejects (e.g. a bad port); those are plain text.
    return undefined;
  }
}

export interface ClipTextPart {
  text: string;
  url?: string;
}

/** Splits clip text into plain runs and http(s) URLs so clients can render tappable links. */
export function clipTextParts(text: string): ClipTextPart[] {
  const parts: ClipTextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) {
    const start = match.index;
    // Trailing sentence punctuation stays text.
    const url = match[0].replace(/[.,;:!?]+$/, '');
    if (start > last) parts.push({ text: text.slice(last, start) });
    if (clipLinkUrl(url)) parts.push({ text: url, url });
    else parts.push({ text: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
