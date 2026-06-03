// shadow-css.ts — Adopt document-level CSS into shadow roots
// Light DOM components (createRenderRoot => this) that use external CSS
// (Monaco, diff2html) break when placed inside a shadow DOM host.
// This helper copies matching stylesheets into the shadow root.

// Track which (shadowRoot, filterKey) pairs have been adopted
const adopted = new Map<ShadowRoot, Set<string>>();

/** Copy document-level stylesheets matching `filter` into the shadow root
 *  that contains `el`. No-op if `el` is in light DOM or already adopted
 *  for this filterKey. */
export function adoptDocumentCss(
  el: HTMLElement,
  filter: (href: string, text: string) => boolean,
  filterKey?: string,
): void {
  const root = el.getRootNode();
  if (!(root instanceof ShadowRoot)) return;

  const key = filterKey ?? filter.toString().slice(0, 50);
  let keys = adopted.get(root);
  if (keys?.has(key)) return;
  if (!keys) {
    keys = new Set();
    adopted.set(root, keys);
  }
  keys.add(key);

  for (const sheet of document.styleSheets) {
    try {
      const href = sheet.href ?? '';
      const owner = sheet.ownerNode as HTMLElement | null;
      const text = owner?.textContent ?? '';
      if (!filter(href, text)) continue;

      if (sheet.href) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        root.appendChild(link);
      } else if (owner?.tagName === 'STYLE') {
        const style = document.createElement('style');
        style.textContent = text;
        root.appendChild(style);
      }
    } catch {
      /* CORS — skip */
    }
  }
}
