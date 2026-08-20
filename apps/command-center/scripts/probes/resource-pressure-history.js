const findDeep = (root, selector) =>
  root.querySelector(selector) ||
  [...root.querySelectorAll('*')]
    .map((element) => element.shadowRoot && findDeep(element.shadowRoot, selector))
    .find(Boolean);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const routeParams = new URLSearchParams(location.hash.split('?')[1] ?? '');
const machineName = routeParams.get('pressureMachine') ?? 'macwork';
const projectName = routeParams.get('projects');

const fleet = findDeep(document, 'fleet-canvas');
if (!fleet) throw new Error('fleet-canvas not found');
const fleetRoot = fleet.shadowRoot;
const requestParams = fleet.pressureRequestParams();
if (
  requestParams.machines?.length !== 1 ||
  requestParams.machines[0] !== machineName ||
  (projectName && !requestParams.projects?.includes(projectName))
) {
  throw new Error(
    `global filters were not forwarded to pressure RPC: ${JSON.stringify(requestParams)}`,
  );
}
const refresh = [...fleetRoot.querySelectorAll('button')].find((button) =>
  button.textContent.includes('Refresh pressure'),
);
if (!refresh) throw new Error('pressure refresh button not found');

let card;
let details;
let charts = [];
let processRows = [];
let sampleCount = 0;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const overview = fleetRoot.querySelector('machine-pressure-overview');
  card = overview?.shadowRoot?.querySelector(`[data-machine="${CSS.escape(machineName)}"]`);
  details = card?.querySelector(`[data-testid="pressure-details-${CSS.escape(machineName)}"]`);
  await sleep(250);
  charts = [...(card?.querySelectorAll('.metrics .sparkline polyline') ?? [])];
  processRows = [...(card?.querySelectorAll('.group:not(.group-head)') ?? [])];
  sampleCount = Number(
    card
      ?.querySelector('[data-testid="pressure-history-samples"]')
      ?.textContent?.match(/\d+/)?.[0] ?? '0',
  );
  const attributionReady =
    processRows.length > 0 || card?.textContent.includes('process inventory') === true;
  if (charts.length === 3 && attributionReady && sampleCount > 0) break;
  // The view fetches once on navigation. Allow that request to settle before one explicit retry;
  // repeatedly pressing refresh would turn an evidence probe into avoidable gateway load.
  if (attempt === 20) refresh.click();
}
if (!card) throw new Error(`${machineName} pressure card not found`);
if (!details) throw new Error(`${machineName} run relief action not found`);
const renderedMachines = [
  ...(fleetRoot
    .querySelector('machine-pressure-overview')
    ?.shadowRoot?.querySelectorAll('.machine') ?? []),
].map((element) => element.getAttribute('data-machine'));
if (renderedMachines.length !== 1 || renderedMachines[0] !== machineName) {
  throw new Error(`global machine filter rendered unexpected cards: ${renderedMachines.join(',')}`);
}
if (charts.length !== 3) throw new Error('three compact pressure trend charts did not render');
if (card.querySelector('.history-panel')) throw new Error('Details duplicated pressure graphs');
if (sampleCount === 0) {
  throw new Error('pressure history did not render a real gauge sample');
}
if (processRows.length === 0 && !card.textContent.includes('process inventory')) {
  throw new Error('process attribution rendered neither owned groups nor an unavailable reason');
}
const classPills = [...card.querySelectorAll('.class-pill')].map((pill) => pill.textContent.trim());
if (
  classPills.length !== 5 ||
  !classPills.some((label) => label.startsWith('system / unmapped '))
) {
  throw new Error('process attribution class counts did not render');
}
if (charts.some((chart) => chart.namespaceURI !== 'http://www.w3.org/2000/svg')) {
  throw new Error('pressure history chart is not in the SVG namespace');
}
if (!card.textContent.includes('CPU') || !card.textContent.includes('Load / core'))
  throw new Error('pressure trend labels are incomplete');
const scopedRequest = JSON.stringify(requestParams);
const originalSearch = fleet.search;
fleet.search = '__pressure_local_search_no_match__';
await fleet.updateComplete;
if (JSON.stringify(fleet.pressureRequestParams()) !== scopedRequest) {
  throw new Error('slot search incorrectly changed the pressure RPC scope');
}
const searchCards = [
  ...(fleetRoot
    .querySelector('machine-pressure-overview')
    ?.shadowRoot?.querySelectorAll('.machine') ?? []),
];
if (searchCards.length !== 0) throw new Error('slot search did not filter pressure cards locally');
fleet.search = originalSearch;
await fleet.updateComplete;

return {
  machine: machineName,
  project: projectName,
  action: details.textContent.trim(),
  charts: charts.length,
  processRows: processRows.length,
  attribution: processRows.length > 0 ? 'sampled' : 'awaiting-census',
  searchScope: 'local-only',
  classPills,
  samples: card.querySelector('.sample-note')?.textContent?.trim(),
};
