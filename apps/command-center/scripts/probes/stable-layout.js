// Read-only DOM geometry and current presentation, including unopened tray items.
const app = document.querySelector('farm-app');
const root = app?.shadowRoot ?? app;
const tray = root?.querySelector('farm-notification-tray');
const trayRoot = tray?.shadowRoot;
const panel = trayRoot?.querySelector('.panel')?.getBoundingClientRect();
const content = root?.querySelector('.fa-content');
return {
  width: innerWidth,
  app: Boolean(app),
  visible: document.body.innerText.slice(0, 1000),
  connected: root?.querySelector('fleet-summary-bar')?.connection === 'connected',
  stripHeight: tray?.getBoundingClientRect().height,
  contentTop: content?.getBoundingClientRect().top,
  top: trayRoot?.querySelector('.attention')?.textContent.trim() ?? '',
  items: tray?.items?.map((item) => item.title) ?? [],
  panel: panel ? { left: panel.left, right: panel.right, height: panel.height } : null,
};
