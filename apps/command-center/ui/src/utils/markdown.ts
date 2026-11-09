import DOMPurify from 'dompurify';
import { Marked, marked, Renderer, type Token, type TokensList } from 'marked';

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

// A chat link opens beside Command Center instead of replacing the conversation.
const NEW_TAB = 'target="_blank" rel="noopener noreferrer"';

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
    link(token) {
      return Renderer.prototype.link.call(this, token).replace(/^<a /, `<a ${NEW_TAB} `);
    },
    html: ({ text, block }) =>
      block ? `<p>${escapeText(text.trimEnd()).replace(/\n/g, '<br>')}</p>` : escapeText(text),
    image: (token) =>
      'inLink' in token
        ? token.text.trim()
          ? token.text
          : escapeText(String(token.inLink))
        : `<a ${NEW_TAB} href="${escapeText(token.href)}">${token.text || escapeText(token.href)}</a>`,
  },
});

/** Chat message markdown before sanitizing: lists, links, code and tables; raw HTML stays text. */
export function chatMarkdownHtml(md: string): string {
  return chatMarked.parse(md, { async: false }) as string;
}

const sanitizeChat = (html: string) => DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });

/** Rendered, sanitized top-level blocks by link definitions, type and source; least recent out. */
const chatBlocks = new Map<string, string>();
const CHAT_BLOCK_LIMIT = 500;

/**
 * Chat message markdown, sanitized. The message is lexed whole, so every block is split where a
 * full parse splits it, then each top-level block is rendered and sanitized once: a streamed
 * delta re-renders only the block it extends. A block's key carries the message's link
 * definitions, so a definition arriving later re-renders the reference links that use it.
 */
export function renderChatMarkdown(md: string): string {
  const tokens: TokensList = chatMarked.lexer(md);
  // The parser joins adjacent top-level text tokens into one paragraph; those cannot be split.
  if (tokens.some((token) => token.type === 'text')) return sanitizeChat(chatMarkdownHtml(md));
  const links = Object.keys(tokens.links).length ? JSON.stringify(tokens.links) : '';
  const walk = chatMarked.defaults.walkTokens;
  let html = '';
  for (const token of tokens) {
    const key = `${links}\0${token.type}\0${token.raw}`;
    let block = chatBlocks.get(key);
    if (block === undefined) {
      if (walk) chatMarked.walkTokens([token], walk);
      const rendered = chatMarked.parser([token]);
      block = rendered && sanitizeChat(rendered);
    } else chatBlocks.delete(key);
    putCapped(chatBlocks, key, block, CHAT_BLOCK_LIMIT);
    html += block;
  }
  return html;
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
