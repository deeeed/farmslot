import DOMPurify from 'dompurify';
import { Marked, marked, type Token } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

export function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(raw);
}

const escapeText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// An image anywhere inside a link (a badge, or one wrapped in emphasis) is that link's text.
// `fallback` is the link's URL when nothing else in it would show, else empty.
const markLinkedImages = (tokens: Token[] | undefined, fallback: string) => {
  for (const child of tokens ?? []) {
    if (child.type === 'image') Object.assign(child, { inLink: fallback });
    else if ('tokens' in child) markLinkedImages(child.tokens, fallback);
  }
};

const showsText = (tokens: Token[] | undefined): boolean =>
  (tokens ?? []).some((child) =>
    child.type === 'image'
      ? Boolean(child.text.trim())
      : 'tokens' in child && child.tokens
        ? showsText(child.tokens)
        : 'text' in child && Boolean(String(child.text).trim()),
  );

// A chat message is text: a tag written in it is shown, never rendered, and keeps its lines.
// An image is a link: model output must not make the page fetch a URL it chose. An image
// inside a link is that link's text, or the link's URL when it has no alt text, so the link
// stays visible. marked has already escaped an image's alt text.
const chatMarked = new Marked({
  breaks: true,
  gfm: true,
  walkTokens: (token) => {
    if (token.type === 'link')
      markLinkedImages(token.tokens, showsText(token.tokens) ? '' : token.href);
  },
  renderer: {
    html: ({ text, block }) =>
      block ? `<p>${escapeText(text.trimEnd()).replace(/\n/g, '<br>')}</p>` : escapeText(text),
    image: (token) =>
      'inLink' in token
        ? token.text.trim()
          ? token.text
          : escapeText(String(token.inLink))
        : `<a href="${escapeText(token.href)}">${token.text || escapeText(token.href)}</a>`,
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
