import DOMPurify from 'dompurify';
import { Marked, marked, Renderer, type Token, type TokensList } from 'marked';

import { type FilePathPosition, formatFilePathPosition } from './t3/fileLinks.js';
import {
  inlineCodeFilePathCandidate,
  isMarkdownFileLinkLabel,
  parseMarkdownFileLink,
} from './t3/markdownLinks.js';
import { fileBasename } from './t3/path.js';
import { highlightedCodeHtml, highlightGeneration } from './code-highlight.js';

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
/** Options for chat markdown: `fileLinks` turns file paths into workspace file chips. */
export interface ChatMarkdownOptions {
  fileLinks?: boolean;
}

/**
 * A chip naming a workspace file, as T3 Code shows one: the basename and line, the full target in
 * its title. The chat view that shows it handles the click (`data-file-path`); elsewhere it is an
 * inert link.
 */
function fileChip(target: FilePathPosition, label: string): string {
  const position = `${target.line ? ` data-file-line="${target.line}"` : ''}${
    target.column ? ` data-file-column="${target.column}"` : ''
  }`;
  return `<a href="#" class="cm-file" data-file-path="${escapeText(target.path)}"${position} title="${escapeText(
    formatFilePathPosition(target),
  )}">${label}</a>`;
}

function fileChipLabel(target: FilePathPosition): string {
  return escapeText(
    [fileBasename(target.path), target.line ? `L${target.line}` : undefined]
      .filter(Boolean)
      .join(' · '),
  );
}

/**
 * A fenced code block in T3 Code's frame: the language, a wrap toggle and a copy button above
 * the highlighted code. Until the language's highlighter has loaded, the code shows as plain text.
 */
function codeBlock(text: string, fence: string | undefined): string {
  const language = fence?.trim().split(/\s+/)[0] ?? '';
  const body =
    highlightedCodeHtml(text, language || 'text') ?? `<pre><code>${escapeText(text)}</code></pre>`;
  return `<div class="cm-code" data-wrap="true"><div class="cm-code-head"><span class="cm-code-lang">${escapeText(
    language || 'text',
  )}</span><span class="cm-code-actions" role="toolbar" aria-label="Code block actions"><button type="button" data-code-action="wrap" aria-pressed="true" title="Wrap lines">Wrap</button><button type="button" data-code-action="copy" title="Copy code">Copy</button></span></div>${body}</div>`;
}

function createChatMarked({ fileLinks = false }: ChatMarkdownOptions): Marked {
  return new Marked({
    breaks: true,
    gfm: true,
    walkTokens: (token) => {
      if (token.type === 'link')
        markLinkedImages(token.tokens, showsText(token.tokens) ? '' : token.href);
    },
    renderer: {
      link(token) {
        const target = fileLinks ? parseMarkdownFileLink(token.href) : null;
        if (target) {
          const label = isMarkdownFileLinkLabel(token.text, token.href)
            ? fileChipLabel(target)
            : this.parser.parseInline(token.tokens);
          return fileChip(target, label);
        }
        return Renderer.prototype.link.call(this, token).replace(/^<a /, `<a ${NEW_TAB} `);
      },
      codespan(token) {
        const candidate = fileLinks ? inlineCodeFilePathCandidate(token.text) : null;
        const target = candidate === null ? null : parseMarkdownFileLink(candidate);
        return target
          ? fileChip(target, `<code>${token.text}</code>`)
          : `<code>${token.text}</code>`;
      },
      code: ({ text, lang }) => codeBlock(text, lang),
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
}

const chatMarked = createChatMarked({});
const fileLinkMarked = createChatMarked({ fileLinks: true });
const markedFor = (options: ChatMarkdownOptions) =>
  options.fileLinks ? fileLinkMarked : chatMarked;

/** Chat message markdown before sanitizing: lists, links, code and tables; raw HTML stays text. */
export function chatMarkdownHtml(md: string, options: ChatMarkdownOptions = {}): string {
  return markedFor(options).parse(md, { async: false }) as string;
}

const sanitizeChat = (html: string) => DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });

/**
 * Rendered, sanitized top-level blocks by options, highlighter generation, link definitions, type
 * and source; least recent out.
 */
const chatBlocks = new Map<string, string>();
const CHAT_BLOCK_LIMIT = 500;

/**
 * Chat message markdown, sanitized. The message is still lexed whole on every call (cheap next to
 * rendering), so every block is split where a full parse splits it. Each finished top-level block
 * is then rendered and sanitized once: a streamed delta re-renders only the last block. A block
 * that can hold a reference link keys on the message's link definitions, so a definition arriving
 * later re-renders the links that use it. A highlighter that finishes loading starts a new
 * generation, so blocks rendered as plain code render again highlighted.
 */
export function renderChatMarkdown(md: string, options: ChatMarkdownOptions = {}): string {
  const chat = markedFor(options);
  const tokens: TokensList = chat.lexer(md);
  if (tokens.some((token) => token.type === 'text'))
    return sanitizeChat(chatMarkdownHtml(md, options));
  const links = Object.keys(tokens.links).length ? JSON.stringify(tokens.links) : '';
  const walk = chat.defaults.walkTokens;
  const scope = options.fileLinks ? 'f' : '';
  const generation = highlightGeneration();
  let html = '';
  for (const [index, token] of tokens.entries()) {
    const tail = index === tokens.length - 1;
    // Only code (fenced, indented or nested in a list or quote) depends on the loaded highlighters.
    let code = false;
    chat.walkTokens([token], (child) => {
      code ||= child.type === 'code';
    });
    const key = `${scope}${code ? generation : ''}\0${token.raw.includes('[') ? links : ''}\0${token.type}\0${token.raw}`;
    let block = tail ? undefined : chatBlocks.get(key);
    if (block === undefined) {
      if (walk) chat.walkTokens([token], walk);
      const rendered = chat.parser([token]);
      block = rendered && sanitizeChat(rendered);
    } else chatBlocks.delete(key);
    if (!tail) putCapped(chatBlocks, key, block, CHAT_BLOCK_LIMIT);
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
