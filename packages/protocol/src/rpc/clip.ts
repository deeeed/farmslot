// clip.push / clip.list: copy-ready snippets agents hand the farm's admins.

import { textLinkParts } from '../client-cache/text-links.js';

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

/**
 * The URL of a link clip, or undefined unless `text` is exactly one http(s) address as
 * `textLinkParts` reads it (so other schemes, such as javascript: or file:, are never links).
 */
export function clipLinkUrl(text: string): URL | undefined {
  const trimmed = text.trim();
  const parts = textLinkParts(trimmed);
  if (parts.length !== 1 || parts[0].href !== trimmed) return undefined;
  try {
    return new URL(trimmed);
  } catch {
    // textLinkParts admits a few strings URL rejects (e.g. a bad port); those are plain text.
    return undefined;
  }
}
