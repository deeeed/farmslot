import DOMPurify from 'dompurify';
import { Marked, marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

export function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(raw);
}

// A chat message is text: a tag written in it is shown, never rendered.
const chatMarked = new Marked({
  breaks: true,
  gfm: true,
  renderer: {
    html: ({ text }) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  },
});

/** Chat message markdown before sanitizing: lists, links, code and tables; raw HTML stays text. */
export function chatMarkdownHtml(md: string): string {
  return chatMarked.parse(md, { async: false }) as string;
}

export function renderChatMarkdown(md: string): string {
  return DOMPurify.sanitize(chatMarkdownHtml(md));
}

export type MdFetchEntry<T> =
  | { status: 'loading' }
  | { status: 'ok'; data: T }
  | { status: 'err'; error?: string };

export function putCapped<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  if (!map.has(key) && map.size >= limit) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}
