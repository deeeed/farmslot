// Read-only inspection of the actual mounted panels and their canonical observations.
function findPanel(root) {
  const panel = root.querySelector(
    'backlog-panel,roadmap-panel,work-graph-panel,dispatch-queue-panel',
  );
  if (panel) return panel;
  for (const node of root.querySelectorAll('*'))
    if (node.shadowRoot) {
      const nested = findPanel(node.shadowRoot);
      if (nested) return nested;
    }
}
const panel = findPanel(document);
if (!panel?.shadowRoot) return { mounted: false, hash: location.hash };
const moduleUrl = (pathname) =>
  performance
    .getEntriesByType('resource')
    .map(({ name }) => name)
    .filter((name) => new URL(name).pathname === pathname)
    .at(-1);
const ownerUrl = moduleUrl('/src/resource-cache.ts');
const gatewayUrl = moduleUrl('/src/gateway-client.ts');
if (!ownerUrl || !gatewayUrl) return { mounted: true, ownerLoaded: false };
const { getResourceCache } = await import(ownerUrl);
const { gateway } = await import(gatewayUrl);
const cache = getResourceCache();
const fields = {
  'backlog-panel': ['_backlogQuery', '_graphsQuery'],
  'roadmap-panel': ['_listQuery', '_detailQuery'],
  'work-graph-panel': ['graphQuery', 'backlogQuery', 'queueQuery'],
  'dispatch-queue-panel': ['_queueQuery', '_backlogQuery', '_graphsQuery'],
};
const observations = {};
for (const field of fields[panel.localName]) {
  const controller = Reflect.get(panel, field);
  const query = controller && Reflect.get(controller, 'query');
  if (!query) continue;
  const state = controller.state;
  if (controller.belongsToWorkspace && cache?.read(query) !== state)
    throw Error('Panel is not displaying its canonical planning observation');
  const data = state.data;
  const rows = data?.items ?? data?.graphs ?? [];
  observations[query.method] = {
    id: query.id,
    params: query.params,
    status: state.status,
    observedAt: state.observedAt,
    resourceState: state.resourceState,
    error: state.error?.message,
    ready: controller.ready,
    dataPresent: data !== undefined,
    rows: rows.map((row) => ({
      id: row.id ?? row.graph?.id,
      title: row.title ?? row.graph?.title,
      status: row.status ?? row.graph?.status,
      project: row.project ?? row.graph?.project,
      priority: row.priority,
      fileHash: row.fileHash,
      nodeIds: row.nodes?.map((node) => node.id),
    })),
  };
}
const root = panel.shadowRoot;
const renderedRows = [...root.querySelectorAll('[data-row-id]')]
  .filter((row) => row.getClientRects().length)
  .map((row) => ({ id: row.getAttribute('data-row-id'), text: row.textContent }));
const selectors = {
  'backlog-panel': 'button.primary-action',
  'roadmap-panel':
    '[data-testid="roadmap-save"],[data-testid="roadmap-create"],[data-testid="roadmap-delete"],[data-testid="roadmap-promote"]',
  'work-graph-panel': 'button.primary-action',
  'dispatch-queue-panel': 'button',
};
const mutationButtons = [...root.querySelectorAll(selectors[panel.localName])]
  .filter((button) => button.getClientRects().length && button.textContent.trim() !== 'Retry')
  .map((button) => ({ text: button.textContent.trim(), disabled: button.disabled }));
const viewportVisible = (element) => {
  if (!element?.getClientRects().length) return false;
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < innerHeight &&
    rect.left < innerWidth
  );
};
const graphNode = root.querySelector('[data-testid="work-graph-diagram-node-reference-proof"]');
const graphStatus = root.querySelector('.graph-head .badges .badge');
const queueRows = [...root.querySelectorAll('.queue-shell .rows > .row')].map((element, index) => ({
  index,
  text: element.textContent,
  priority: element.querySelector('input.priority')?.value,
  viewportVisible: viewportVisible(element),
}));
return {
  mounted: true,
  panel: panel.localName,
  hash: location.hash,
  connection: gateway.connectionState,
  connectionId: gateway.resourceConnectionId,
  principalId: gateway.authenticatedPrincipalId,
  observations,
  renderedRows,
  graphNode: graphNode && { text: graphNode.textContent, rendered: viewportVisible(graphNode) },
  graphStatus: graphStatus?.textContent.trim(),
  queueRows,
  mutationButtons,
  selectedId:
    Reflect.get(panel, '_selectedItemId') ??
    Reflect.get(panel, '_selectedId') ??
    Reflect.get(panel, 'selectedGraphId'),
  selectedNode: Reflect.get(panel, 'selectedNodeKey'),
  editorHash: Reflect.get(panel, '_editHash'),
  editorBody: root.querySelector('[data-testid="roadmap-edit-body"]')?.value,
  editorTitle: root.querySelector('[data-testid="roadmap-edit-title"]')?.value,
  staleText: [...root.querySelectorAll('[data-testid$="-stale"]')]
    .map((node) => node.textContent)
    .join('\n'),
  errorText: [
    ...root.querySelectorAll('[data-testid$="-read-error"],[data-testid="roadmap-detail-error"]'),
  ]
    .map((node) => node.textContent)
    .join('\n'),
};
