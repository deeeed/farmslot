const all = (root) =>
  [...root.querySelectorAll('*')].flatMap((e) => (e.shadowRoot ? [e, ...all(e.shadowRoot)] : [e]));
const renderedText = (node) => {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node instanceof Element && node.matches('style,script,template')) return '';
  return [...(node.shadowRoot ?? node).childNodes].map(renderedText).join('');
};
const elements = all(document);
const detail = elements.find((e) => e.matches('run-detail'));
const views = detail?.shadowRoot
  ? all(detail.shadowRoot).filter((e) => e.matches('native-session-view'))
  : [];
const root = views[0]?.shadowRoot;
const status = root?.querySelector('[data-testid="native-read-status"]');
const toggle = detail?.shadowRoot?.querySelector('[data-testid="run-native-history-toggle"]');
return {
  timeOrigin: performance.timeOrigin,
  runLoaded: Boolean(detail?.run?.id === 'layout-run'),
  views: views.length,
  expanded: toggle ? toggle.getAttribute('aria-expanded') === 'true' : undefined,
  status: root?.querySelector('.status')?.textContent.trim() ?? '',
  readState: status?.dataset.state,
  statusHeight: status?.getBoundingClientRect().height,
  statusVisible: Boolean(
    status &&
    status.getBoundingClientRect().top >= 0 &&
    status.getBoundingClientRect().bottom <= innerHeight,
  ),
  observedAt: root?.querySelector('[data-observed-at]')?.getAttribute('data-observed-at'),
  age: root?.querySelector('[data-observed-at]')?.textContent.trim() ?? '',
  timelineTop: root?.querySelector('.timeline')?.getBoundingClientRect().top,
  history: root?.querySelector('.timeline') ? renderedText(root.querySelector('.timeline')) : '',
  retry: Boolean(root?.querySelector('[data-testid="native-refresh"]')),
  inputDisabled: root?.querySelector('textarea')?.disabled,
  errors: [...(root?.querySelectorAll('[role="alert"]') ?? [])].map((e) => e.textContent.trim()),
};
