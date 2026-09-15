// Exercise the real dispatch controls without dispatching or queueing work.
const view = document.querySelector('dispatch-wizard');
if (!view) throw new Error('Open the Dispatch page');
const root = view.shadowRoot;
const guide = root.querySelector('[data-testid=dispatch-guide]');
if (!guide || guide.open) throw new Error('Dispatch guide must start collapsed');
const summary = guide.querySelector('summary');
summary.click();
if (!guide.open) throw new Error('Dispatch guide did not open');
const labels = [...guide.querySelectorAll('dt')].map((item) => item.textContent.trim());
for (const label of [
  'Dispatch as',
  'Ticket / PR',
  'Flow',
  'Project / App',
  'Runner / Model / Effort',
  'Worker interface',
  'Account profile',
  'Prepare',
  'Review Tier / Validation',
  'Interactive dev',
  'Slots',
  'Dispatch / Queue',
]) {
  if (!labels.includes(label)) throw new Error('Missing dispatch explanation: ' + label);
}
if (!guide.textContent.includes('standalone conversations'))
  throw new Error('Worker capability limitation is not explained');
summary.click();
if (guide.open) throw new Error('Dispatch guide did not close');

const group = root.querySelector('[data-testid=dispatch-transport]');
if (!group || group.localName !== 'div' || group.getAttribute('role') !== 'group')
  throw new Error('Worker interface must use the shared button group');
const buttons = [...group.querySelectorAll('button')];
if (buttons.length !== 2 || !buttons.every((button) => button.classList.contains('pill')))
  throw new Error('Worker interface does not match dispatch button styling');
if (root.querySelector('select[data-testid=dispatch-transport]'))
  throw new Error('Unstyled transport dropdown remains');
const originalRunner = view._runner;
const originalTransport = view._transport;
const wait = async (check) => {
  const until = Date.now() + 30000;
  while (!check()) {
    if (Date.now() > until) throw new Error('Worker interface did not update');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
await wait(() => view._nativeCatalogReady);
const runners = view._nativeCatalog.runners;
const chooseRunner = async (runner) => {
  const picker = root.querySelector('runner-model-effort-picker');
  const button = [...picker.shadowRoot.querySelectorAll('button')].find(
    (item) => item.textContent.trim() === runner,
  );
  if (!button || button.disabled) throw new Error('Runner control unavailable');
  button.click();
  await view.updateComplete;
};
const choose = async (transport) => {
  const button = root.querySelector(`[data-transport=${transport}]`);
  if (button.disabled) throw new Error('Interface control unavailable');
  button.click();
  await view.updateComplete;
  const selected = [...group.querySelectorAll('[aria-pressed=true]')];
  if (
    selected.length !== 1 ||
    selected[0].dataset.transport !== transport ||
    view._transport !== transport
  )
    throw new Error('Selected interface and dispatch state disagree');
};
try {
  const supported = runners.find((runner) => runner.supportsWorkers);
  if (!supported) throw new Error('Gateway catalog has no native workers');
  await chooseRunner(supported.runner);
  await choose('tmux');
  await choose('native');
  const unsupported = runners.find((runner) => !runner.supportsWorkers);
  if (unsupported) {
    await chooseRunner(unsupported.runner);
    const button = root.querySelector('[data-transport=native]');
    if (view._transport !== 'tmux' || button.getAttribute('aria-pressed') !== 'false')
      throw new Error('Unsupported runner kept Conversation selected');
    if (!button.disabled) throw new Error('Unsupported runner enables native workers');
    button.click();
    await view.updateComplete;
    if (view._transport !== 'tmux') throw new Error('Disabled control changed dispatch state');
  }
} finally {
  await chooseRunner(originalRunner);
  await choose(originalTransport);
}
return {
  pass: true,
  choices: buttons.map((button) => button.textContent.trim()),
  transport: view._transport,
  dispatched: false,
  helpSections: labels.length,
};
