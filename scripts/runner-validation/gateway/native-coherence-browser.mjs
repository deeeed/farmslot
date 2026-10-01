import assert from 'node:assert/strict';
import path from 'node:path';

const walk =
  "const walk=r=>[...r.querySelectorAll('*')].flatMap(e=>e.shadowRoot?[e,...walk(e.shadowRoot)]:[e]);const all=walk(document);";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(read, predicate, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await delay(300);
  }
  throw new Error(`Browser proof timed out: ${label}`);
}

export async function proveRecoveryHint({ cdp, runId, outDir }) {
  const route = `runs?run=${runId}`;
  cdp('goto', route, '--new');
  await waitFor(
    () => cdp('eval', route, "return !!document.querySelector('.auth-card');"),
    Boolean,
    'fixture login form',
  );
  cdp('login', route);
  const modal = await waitFor(
    () =>
      cdp(
        'eval',
        route,
        walk +
          "return {ready:all.some(e=>e.matches('[data-testid=run-recovery-hint]')),modal:all.some(e=>e.matches('whats-new-modal')&&e.shadowRoot?.querySelector('button.primary'))};",
      ),
    (value) => value.ready,
    'run detail after authentication',
  );
  if (modal.modal) cdp('click', route, 'whats-new-modal >>> button.primary');
  const evidence = await waitFor(
    () =>
      cdp(
        'eval',
        route,
        walk +
          "return all.filter(e=>e.matches('[data-testid=run-recovery-hint]')).map(e=>e.textContent.trim());",
      ),
    (hints) => hints.some((hint) => hint.includes('farmslot decision resolve')),
    'pending decision recovery command',
  );
  cdp('screenshot', route, path.join(outDir, 'recovery-hint.png'));
  return { route, recoveryCommands: evidence.length };
}

export async function prepareBusyWorkerView({ cdp, runId, onNavigate }) {
  const route = `runs?run=${runId}`;
  await waitFor(
    () =>
      cdp(
        'eval',
        route,
        walk + "return all.some(e=>e.matches('[data-testid=run-native-session-dev]'));",
      ),
    Boolean,
    'native worker history control',
  );
  const workerRoute = cdp(
    'eval',
    route,
    walk +
      "return all.find(e=>e.matches('[data-testid=run-native-session-dev]')).getAttribute('href').slice(1);",
  );
  cdp('click', route, '[data-testid=run-native-session-dev]');
  onNavigate(workerRoute);
  return waitFor(
    () =>
      cdp(
        'eval',
        workerRoute,
        walk +
          "const v=all.find(e=>e.matches('native-session-view'));const input=v?.shadowRoot.querySelector('textarea');let p=v;const parts=['native-session-view'];while(p){const host=p.getRootNode().host;if(!host)break;parts.unshift(host.localName);p=host;}return {route:location.hash.slice(1),selector:parts.join(' >>> ')+' >>> textarea',ready:!!input&&!input.disabled};",
      ),
    (value) => value.ready,
    'pinned native worker composer',
  );
}

export async function proveBusySteering({ cdp, rpc, target, view, outDir }) {
  const { route, selector } = view;
  await waitFor(
    () =>
      cdp(
        'eval',
        route,
        walk +
          "const v=all.find(e=>e.matches('native-session-view'));return v?.shadowRoot.querySelector('[data-testid=native-send]')?.textContent.trim();",
      ),
    (label) => label === 'Queue message',
    'busy worker queue control',
  );
  cdp('fill', route, selector, 'queued-steering-ui');
  cdp('click', route, '[data-testid=native-send]');
  const snapshot = await waitFor(
    () => rpc('native.session.read', target()),
    (value) => value.commands.some((command) => command.queued),
    'durable queued receipt',
  );
  const receipt = snapshot.commands.find((command) => command.queued);
  assert.equal(receipt.submitted, false);
  assert.equal(receipt.accepted, false);
  await waitFor(
    () =>
      cdp(
        'eval',
        route,
        walk +
          "const v=all.find(e=>e.matches('native-session-view'));return v?.shadowRoot.querySelector('[data-testid=native-delivery]')?.textContent.trim();",
      ),
    (label) => label === 'Queued for the next turn',
    'visible queued delivery state',
  );
  cdp('screenshot', route, path.join(outDir, 'busy-queued-message.png'));
  return receipt;
}

export async function proveSharedCleanup({ cdp, runId, outDir }) {
  const route = `runs?run=${runId}`;
  cdp('goto', route);
  const text = await waitFor(
    () =>
      cdp(
        'eval',
        route,
        walk +
          "return all.find(e=>e.matches('[data-testid=run-slot-cleanup-hint]'))?.textContent.trim();",
      ),
    (value) => value?.includes('Workspace cleanup deferred'),
    'foreign workspace cleanup hint',
  );
  cdp('screenshot', route, path.join(outDir, 'shared-slot-cleanup.png'));
  return { route, hint: text };
}
