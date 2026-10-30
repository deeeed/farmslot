const app = document.querySelector('farm-app');
const detail = (app?.shadowRoot ?? app)?.querySelector('run-detail');
await detail?.updateComplete;
const root = detail?.shadowRoot;
const pipeline = root?.querySelector('run-pipeline');
await pipeline?.updateComplete;
await document.fonts.ready;
await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const panel = pipeline?.shadowRoot?.querySelector('[data-testid="acceptance-panel"]');
const error = panel?.querySelector('[data-testid="acceptance-error"]');
const content = (app?.shadowRoot ?? app)?.querySelector('.fa-content')?.getBoundingClientRect();
const visible = (element) => {
  const rect = element?.getBoundingClientRect();
  return Boolean(
    rect &&
    rect.height > 0 &&
    rect.top >= (content?.top ?? 0) &&
    rect.bottom <= Math.min(content?.bottom ?? innerHeight, innerHeight),
  );
};
return {
  width: innerWidth,
  runLoaded: /^ac-(before|after)-(1280|414)$/.test(detail?.run?.id ?? ''),
  sourceReady: Boolean(detail?.detailQuery?.ready),
  postureReady: detail?._postureStatus?.status === 'ready',
  sidebarAnimating:
    (app?.shadowRoot ?? app)
      ?.querySelector('nav')
      ?.getAnimations()
      .some((a) => a.playState === 'running') ?? false,
  taskFile: detail?.run?.taskFile,
  panel: Boolean(panel),
  panelVisible: visible(panel),
  errorVisible: visible(error),
  error: panel?.querySelector('[data-testid="acceptance-error"]')?.textContent.trim() ?? '',
  counts: panel?.querySelector('[data-testid="acceptance-counts"]')?.textContent.trim() ?? '',
  text: panel?.textContent.replace(/\s+/g, ' ').trim() ?? '',
  panelHeight: panel?.getBoundingClientRect().height,
  nextTop: root?.querySelector('[data-testid="run-terminal-toggle"]')?.getBoundingClientRect().top,
  pipelineTop: pipeline?.getBoundingClientRect().top,
  pipelineHeight: pipeline?.getBoundingClientRect().height,
  reservedHeight: pipeline?.shadowRoot?.querySelector('.acceptance-slot')?.getBoundingClientRect()
    .height,
};
