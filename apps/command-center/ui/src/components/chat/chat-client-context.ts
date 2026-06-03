import { buildCommandCenterContext, type ChatClientContext } from '@farmslot/protocol';

export { deriveChatSessionId } from '@farmslot/protocol';

interface BrowserLocationSnapshot {
  hash?: string;
  href?: string;
}

interface BrowserQueryableLike {
  textContent?: string | null;
  querySelectorAll?: (selector: string) => Iterable<unknown> | ArrayLike<unknown>;
}

interface BrowserElementLike extends BrowserQueryableLike {
  tagName: string;
  offsetWidth?: number;
  offsetHeight?: number;
  getClientRects?: () => { length: number };
  getAttribute?: (name: string) => string | null;
}

interface BrowserDocumentLike {
  body?: BrowserElementLike;
  querySelector?: (selector: string) => BrowserElementLike | null;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function uniqueLimited(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function browserLocation(): BrowserLocationSnapshot | undefined {
  const value = Reflect.get(globalThis, 'location');
  if (!value || typeof value !== 'object') return undefined;
  const hash = Reflect.get(value, 'hash');
  const href = Reflect.get(value, 'href');
  return {
    ...(typeof hash === 'string' ? { hash } : {}),
    ...(typeof href === 'string' ? { href } : {}),
  };
}

function isElementLike(value: unknown): value is BrowserElementLike {
  return !!value && typeof value === 'object' && typeof Reflect.get(value, 'tagName') === 'string';
}

function isQueryableLike(value: unknown): value is BrowserQueryableLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'querySelectorAll') === 'function'
  );
}

function browserDocument(): BrowserDocumentLike | undefined {
  const value = Reflect.get(globalThis, 'document');
  if (!value || typeof value !== 'object') return undefined;
  const querySelector = Reflect.get(value, 'querySelector');
  const body = Reflect.get(value, 'body');
  return {
    ...(typeof querySelector === 'function' ? { querySelector: querySelector.bind(value) } : {}),
    ...(isElementLike(body) ? { body } : {}),
  };
}

function queryAll(root: BrowserQueryableLike, selector: string): BrowserElementLike[] {
  const result = root.querySelectorAll?.(selector);
  if (!result) return [];
  return Array.from(result).filter(isElementLike);
}

function queryAllDeep(root: BrowserQueryableLike, selector: string): BrowserElementLike[] {
  const direct = queryAll(root, selector);
  const nested: BrowserElementLike[] = [];
  for (const el of direct) {
    const shadowRoot = Reflect.get(el, 'shadowRoot');
    if (isQueryableLike(shadowRoot)) nested.push(...queryAllDeep(shadowRoot, selector));
  }
  return [...direct, ...nested];
}

function elementIsVisible(el: BrowserElementLike): boolean {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects?.().length);
}

function collectVisibleScreenHints(): Pick<
  ChatClientContext,
  'visibleElementTags' | 'visibleTextSnippets' | 'visibleControls'
> {
  const doc = browserDocument();
  if (!doc) return {};

  const root =
    doc.querySelector?.('farm-app .fa-content') ?? doc.querySelector?.('.fa-content') ?? doc.body;
  if (!root) return {};

  const visibleElements = queryAllDeep(root, '*').filter(elementIsVisible);

  const visibleElementTags = uniqueLimited(
    visibleElements.map((el) => el.tagName.toLowerCase()).filter((tag) => tag.includes('-')),
    12,
  );

  const semanticTextSelectors = [
    'h1',
    'h2',
    'h3',
    '[role="heading"]',
    '[class*="title"]',
    '[class*="label"]',
    '[class*="count"]',
    '[class*="banner"]',
  ].join(',');
  const semanticText = queryAllDeep(root, semanticTextSelectors)
    .map((el) => normalizeText(el.textContent))
    .filter((text) => text.length >= 2)
    .map((text) => text.slice(0, 160));

  const rootText = normalizeText(
    [root.textContent, ...visibleElements.map((el) => el.textContent)].join(' '),
  );
  const visibleTextSnippets = uniqueLimited([...semanticText, rootText.slice(0, 240)], 10);

  const visibleControls = uniqueLimited(
    queryAllDeep(root, 'button, a, input, select, textarea, [role="button"], [role="tab"]')
      .filter(elementIsVisible)
      .map((el) => {
        const label = normalizeText(
          el.getAttribute?.('aria-label') ?? el.getAttribute?.('title') ?? el.textContent,
        );
        return label.slice(0, 120);
      }),
    10,
  );

  return {
    ...(visibleElementTags.length ? { visibleElementTags } : {}),
    ...(visibleTextSnippets.length ? { visibleTextSnippets } : {}),
    ...(visibleControls.length ? { visibleControls } : {}),
  };
}

function currentHash(): string {
  return browserLocation()?.hash || '#fleet';
}

function currentUrl(): string | undefined {
  return browserLocation()?.href;
}

export function buildChatClientContext(hashValue = currentHash()): ChatClientContext {
  return {
    ...buildCommandCenterContext(hashValue),
    ...(currentUrl() ? { url: currentUrl() } : {}),
    ...collectVisibleScreenHints(),
  };
}
