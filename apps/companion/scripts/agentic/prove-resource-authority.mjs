import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { automationGatewayTarget } from '../../../../scripts/lib/gateway-profile.mjs';

const action = process.argv[2];
assert(
  ['capture', 'deleted', 'replaced', 'ready', 'inspect', 'apply-profile-auth'].includes(action),
);
const metro = process.env.METRO_PORT;
const platform = process.env.PLATFORM;
assert(/^\d+$/.test(metro ?? ''), 'Select the isolated METRO_PORT');
assert(['ios', 'android'].includes(platform), 'Select the actual target platform');
const evidencePath = process.env.FARMSLOT_RESOURCE_AUTHORITY_SCOPE;
if (!['inspect', 'apply-profile-auth'].includes(action))
  assert(evidencePath, 'Select a private authority evidence file');
if (action === 'apply-profile-auth') {
  assert(process.env.FARMSLOT_HOME, 'Select the isolated home');
  const session = process.env.FARMSLOT_NATIVE_SESSION;
  assert(session, 'Select the existing owned native UI session');
  const profile = await automationGatewayTarget();
  assert(profile && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(profile.url).hostname));
  const execute = promisify(execFile);
  async function device(args) {
    try {
      const result = await execute(
        'yarn',
        [
          'workspace',
          '@farmslot/mobile',
          'exec',
          'agent-device',
          ...args,
          '--session',
          session,
          '--json',
        ],
        { timeout: 60000, maxBuffer: 1024 * 1024 },
      );
      const reply = JSON.parse(result.stdout);
      assert(reply.success, 'The native UI action failed');
      return reply.data;
    } catch (error) {
      // Driver diagnostics may include the entered value. Never expose a credential in proof logs.
      throw new Error(
        `${error.message}\n${error.stdout ?? ''}`.replaceAll(
          profile.credential.token,
          '[redacted]',
        ),
      );
    }
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const snapshot = await device(['snapshot', '-i']);
    const field =
      snapshot.nodes.find((node) => node.identifier === 'gateway-auth-secret') ??
      snapshot.nodes.find((node) => node.label === 'Advanced manual setup');
    assert(field, 'Open the real native settings before entering a credential');
    const viewport = snapshot.nodes.find((node) => /scrollview/i.test(node.type))?.rect;
    assert(viewport, 'The native settings scroll viewport is missing');
    const center = field.rect.y + field.rect.height / 2;
    const target = viewport.y + viewport.height * 0.3;
    if (Math.abs(center - target) < viewport.height * 0.2) {
      if (field.identifier === 'gateway-auth-secret') break;
      await device(['press', 'label="Advanced manual setup"', '--settle']);
      continue;
    }
    assert(attempt < 9, 'The secure input did not scroll into view');
    const direction = center > target ? 1 : -1;
    const distance = Math.min(Math.abs(center - target), viewport.height * 0.4);
    const x = viewport.x + viewport.width / 2;
    const start = viewport.y + viewport.height * (direction > 0 ? 0.7 : 0.3);
    await device([
      'swipe',
      String(x),
      String(start),
      String(x),
      String(start - direction * distance),
      '600',
    ]);
  }
  await device(['fill', 'id="gateway-auth-secret"', profile.credential.token, '--settle']);
  if (platform === 'android') await device(['keyboard', 'dismiss']);
  else await device(['press', 'label="Token"', '--settle']);
  await device(['press', 'id="gateway-auth-save"', '--settle']);
  console.log(JSON.stringify({ result: 'PASS', action, platform }));
  process.exit(0);
}
const before = ['deleted', 'replaced'].includes(action)
  ? JSON.parse(await readFile(evidencePath, 'utf8'))
  : undefined;
const ref = `sources-cache:authority${before ? `:${JSON.stringify(before.inspectedScope)}` : ''}`;

async function inspect() {
  const response = await fetch(`http://127.0.0.1:${metro}/farmslot-recipe/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'observeUi',
      nodeId: `sources-authority-${action}`,
      payload: { refs: [ref] },
      timeout_ms: 5000,
    }),
    signal: AbortSignal.timeout(7000),
  });
  // Native input and connection rebinding can briefly suspend the development relay.
  if (response.status === 504) return undefined;
  assert(response.ok, `Recipe relay HTTP ${response.status}`);
  const reply = await response.json();
  assert(reply.ok, reply.error);
  const value = reply.observations.sourcesAuthority;
  assert.equal(value?.platform, platform, 'The relay answered from a different platform');
  assert.equal(value.result, 'PASS', JSON.stringify(value));
  return value;
}

const deadline = Date.now() + 60000;
let state;
do {
  const current = await inspect();
  if (!current) {
    await delay(50);
    continue;
  }
  state = current;
  if (action === 'inspect') {
    console.log(JSON.stringify(state));
    process.exit(0);
  }
  const ready =
    state.cacheStatus === 'ready' &&
    state.cacheHasData &&
    state.persistent &&
    state.storedObservedAt === state.cacheObservedAt;
  const deleted =
    state.persistent &&
    state.storedObservedAt === undefined &&
    !state.cacheHasData &&
    !state.identity &&
    state.renderAccess === 'none';
  const replaced =
    state.persistent &&
    state.storedObservedAt === undefined &&
    state.cacheStatus === 'ready' &&
    state.cacheHasData &&
    state.identity?.metadata.scope.principalId &&
    state.identity.metadata.scope.principalId !== before?.inspectedScope.principalId;
  if (action === 'deleted' ? deleted : action === 'replaced' ? replaced : ready) {
    if (action === 'capture')
      await writeFile(evidencePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ result: 'PASS', action, before, state }));
    process.exit(0);
  }
  await delay(50);
} while (Date.now() < deadline);
assert.fail(`The actual native authority state did not settle: ${JSON.stringify(state)}`);
