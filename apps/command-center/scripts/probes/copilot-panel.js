// Co-Pilot layout reachability at the current viewport: read-only measurements.
const box = (element) => {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
};
const overlaps = (a, b) =>
  Boolean(a && b && a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right);
const panel = document.querySelector('chat-panel');
const view = panel?.querySelector('native-session-view');
const approve = view?.shadowRoot?.querySelector('[data-testid="native-approve"]');
const content = box(document.querySelector('.fa-content'));
const approveBox = box(approve);
const centre = approveBox && {
  x: (approveBox.left + approveBox.right) / 2,
  y: (approveBox.top + approveBox.bottom) / 2,
};
// The operator must see what they approve: the request's title is visible, not only its button.
const title = approve?.closest('.request')?.querySelector('h3');
const titleBox = box(title);
const titleHit = Boolean(
  titleBox &&
  view.shadowRoot.elementFromPoint(
    (titleBox.left + titleBox.right) / 2,
    (titleBox.top + titleBox.bottom) / 2,
  ) === title,
);
const status = box(document.querySelector('farm-resource-store-notice'));
const transfers = box(document.querySelector('file-transfer-progress-banner'));
return {
  viewport: { width: innerWidth, height: innerHeight },
  settingsOpen: Boolean(panel?.querySelector('.copilot-settings')),
  approve: Boolean(approve),
  content,
  approveBox,
  panelScroll: panel && {
    top: panel.scrollTop,
    height: panel.scrollHeight,
    client: panel.clientHeight,
  },
  approveInsideContent: Boolean(
    content &&
    approveBox &&
    approveBox.top >= content.top &&
    approveBox.bottom <= content.bottom &&
    approveBox.bottom <= innerHeight,
  ),
  hitAtApprove:
    centre &&
    (() => {
      const hit = view.shadowRoot.elementFromPoint(centre.x, centre.y);
      return (
        hit &&
        `${hit.tagName.toLowerCase()}.${hit.className}:${hit.textContent.trim().slice(0, 30)}`
      );
    })(),
  clips: ['.conversation', '.timeline', '.composer', '.requests', '.request'].map((selector) => {
    const element = view?.shadowRoot?.querySelector(selector);
    return (
      element && {
        selector,
        ...box(element),
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }
    );
  }),
  titleBox,
  titleHit,
  approveHit: Boolean(
    centre && view.shadowRoot.elementFromPoint(centre.x, centre.y)?.closest('button') === approve,
  ),
  transferHeight: transfers ? transfers.bottom - transfers.top : 0,
  overlaysCoverContent: overlaps(status, content) || overlaps(transfers, content),
};
