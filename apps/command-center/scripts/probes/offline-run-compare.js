const compare = document.querySelector('run-compare');
if (!compare?.shadowRoot) return { mounted: false };
const runAQuery = Reflect.get(compare, 'runAQuery');
const runBQuery = Reflect.get(compare, 'runBQuery');
const familyQuery = Reflect.get(compare, 'familyQuery');
const runA = Reflect.get(compare, 'runA');
const runB = Reflect.get(compare, 'runB');
const text = compare.shadowRoot.textContent;
const storage = (
  await document.querySelector('farm-resource-store-notice')?.resourceStoreDiagnostics()
)?.storage;
return {
  mounted: true,
  storage,
  fullRunsCanonical: Boolean(
    runA && runB && runA === runAQuery?.state.data?.run && runB === runBQuery?.state.data?.run,
  ),
  ids: [runA?.id, runB?.id],
  tags: [runA?.tags ?? [], runB?.tags ?? []],
  freshness: [runAQuery?.state.status, runBQuery?.state.status],
  observedAt: [runAQuery?.state.observedAt, runBQuery?.state.observedAt],
  titlesRendered: Boolean(
    runA && runB && text.includes(runA.ticketOrPr) && text.includes(runB.ticketOrPr),
  ),
  familyFreshness: familyQuery?.state.status,
  familyRunIds: familyQuery?.state.data?.snapshot.runs.map(({ runId }) => runId) ?? [],
  saved: [...compare.shadowRoot.querySelectorAll('[role="status"]')].map((node) =>
    node.textContent.trim(),
  ),
};
