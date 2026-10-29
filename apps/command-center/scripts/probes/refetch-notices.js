// Read only rendered text and geometry from the real consumers.
const app = document.querySelector('farm-app');
const root = app?.shadowRoot ?? app;
const run = root?.querySelector('run-detail')?.shadowRoot;
const gate = run?.querySelector('ready-workspace');
const evals = root?.querySelector('eval-cockpit')?.shadowRoot;
const note = [...(evals?.querySelectorAll('.base-choice-note') ?? [])].find((element) =>
  element.textContent.includes('The gateway captures'),
);
return {
  width: innerWidth,
  gateNotice: gate?.querySelector('.rdy-resolved-banner')?.textContent.trim(),
  gateTabsTop: gate?.querySelector('.rdy-tab-bar')?.getBoundingClientRect().top,
  gateSaved: gate?.querySelector('.rdy-saved-state')?.textContent.trim(),
  templateNote: note?.textContent.trim(),
  templateNoteTop: note?.getBoundingClientRect().top,
  templateStatus: evals?.querySelector('[data-testid="eval-template-status"]')?.textContent.trim(),
};
