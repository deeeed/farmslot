// Light-DOM editors inside a shadow host need their document styles copied
// into that host. Production bundling can combine them under a hashed filename.

const adopted = new Map<ShadowRoot, Set<string>>();

export function adoptDocumentCss(
  el: HTMLElement,
  filter: (href: string, text: string) => boolean,
  filterKey?: string,
): void {
  const root = el.getRootNode();
  if (!(root instanceof ShadowRoot)) return;

  const key = filterKey ?? filter.toString().slice(0, 50);
  const keys = adopted.get(root) ?? new Set<string>();
  if (keys.has(key)) return;
  let copied = false;

  for (const sheet of document.styleSheets) {
    const href = sheet.href ?? '';
    const owner = sheet.ownerNode as HTMLElement | null;
    let text = owner?.textContent ?? '';
    if (!filter(href, text)) {
      if (!href) continue;
      try {
        // Linked production CSS has no owner text or stable library filename.
        text = Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
      } catch (error) {
        // Cross-origin stylesheets cannot be inspected through CSSOM.
        if (error instanceof DOMException && error.name === 'SecurityError') continue;
        throw error;
      }
      if (!filter(href, text)) continue;
    }

    if (sheet.href) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      root.appendChild(link);
      copied = true;
    } else if (owner?.tagName === 'STYLE') {
      const style = document.createElement('style');
      style.textContent = text;
      root.appendChild(style);
      copied = true;
    }
  }
  // A later editor in this host can retry if its lazy stylesheet was absent.
  if (copied) {
    keys.add(key);
    adopted.set(root, keys);
  }
}
