// Inspect only real mounted readers and their rendered output. Never change client state.
function find(root, tag) {
  const result = root.querySelector(tag);
  if (result) return result;
  for (const node of root.querySelectorAll('*'))
    if (node.shadowRoot) {
      const child = find(node.shadowRoot, tag);
      if (child) return child;
    }
}
const loaded = (suffix) =>
  performance
    .getEntriesByType('resource')
    .map(({ name }) => name)
    .filter((name) => new URL(name).pathname.endsWith(suffix))
    .at(-1);
const ownerUrl = loaded('/src/resource-cache.ts');
const gatewayUrl = loaded('/src/gateway-client.ts');
if (!ownerUrl || !gatewayUrl) return { loaded: false };
const { getResourceCache } = await import(ownerUrl);
const { gateway } = await import(gatewayUrl);
const cache = getResourceCache();
const observations = {};
function observation(controller) {
  const query = controller && Reflect.get(controller, 'query');
  if (!query) return;
  const state = controller.state;
  if (controller.belongsToWorkspace && cache.read(query) !== state)
    throw Error('Mounted domain reader does not display its canonical observation');
  observations[query.method] = {
    id: query.id,
    ready: controller.ready,
    persisted: query.persisted,
    status: state.status,
    observedAt: state.observedAt,
    error: state.error,
    resourceState: state.resourceState,
    data: state.data,
  };
}
const pr = find(document, 'pr-automation-panel');
const assessment = find(document, 'assessment-panel');
const analytics = find(document, 'analytics-panel');
const chat = find(document, 'chat-panel');
const effortControl = chat && find(chat, '[data-testid="review-dispatch-effort"]');
if (pr) {
  const owner = Reflect.get(pr, 'controller');
  for (const key of ['watchResources', 'ruleResources', 'pushResources'])
    observation(Reflect.get(owner, key));
}
if (assessment) observation(Reflect.get(assessment, 'assessmentSummary'));
if (analytics) observation(Reflect.get(analytics, 'query'));
if (chat) for (const field of ['runtimeQuery', 'usageQuery']) observation(Reflect.get(chat, field));
const visibleText = (panel) => panel && (panel.shadowRoot ?? panel).textContent;
const visible = (element) => Boolean(element && element.getClientRects().length);
return {
  loaded: true,
  connection: gateway.connectionState,
  connectionId: gateway.resourceConnectionId,
  timeOrigin: performance.timeOrigin,
  observedAt: Date.now(),
  principalId: gateway.authenticatedPrincipalId,
  observations,
  pr: pr && {
    text: visibleText(pr),
    connected: Reflect.get(pr, 'controller').connected,
    ruleControls: [
      ...pr.shadowRoot.querySelectorAll(
        '[data-testid="pr-rule-edit"],[data-testid="pr-rule-toggle"]',
      ),
    ].map((button) => ({ disabled: button.disabled, visible: visible(button) })),
    monitorControls: [
      ...pr.shadowRoot.querySelectorAll('[data-testid="pr-monitor-lifecycle"]'),
    ].map((button) => ({
      text: button.textContent.trim(),
      disabled: button.disabled,
      visible: visible(button),
    })),
  },
  assessment: assessment && {
    records: Reflect.get(assessment, 'records'),
    text: visibleText(assessment),
    selectedId: Reflect.get(assessment, 'selectedId'),
  },
  analytics: analytics && {
    result: Reflect.get(analytics, 'result'),
    text: visibleText(analytics),
  },
  chat: chat && {
    open: chat.open,
    runtime: Reflect.get(chat, 'runtime'),
    text: visibleText(chat),
    effort: effortControl && {
      value: effortControl.getAttribute('data-value'),
      visible: visible(effortControl),
      text: visibleText(effortControl),
      selected: [...effortControl.querySelectorAll('button[aria-pressed="true"]')].map(
        (button) => ({
          value: button.getAttribute('data-choice-value'),
          text: button.textContent.trim(),
          visible: visible(button),
        }),
      ),
    },
    save: [...chat.querySelectorAll('[data-testid="copilot-save-config"]')].map((button) => ({
      disabled: button.disabled,
      visible: visible(button),
    })),
  },
};
