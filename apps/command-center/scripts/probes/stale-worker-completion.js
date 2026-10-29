// UI fixture proof, using the existing dev/runs page and progress observation contract.
// cdp.mjs eval 'dev/runs?f212=1' --file scripts/probes/stale-worker-completion.js
if (!location.hash.startsWith('#dev/runs?f212=1'))
  throw new Error('Open the isolated F212 dev page');
const list = document.querySelector('run-list');
if (!list?.shadowRoot) throw new Error('Mount the run list dev harness first');
const { updateRuns } = await import('/src/state.ts');
const now = Date.now();
const start = new Date(now - 3 * 60 * 60_000).toISOString();
const run = {
  id: 'f212-ui-fixture',
  familyId: 'f212-ui-fixture',
  lane: 'production',
  flowType: 'fix-bug',
  status: 'monitoring',
  project: 'example-browser-farm',
  ticketOrPr: 'F212',
  slotId: 'runner-local-browser-1',
  branch: 'fixture',
  taskFile: 'tasks/fix/f212/TASK.md',
  createdAt: start,
  updatedAt: start,
  startedAt: start,
  statusChangedAt: start,
  steps: [{ name: 'monitor', status: 'running', startedAt: new Date(now - 60_000).toISOString() }],
  decisions: [],
  metrics: { runner: 'scripted', model: 'scripted', nudgeCount: 0 },
};
updateRuns([run]);
await list.updateComplete;
const controller = [...list.progressQueries.values()].find(
  (value) => value.query?.params.runId === run.id,
);
if (!controller) throw new Error('The run has no checklist observation');
controller.hostDisconnected();
list.removeController(controller);
const observation = {
  status: 'ready',
  data: {
    structured: {
      schema: { flowType: 'fix-bug', title: 'Fixture', totalSteps: 1, phases: [] },
      phases: [],
      completedSteps: 1,
      totalSteps: 1,
      currentPhase: null,
      currentStep: null,
      timing: {
        schemaVersion: 1,
        events: [],
        startedAt: start,
        finishedAt: new Date(now - 2 * 60 * 60_000).toISOString(),
      },
    },
  },
};
// Only this isolated UI controller is replaced. No gateway or run record is written.
Object.defineProperty(controller, 'state', { configurable: true, get: () => observation });
const results = [];
for (const status of ['ready', 'stale', 'error']) {
  observation.status = status;
  list.requestUpdate();
  await list.updateComplete;
  const row = list.shadowRoot.querySelector('[data-row-id="f212-ui-fixture"]');
  const label = row?.querySelector('.run-progress')?.textContent.trim();
  const expected =
    status === 'ready' ? 'Worker finished; monitor has not advanced' : 'Stale: no progress for';
  if (!label?.includes(expected) || label.includes('nothing pending'))
    throw new Error(`${status} progress label: ${label}`);
  results.push({ status, label, visible: !!row.getClientRects().length });
}
observation.status = 'ready';
list.requestUpdate();
await list.updateComplete;
return { kind: 'isolated-ui-fixture', results, gatewayWrites: false };
