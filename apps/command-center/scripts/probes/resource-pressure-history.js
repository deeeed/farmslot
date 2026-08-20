const findDeep = (root, selector) =>
  root.querySelector(selector) ||
  [...root.querySelectorAll('*')]
    .map((element) => element.shadowRoot && findDeep(element.shadowRoot, selector))
    .find(Boolean);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const routeParams = new URLSearchParams(location.hash.split('?')[1] ?? '');
const machineName = routeParams.get('pressureMachine') ?? 'macwork';

const fleet = findDeep(document, 'fleet-canvas');
if (!fleet) throw new Error('fleet-canvas not found');
const fleetRoot = fleet.shadowRoot;
const refresh = [...fleetRoot.querySelectorAll('button')].find((button) =>
  button.textContent.includes('Refresh pressure'),
);
if (!refresh) throw new Error('pressure refresh button not found');

let card;
let details;
let history;
let charts = [];
let processRows = [];
let sampleCount = 0;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const overview = fleetRoot.querySelector('machine-pressure-overview');
  card = overview?.shadowRoot?.querySelector(`[data-machine="${CSS.escape(machineName)}"]`);
  details = card?.querySelector(`[data-testid="pressure-details-${CSS.escape(machineName)}"]`);
  if (details?.getAttribute('aria-expanded') !== 'true') details?.click();
  await sleep(250);
  history = card?.querySelector('.history-panel');
  charts = [...(history?.querySelectorAll('.history-chart polyline') ?? [])];
  processRows = [...(card?.querySelectorAll('.group:not(.group-head)') ?? [])];
  sampleCount = Number(card?.querySelector('.sample-note')?.textContent?.match(/\d+/)?.[0] ?? '0');
  if (charts.length === 3 && processRows.length > 0 && sampleCount > 1) break;
  // The view fetches once on navigation. Allow that request to settle before one explicit retry;
  // repeatedly pressing refresh would turn an evidence probe into avoidable gateway load.
  if (attempt === 20) refresh.click();
}
if (!card) throw new Error(`${machineName} pressure card not found`);
if (!details) throw new Error(`${machineName} pressure Details button not found`);
const renderedMachines = [
  ...(fleetRoot
    .querySelector('machine-pressure-overview')
    ?.shadowRoot?.querySelectorAll('.machine') ?? []),
].map((element) => element.getAttribute('data-machine'));
if (renderedMachines.length !== 1 || renderedMachines[0] !== machineName) {
  throw new Error(`global machine filter rendered unexpected cards: ${renderedMachines.join(',')}`);
}
if (!history || charts.length !== 3)
  throw new Error('three pressure history charts did not render');
if (processRows.length === 0 || sampleCount <= 1) {
  throw new Error('real pressure history and process attribution did not replace fallback data');
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
if (
  !history.textContent.includes('CPU utilization') ||
  !history.textContent.includes('Load / core')
) {
  throw new Error('pressure history labels are incomplete');
}

return {
  machine: machineName,
  expanded: details.getAttribute('aria-expanded'),
  charts: charts.length,
  processRows: processRows.length,
  classPills,
  samples: card.querySelector('.sample-note')?.textContent?.trim(),
};
