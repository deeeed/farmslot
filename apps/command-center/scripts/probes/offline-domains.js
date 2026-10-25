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
    belongsToWorkspace: controller.belongsToWorkspace,
    canonicalDataPresent: cache.read(query).data !== undefined,
    params: query.params,
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
const buttons = (panel) =>
  [...panel.shadowRoot.querySelectorAll('button')].map((button) => ({
    action: button.dataset.action,
    label: button.textContent.trim(),
    disabled: button.disabled,
  }));
let assessmentReads;
if (assessment) {
  const { resourceQuery } = await import(loaded('/packages/protocol/src/client-cache/index.ts'));
  const inspect = (method, params) => {
    const query = resourceQuery(method, params),
      state = cache.read(query);
    return {
      id: query.id,
      persisted: query.persisted,
      status: state.status,
      dataPresent: state.data !== undefined,
      data: state.data,
      error: state.error,
      observedAt: state.observedAt,
    };
  };
  assessmentReads = {
    history: inspect('assessment.list', { limit: 50 }),
    selected: Reflect.get(assessment, 'selectedId')
      ? inspect('assessment.get', { id: Reflect.get(assessment, 'selectedId') })
      : undefined,
  };
}
return {
  loaded: true,
  connection: gateway.connectionState,
  connectionId: gateway.resourceConnectionId,
  timeOrigin: performance.timeOrigin,
  observedAt: Date.now(),
  principalId: gateway.authenticatedPrincipalId,
  workspaceAccess: gateway.workspaceAccess,
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
    summary: Reflect.get(assessment, 'summary'),
    cursor: Reflect.get(assessment, 'cursor'),
    outcomeCount: Reflect.get(assessment, 'outcomeResources').size,
    historyReady: Reflect.get(assessment, 'historyReady'),
    outcomes: [...Reflect.get(assessment, 'outcomeResources')].map(([id, controller]) => ({
      id,
      ready: controller.ready,
      data: controller.state.data,
    })),
    articleIds: [...assessment.shadowRoot.querySelectorAll('article')].map((node) => node.id),
    buttons: buttons(assessment),
    canonicalReads: assessmentReads,
  },
  analytics: analytics && {
    result: Reflect.get(analytics, 'result'),
    text: visibleText(analytics),
    statLineCount: analytics.shadowRoot.querySelectorAll('.stat-line').length,
    chartCount: analytics.shadowRoot.querySelectorAll('.grid').length,
    buttons: buttons(analytics),
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
