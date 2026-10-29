const detail = document.querySelector('run-detail');
const view = detail?.shadowRoot?.querySelector('ready-workspace');
if (!view) return { mounted: false, detail: Boolean(detail) };
const queries = view._queries;
const cacheUrl = performance
  .getEntriesByType('resource')
  .map(({ name }) => name)
  .filter((name) => new URL(name).pathname === '/src/resource-cache.ts')
  .at(-1);
if (!cacheUrl) throw new Error('Inspect the active resource cache');
const cache = (await import(cacheUrl)).getResourceCache();
const read = (controller) => {
  const query = Reflect.get(controller, 'query');
  if (query && cache?.read(query) !== controller.state)
    throw new Error('The workspace must render its canonical shared observation');
  return {
    query: query && { id: query.id, method: query.method, params: query.params },
    status: controller.state.status,
    observedAt: controller.state.observedAt,
    error: controller.state.error?.message,
  };
};
const visible = (element) => {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight;
};
const run = view._canonicalRun;
const gate = view._gateDecision;
const commands = [...view.querySelectorAll('[data-action]')];
return {
  mounted: true,
  runId: run?.id,
  tags: run?.tags,
  decisionId: gate?.id,
  runCanonical: run === queries.run.state.data?.run,
  gateCanonical: run?.decisions.includes(gate),
  renderedReport: view.textContent.includes('Private offline workspace proof'),
  run: read(queries.run),
  evidence: read(queries.evidence),
  paused: view._actionsPaused,
  recovering: view._isRecovering,
  recoveryPhase: view._recoveryPhase,
  postureBlocked: view.postureBlockedReason,
  focusedAction: detail.shadowRoot.activeElement?.getAttribute('data-action'),
  activeElement: detail.shadowRoot.activeElement?.tagName,
  commands: commands.map((button) => ({
    action: button.dataset.action,
    disabled: button.disabled,
  })),
  actionMessage: view._actionMessage,
  actionTone: view._actionTone,
  busy: view._acting,
  feedbackVisible: visible(view.querySelector('.rdy-action-feedback')),
  savedVisible: visible(view.querySelector('.rdy-saved-state')),
  renderedMessage: Boolean(view._actionMessage && view.textContent.includes(view._actionMessage)),
  saved: view.querySelector('.rdy-saved-state')?.textContent.trim(),
  renderedTags: [
    ...(detail.shadowRoot
      .querySelector('run-tag-editor')
      ?.shadowRoot?.querySelectorAll('.tag-pill') ?? []),
  ].map((tag) => tag.textContent.trim().replace(/^#/, '')),
};
