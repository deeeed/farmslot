// Read-only geometry and identity sampling. No application values are changed.
const list = document.querySelector('run-list');
const root = list?.shadowRoot;
const detail = root?.querySelector('run-detail') ?? document.querySelector('run-detail');
const detailRoot = detail?.shadowRoot;
const identityKey = Symbol.for('farmslot.run-detail-layout.measurement');
const identities = (globalThis[identityKey] ??= { nodes: new WeakMap(), next: 1 });
const regions = {};
const visibleRegions = {};
const viewport = list?.getBoundingClientRect() ?? {
  x: 0,
  y: 0,
  right: innerWidth,
  bottom: innerHeight,
};

const measure = (name, node) => {
  if (!node) return;
  const box = node.getBoundingClientRect();
  if (!box.width || !box.height) return;
  if (!identities.nodes.has(node)) identities.nodes.set(node, identities.next++);
  const left = Math.max(box.x, viewport.x, 0),
    top = Math.max(box.y, viewport.y, 0);
  const right = Math.min(box.right, viewport.right, innerWidth);
  const bottom = Math.min(box.bottom, viewport.bottom, innerHeight);
  if (right > left && bottom > top)
    visibleRegions[name] = {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      identity: identities.nodes.get(node),
    };
  regions[name] = {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    identity: identities.nodes.get(node),
  };
};
measure('run-list', list);
for (const selector of [
  '.header',
  '.toolbar',
  '.search-row',
  '.analytics-note',
  '.analytics-strip',
  '.work-inventory-layout',
  '.work-inventory-list',
  '.work-inventory-detail',
  '.run-detail-actions',
])
  measure('list ' + selector, root?.querySelector(selector));
measure('run-detail', detail);
for (const selector of [
  'source-status-panel',
  '.context-read-link',
  '.header',
  '.header-summary',
  '.meta',
  '.pipeline-section',
  '[data-testid="run-results"]',
  '[data-shared-run-panel="timeline"]',
])
  measure('detail ' + selector, detailRoot?.querySelector(selector));
const pipeline = detailRoot?.querySelector('run-pipeline');
for (const selector of ['.pipeline-svg', '.pipeline-status-row'])
  measure('pipeline ' + selector, pipeline?.shadowRoot?.querySelector(selector));
const checklist = pipeline?.shadowRoot?.querySelector('run-checklist-progress');
measure('checklist', checklist);

const boxes = (nodes) =>
  [...(nodes ?? [])].map((node) => ({
    tag: node.tagName,
    className: typeof node.className === 'string' ? node.className : 'svg',
    panel: node.getAttribute('data-panel'),
    height: node.getBoundingClientRect().height,
  }));
const onScreen = (node) => {
  const r = node.getBoundingClientRect();
  return (
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > viewport.y &&
    r.y < viewport.bottom &&
    r.right > viewport.x &&
    r.x < viewport.right
  );
};
const transientPresence = {
  loading: [...(detailRoot?.querySelectorAll('farm-hydrating, .rehydrating-banner') ?? [])].some(
    onScreen,
  ),
  savedProgress: [...(checklist?.shadowRoot?.querySelectorAll('.item') ?? [])].some(
    (node) => node.textContent.trim() === 'Saved progress' && onScreen(node),
  ),
  savedSource: [
    ...(detailRoot
      ?.querySelector('source-status-panel')
      ?.shadowRoot?.querySelectorAll('[data-testid="sources-stale"]') ?? []),
  ].some(onScreen),
};
return {
  pipelineRows: boxes(pipeline?.shadowRoot?.querySelector('.pipeline-wrap')?.children),
  pipelinePanels: boxes(pipeline?.shadowRoot?.querySelectorAll('section[data-panel]')),
  checklistRows: boxes(checklist?.shadowRoot?.children),
  canvasRows: boxes(pipeline?.querySelector('[slot="canvas-detail"]')?.children),
  progressNotice: pipeline?.taskProgressNotice?.kind,
  activityText: pipeline?.shadowRoot?.querySelector('.pipeline-activity')?.textContent?.trim(),
  at: performance.now(),
  documentState: document.readyState,
  visibility: document.visibilityState,
  connected: document.querySelector('farm-app')?.connection === 'connected',
  runId: detail?.runId,
  detailId: detail?.run?.id,
  standInId: detail?.standInRow?.id,
  hydrating: detail?._hydrating,
  directRefreshing: detail?._directRunRefreshing,
  connectionStale: detail?._connectionStale,
  scroll: {
    list: list?.scrollTop,
    detail: detail?.scrollTop,
    document: document.scrollingElement?.scrollTop,
  },
  regions,
  visibleRegions,
  transientPresence,
  listRows: [...(root?.children ?? [])].map((node) => ({
    tag: node.tagName,
    className: node.className,
    height: node.getBoundingClientRect().height,
  })),
  detailRows: [...(detailRoot?.children ?? [])].map((node) => ({
    tag: node.tagName,
    className: node.className,
    panel: node.getAttribute('data-shared-run-panel'),
    height: node.getBoundingClientRect().height,
  })),
};
