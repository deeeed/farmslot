// CDP probe: the Command Center recipe replay controls carry a device target
// (ADR-054 item 3, MANUAL-000113) all the way to the Gateway, and the identity
// is PICKED from the machine's real device inventory (MANUAL-000124).
//
// Real element, real DOM events, real gateway socket. Nothing is written into
// component state: the key is chosen through the select's own `change` handler,
// the identity is typed through the input's own `input` handler, and the replay
// is started by clicking the button, exactly as an operator does it. What the
// probe asserts is the frame the component then puts on the wire — not a value
// it planted.
//
// LIMITATION, stated rather than hidden: this mounts its own
// `<recipe-runner-controls>` instead of driving the one Slot View renders. That
// instance appears only when the slot has a linked run WITH a replayable recipe
// artifact, which needs a full dispatch; on a fleet where no such run exists the
// route never reaches the component. The element, its handlers, its params
// builder and the gateway client are the shipped ones either way — what is not
// covered here is the wiring in `slot-view-recipe-renderers.ts` that supplies
// `runId`/`recipeArtifactPath`.
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

/** The identity control currently on screen: the picker, or the free-text field. */
function identityControl(host) {
  return (
    deep('[data-testid="recipe-target-identity"]', host) ??
    deep('[data-testid="recipe-target-value"]', host)
  );
}

/** Start the replay the way an operator does: click the button. */
async function clickReplay(controls) {
  // The button is swapped for Cancel while a replay is in flight, so wait for
  // the real control to come back rather than assuming it is there.
  const button = await waitFor(
    () => controls.querySelector('[data-testid="recipe-replay-run"]:not([disabled])'),
    'the replay button',
  );
  button.click();
  await controls.updateComplete;
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

  const options = [...select.options].map((option) => option.value);
  step('device-keys-offered', options.join(',') === 'udid,simulator,avd,adb_serial', {
    options,
    note: 'platform is a provider selector, not a device, so it is not offered here',
  });

  // The identity control is now whichever of the two the machine's inventory
  // justifies (MANUAL-000124), and the inventory arrives asynchronously — so
  // wait for it before deciding, rather than racing it. The charset checks below
  // are about what a TYPED identity does, so they take the free-text field
  // through the picker's own escape hatch every time the key changes.
  await waitFor(
    () => controls._inventory !== null || controls._inventoryError,
    'the device inventory to answer',
    20000,
  );

  /** Select a key, then land on the free-text field whichever control it shows. */
  async function freeTextField(key) {
    choose(select, key);
    await controls.updateComplete;
    const picker = deep('[data-testid="recipe-target-identity"]', host);
    if (picker) {
      choose(picker, '__other__');
      await controls.updateComplete;
    }
    return waitFor(() => deep('[data-testid="recipe-target-value"]', host), 'free-text field');
  }

  let input = await freeTextField('simulator');
  step('empty-by-default', input.value === '' && input.placeholder === 'slot default', {
    value: input.value,
    placeholder: input.placeholder,
    inventoryDevices: controls._inventory?.devices?.length ?? null,
    inventoryError: controls._inventoryError || null,
  });

  // 1. A shell-bearing identity must never reach the wire.
  typeInto(input, 'fs-4; touch /tmp/farmslot-113-cdp');
  await controls.updateComplete;
  sentFrames.length = 0;
  await clickReplay(controls);
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
  await clickReplay(controls);
  const frame = await waitFor(() => sentFrames[0], 'recipe.rerun frame');
  step(
    'target-reaches-the-gateway',
    frame?.method === 'recipe.rerun' &&
      JSON.stringify(frame.params?.target) === JSON.stringify({ simulator: 'playground-1' }),
    { method: frame?.method, target: frame?.params?.target, slotId: frame?.params?.slotId },
  );

  // 3. Switching the key sends that key, not a union with the previous one.
  input = await freeTextField('adb_serial');
  typeInto(input, 'emulator-5554');
  await controls.updateComplete;
  sentFrames.length = 0;
  await clickReplay(controls);
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
  await clickReplay(controls);
  const third = await waitFor(() => sentFrames[0], 'third recipe.rerun frame');
  step('empty-field-sends-no-target', third?.params?.target === undefined, {
    params: Object.keys(third?.params ?? {}),
  });

  // ── MANUAL-000124: the inventory picker and the platform selector ──────────

  // 5. The identity control becomes a picker once the Gateway's inventory
  //    answers for the chosen key. Nothing is injected: the component made the
  //    `resource.device.inventory` call itself over the real socket.
  choose(select, 'simulator');
  await controls.updateComplete;
  const picker = await waitFor(
    () => deep('[data-testid="recipe-target-identity"]', host),
    'the inventory-backed identity picker',
    20000,
  );
  const offered = [...picker.options].map((option) => option.value);
  step('inventory-feeds-the-picker', offered.length > 2 && offered[0] === '', {
    offered,
    note: 'first option is the slot default; the last is the free-text escape hatch',
  });
  step('picker-keeps-a-free-text-escape-hatch', offered.includes('__other__'), { offered });

  // 6. Picking a device sends exactly that identity.
  const firstDevice = offered.find((value) => value !== '' && value !== '__other__');
  choose(picker, firstDevice);
  await controls.updateComplete;
  sentFrames.length = 0;
  await clickReplay(controls);
  const picked = await waitFor(() => sentFrames[0], 'picked-device recipe.rerun frame');
  step(
    'picked-device-reaches-the-gateway',
    JSON.stringify(picked?.params?.target) === JSON.stringify({ simulator: firstDevice }),
    { target: picked?.params?.target, firstDevice },
  );

  // 7. The platform selector is reachable in the UI and rides along with the
  //    device. This is the omission MANUAL-000113 shipped with.
  const platform = await waitFor(
    () => deep('[data-testid="recipe-target-platform"]', host),
    'the platform selector',
  );
  step(
    'platform-is-reachable-in-the-ui',
    [...platform.options].map((option) => option.value).join(',') === ',ios,android',
    { options: [...platform.options].map((option) => option.value) },
  );
  choose(platform, 'ios');
  await controls.updateComplete;
  sentFrames.length = 0;
  await clickReplay(controls);
  const withPlatform = await waitFor(() => sentFrames[0], 'platform-bearing recipe.rerun frame');
  step(
    'platform-rides-along-with-the-device',
    JSON.stringify(withPlatform?.params?.target) ===
      JSON.stringify({ simulator: firstDevice, platform: 'ios' }),
    { target: withPlatform?.params?.target },
  );

  // 8. A platform with no device changes nothing, so it is refused before the
  //    wire — the same refusal the Gateway would give one release too late.
  choose(picker, '');
  await controls.updateComplete;
  sentFrames.length = 0;
  await clickReplay(controls);
  await waitFor(
    () => deep('recipe-output-panel', host)?.textContent?.includes('choose a device too'),
    'client-side platform-only refusal',
  );
  step('platform-without-a-device-is-refused-before-the-wire', sentFrames.length === 0, {
    framesSent: sentFrames.length,
    rendered: deep('recipe-output-panel', host).textContent.trim().slice(0, 200),
  });

  // 9. `Other…` hands the operator back the free-text field on a machine whose
  //    list does not have what they need.
  choose(platform, '');
  choose(picker, '__other__');
  await controls.updateComplete;
  const fallback = await waitFor(
    () => deep('[data-testid="recipe-target-value"]', host),
    'the free-text fallback',
  );
  step('other-restores-the-free-text-field', Boolean(fallback) && fallback.value === '', {
    value: fallback.value,
    control: identityControl(host)?.dataset?.testid,
  });

  // 10. The Android half of the same inventory: the picker offers the serials
  //     adb reported, and each label names EVERY slot the pool configures for
  //     that device. The expectation is derived from the Gateway's own response,
  //     never from this machine's pool wiring — a probe that hard-codes slot ids
  //     fails on every other host for reasons unrelated to the code.
  choose(select, 'adb_serial');
  await controls.updateComplete;
  const serialsFromGateway = (controls._inventory?.devices ?? []).filter(
    (device) => device.key === 'adb_serial',
  );
  const androidPicker = deep('[data-testid="recipe-target-identity"]', host);
  if (serialsFromGateway.length === 0) {
    step('android-serials-come-from-adb', true, {
      skipped: 'adb listed no connected device on this machine, so there is nothing to offer',
      sources: controls._inventory?.sources ?? null,
    });
  } else if (androidPicker) {
    const offeredSerials = [...androidPicker.options].map((option) => option.value);
    step(
      'android-serials-come-from-adb',
      serialsFromGateway.every((device) => offeredSerials.includes(device.identity)),
      { offeredSerials, fromGateway: serialsFromGateway.map((device) => device.identity) },
    );
    // Every device the Gateway says more than one slot configures must show all
    // of them; a device with one slot shows that one.
    const labels = [...androidPicker.options].map((option) => option.textContent.trim());
    const mismatched = serialsFromGateway
      .filter((device) => device.configuredForSlots?.length)
      .filter(
        (device) =>
          !labels.some(
            (label) =>
              label.startsWith(device.identity) &&
              device.configuredForSlots.every((slot) => label.includes(slot)),
          ),
      );
    step('every-configured-slot-is-named', mismatched.length === 0, {
      labels,
      expected: serialsFromGateway.map((device) => [device.identity, device.configuredForSlots]),
    });
  } else {
    step('android-serials-come-from-adb', false, {
      note: 'the Gateway listed adb serials but the picker did not offer them',
      inventoryError: controls._inventoryError || null,
    });
  }

  // 11. The blocker Cursor found, driven as the real race rather than a
  //     simulation of it: a FRESH control paints the free-text field because no
  //     inventory has answered yet, the operator types an identity the machine
  //     does not list, and then the inventory lands. The control must not swap
  //     to a picker that cannot display what Replay is about to send.
  const raceHost = document.createElement('div');
  raceHost.style.cssText = 'position:fixed;left:0;bottom:0;width:900px;z-index:2147483646;';
  document.body.appendChild(raceHost);
  try {
    raceHost.innerHTML = `<recipe-runner-controls id="cdp-race-controls"></recipe-runner-controls>`;
    const race = raceHost.querySelector('#cdp-race-controls');
    race.runId = runId;
    race.slotId = slotId;
    await race.updateComplete;

    // First paint, before any inventory: the free-text field, and `_typingIdentity`
    // untouched — which is what made the later swap silent.
    const firstPaint = deep('[data-testid="recipe-target-value"]', raceHost);
    step('first-paint-is-the-free-text-field', Boolean(firstPaint), {
      control: identityControl(raceHost)?.dataset?.testid,
      inventory: race._inventory === null ? 'not answered yet' : 'already answered',
    });
    typeInto(firstPaint, 'not-a-real-simulator');
    await race.updateComplete;

    // Now let the inventory arrive, the way the poll does.
    await waitFor(
      () => race._inventory !== null || race._inventoryError,
      'the inventory to answer for the race control',
      20000,
    );
    await race.updateComplete;

    const shownAfterPoll = identityControl(raceHost);
    step(
      'an-unlisted-identity-keeps-the-free-text-field',
      shownAfterPoll?.dataset?.testid === 'recipe-target-value' &&
        shownAfterPoll.value === 'not-a-real-simulator',
      {
        control: shownAfterPoll?.dataset?.testid,
        shown: shownAfterPoll?.value ?? shownAfterPoll?.selectedOptions?.[0]?.textContent?.trim(),
        offered: (race._inventory?.devices ?? [])
          .filter((device) => device.key === 'simulator')
          .map((device) => device.identity),
      },
    );

    sentFrames.length = 0;
    await clickReplay(race);
    const unlisted = await waitFor(() => sentFrames[0], 'unlisted-identity recipe.rerun frame');
    const displayed =
      shownAfterPoll?.dataset?.testid === 'recipe-target-value'
        ? shownAfterPoll.value
        : (shownAfterPoll?.selectedOptions?.[0]?.value ?? '');
    step(
      'what-is-shown-is-what-is-sent',
      displayed === (unlisted?.params?.target?.simulator ?? ''),
      {
        shown: displayed,
        sent: unlisted?.params?.target ?? null,
      },
    );
  } finally {
    raceHost.remove();
  }

  result.runId = runId;
  result.slotId = slotId;
  result.ok = !result.failed;
  return result;
} finally {
  window.WebSocket.prototype.send = nativeSend;
  host.remove();
}
