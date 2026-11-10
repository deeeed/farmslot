import { type DocumentBlock, formatDocument } from './document-format';

export type DocumentFormatter = (title: string, body: string) => readonly DocumentBlock[];

/**
 * `formatDocument` that keeps the blocks of its last `limit` documents, so a re-rendered card
 * reuses its parse instead of reading the markdown again. Blocks are shared: never mutate them.
 */
export function documentFormatCache(limit: number): DocumentFormatter {
  const kept = new Map<string, readonly DocumentBlock[]>();
  return (title, body) => {
    const key = `${title}\0${body}`;
    const hit = kept.get(key);
    if (hit) {
      // Most recently used last: the first key is the one to evict.
      kept.delete(key);
      kept.set(key, hit);
      return hit;
    }
    const blocks = formatDocument(title, body);
    kept.set(key, blocks);
    const oldest = kept.keys().next();
    if (kept.size > limit && !oldest.done) kept.delete(oldest.value);
    return blocks;
  };
}

/** Shared by the conversation's plan cards. */
export const formatDocumentCached = documentFormatCache(32);
