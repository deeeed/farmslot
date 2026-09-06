// CDP probe: the Command Center recipe replay controls carry a device target
// (ADR-054 item 3, MANUAL-000113) all the way to the Gateway.
//
// Real element, real DOM events, real gateway socket. Nothing is written into
// component state: the key is chosen through the select's own `change` handler
// and the identity is typed through the input's own `input` handler, exactly as
// an operator does it. What the probe asserts is the frame the component then
// puts on the wire and the Gateway's answer to it — not a value it planted.
//
// Run on any connected Command Center route, e.g.
//   node scripts/cdp.mjs eval slot/<slot-id> --file probes/recipe-rerun-device-target.js

function deep(selector, root = document) {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) {
      const nested = deep(selector, element.shadowRoot);
      if (nested) return nested;
    }
  }
  return null;
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Type into a controlled input the way the browser does, then fire its handler. */
function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function choose(select, value) {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

const host = document.createElement('div');
host.id = 'cdp-recipe-rerun-device-target';
host.style.cssText = 'position:fixed;left:0;bottom:0;width:900px;z-index:2147483647;';
document.body.appendChild(host);

// Watch the real socket rather than stubbing the client: the component still
// sends, we only read what it sent.
const sentFrames = [];
const nativeSend = window.WebSocket.prototype.send;
window.WebSocket.prototype.send = function patchedSend(data) {
  if (typeof data === 'string' && data.includes('recipe.rerun')) {
    try {
      sentFrames.push(JSON.parse(data));
    } catch {
      sentFrames.push({ unparsed: data.slice(0, 400) });
    }
  }
  return nativeSend.call(this, data);
};

const result = { steps: [] };
function step(name, ok, evidence) {
  result.steps.push({ step: name, ok, evidence });
  if (!ok) result.failed = true;
}

try {
  const runId = document.body.dataset.cdpRunId || 'cdp-device-target-probe-run';
  const slotId = location.hash.match(/^#slot\/([^?]+)/)?.[1] || 'macwork-ff-4';

  host.innerHTML = `<recipe-runner-controls id="cdp-target-controls"></recipe-runner-controls>`;
  const controls = host.querySelector('#cdp-target-controls');
  controls.runId = runId;
  controls.slotId = slotId;
  await controls.updateComplete;

  const select = await waitFor(
    () => deep('[data-testid="recipe-target-key"]', host),
    'target key select',
  );
  const input = await waitFor(
    () => deep('[data-testid="recipe-target-value"]', host),
    'target identity input',
  );

  const options = [...select.options].map((option) => option.value);
  step('device-keys-offered', options.join(',') === 'udid,simulator,avd,adb_serial', {
    options,
    note: 'platform is a provider selector, not a device, so it is not offered here',
  });

  step('empty-by-default', input.value === '' && input.placeholder === 'slot default', {
    value: input.value,
    placeholder: input.placeholder,
  });

  // 1. A shell-bearing identity must never reach the wire.
  choose(select, 'simulator');
  typeInto(input, 'fs-4; touch /tmp/farmslot-113-cdp');
  await controls.updateComplete;
  sentFrames.length = 0;
  await controls.run();
  await waitFor(
    () => deep('recipe-output-panel', host)?.textContent?.includes('Device identity must match'),
    'client-side charset refusal',
  );
  step('charset-refused-before-the-wire', sentFrames.length === 0, {
    framesSent: sentFrames.length,
    rendered: deep('recipe-output-panel', host).textContent.trim().slice(0, 200),
  });

  // 2. A well-formed identity reaches the Gateway as `target`.
  typeInto(input, 'playground-1');
  await controls.updateComplete;
  sentFrames.length = 0;
  await controls.run();
  const frame = await waitFor(() => sentFrames[0], 'recipe.rerun frame');
  step(
    'target-reaches-the-gateway',
    frame?.method === 'recipe.rerun' &&
      JSON.stringify(frame.params?.target) === JSON.stringify({ simulator: 'playground-1' }),
    { method: frame?.method, target: frame?.params?.target, slotId: frame?.params?.slotId },
  );

  // 3. Switching the key sends that key, not a union with the previous one.
  choose(select, 'adb_serial');
  typeInto(input, 'emulator-5554');
  await controls.updateComplete;
  sentFrames.length = 0;
  await controls.run();
  const second = await waitFor(() => sentFrames[0], 'second recipe.rerun frame');
  step(
    'key-switch-sends-only-the-new-key',
    JSON.stringify(second?.params?.target) === JSON.stringify({ adb_serial: 'emulator-5554' }),
    { target: second?.params?.target },
  );

  // 4. Clearing the field replays on the slot's own device.
  typeInto(input, '   ');
  await controls.updateComplete;
  sentFrames.length = 0;
  await controls.run();
  const third = await waitFor(() => sentFrames[0], 'third recipe.rerun frame');
  step('empty-field-sends-no-target', third?.params?.target === undefined, {
    params: Object.keys(third?.params ?? {}),
  });

  result.runId = runId;
  result.slotId = slotId;
  result.ok = !result.failed;
  return result;
} finally {
  window.WebSocket.prototype.send = nativeSend;
  host.remove();
}
