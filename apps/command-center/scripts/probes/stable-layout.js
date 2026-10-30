// Read-only DOM geometry and current presentation, including unopened tray items.
const app = document.querySelector('farm-app');
const root = app?.shadowRoot ?? app;
const tray = root?.querySelector('farm-notification-tray');
const trayRoot = tray?.shadowRoot;
const panel = trayRoot?.querySelector('.panel')?.getBoundingClientRect();
const content = root?.querySelector('.fa-content');
const list = root?.querySelector('run-list');
const row = list?.shadowRoot?.querySelector('[data-row-id="layout-run"]');
const banner = root?.querySelector('update-banner');
return {
  rowTop: row?.getBoundingClientRect().top,
  legacyReadStatus: [...(list?.shadowRoot?.querySelectorAll('.rehydrating-banner') ?? [])]
    .map((element) => element.textContent.trim())
    .join(' '),
  sidebarExpanded: root?.querySelector('.fa-nav-toggle')?.title === 'Collapse sidebar',
  sidebarAnimating: root
    ?.querySelector('nav')
    ?.getAnimations()
    .some((animation) => animation.playState === 'running'),
  updateVisible: Boolean(banner?.getClientRects().length),
  updateText: (banner?.shadowRoot?.textContent ?? '').replace(/\s+/g, ' '),

  width: innerWidth,
  visibility: document.visibilityState,
  app: Boolean(app),
  visible: document.body.innerText.slice(0, 1000),
  connected: root?.querySelector('fleet-summary-bar')?.connection === 'connected',
  stripHeight: tray?.getBoundingClientRect().height,
  contentTop: content?.getBoundingClientRect().top,
  top: trayRoot?.querySelector('.attention')?.textContent.trim() ?? '',
  items: tray?.items?.map((item) => item.title) ?? [],
  panel: panel ? { left: panel.left, right: panel.right, height: panel.height } : null,
};
