// Read rendered text/geometry and the observations that own those real consumers.
const app = document.querySelector('farm-app');
const root = app?.shadowRoot ?? app;
const detail = root?.querySelector('run-detail');
const run = detail?.shadowRoot;
const gate = run?.querySelector('ready-workspace');
const cockpit = root?.querySelector('eval-cockpit');
const evals = cockpit?.shadowRoot;
const runRead = detail && Reflect.get(detail, '_runObservation');
const configuration = cockpit && Reflect.get(cockpit, '_candidateConfiguration')?.state;
const revision = (state, family) =>
  state?.resourceState?.dependencies.find(({ key }) => key.family === family)?.revision;
const note = [...(evals?.querySelectorAll('.base-choice-note') ?? [])].find((element) =>
  element.textContent.includes('The gateway captures'),
);
return {
  width: innerWidth,
  runReadStatus: runRead?.status,
  runReadRevision: revision(runRead, 'run'),
  runResolved: Boolean(runRead?.data?.run.decisions.some((decision) => decision.resolvedAt)),
  gateNotice: gate?.querySelector('.rdy-resolved-banner')?.textContent.trim(),
  gateTabsTop: gate?.querySelector('.rdy-tab-bar')?.getBoundingClientRect().top,
  gateSaved: gate?.querySelector('.rdy-saved-state')?.textContent.trim(),
  templateNote: note?.textContent.trim(),
  templateNoteTop: note?.getBoundingClientRect().top,
  templateNoteVisible: Boolean(
    note &&
    note.getBoundingClientRect().top >= 0 &&
    note.getBoundingClientRect().bottom <= innerHeight,
  ),
  templateStatus: evals?.querySelector('[data-testid="eval-template-status"]')?.textContent.trim(),
  configurationStatus: configuration?.status,
  configurationRevision: revision(configuration, 'configuration'),
  configurationError: configuration?.error?.code,
  templateErrorRendered: Boolean(
    evals?.textContent.includes('Project template versions could not be refreshed'),
  ),
  operationHeight: evals
    ?.querySelector('[data-testid="eval-operation-status"]')
    ?.getBoundingClientRect().height,
  operationBorder: evals?.querySelector('[data-testid="eval-operation-status"]')
    ? getComputedStyle(evals.querySelector('[data-testid="eval-operation-status"]')).borderWidth
    : undefined,
};
