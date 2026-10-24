import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { withOwnedGatewayOffline } from './owned-gateway-outage.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(await realpath(process.cwd()), await realpath(root));
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
assert(process.env.FARMSLOT_NATIVE_STORE_PROOF && process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR);
const fixturePath = await realpath(process.env.FARMSLOT_NATIVE_STORE_PROOF);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const home = await realpath(process.env.FARMSLOT_HOME);
assert.equal(await realpath(fixture.home), home);
assert(home.startsWith(`${path.dirname(fixturePath)}/`));
assert.equal(fixture.setupOnly, true, 'This recipe uses explicitly labeled closed-history setup');
assert.equal(fixture.sessionsA.length, 12);
const nativeOnly = process.env.FARMSLOT_NATIVE_STORE_PROOF_OWNER === 'b';
const sessions = nativeOnly ? fixture.sessionsB : fixture.sessionsA;
assert.equal(sessions.length, nativeOnly ? 1 : 12);
const retainedHistories = Math.min(10, sessions.length);
const desktopControl = process.env.FARMSLOT_NATIVE_STORE_DESKTOP_CONTROL;
if (desktopControl)
  assert((await realpath(desktopControl)).startsWith(`${path.dirname(fixturePath)}/`));
const artifacts = path.resolve(process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR);
assert(!artifacts.startsWith(`${root}/`));
await mkdir(artifacts, { recursive: true });
const cdpFile = path.join(root, 'apps/command-center/scripts/cdp.mjs');
const probe = path.join(root, 'apps/command-center/scripts/probes/offline-native-store.js');
const cdp = async (...args) =>
  JSON.parse((await execute(process.execPath, [cdpFile, ...args], { timeout: 60000 })).stdout);
const url = new URL(process.env.FARMSLOT_UI_URL);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
url.searchParams.set('native-store-proof', randomUUID());
url.hash = 'native';
let route;
const snapshots = [];
async function restartDesktop() {
  const owner = JSON.parse(await readFile(path.join(desktopControl, 'owner.json'), 'utf8'));
  const requestId = randomUUID();
  const requestFile = path.join(desktopControl, 'restart.request.json');
  const temporary = `${requestFile}.${requestId}.tmp`;
  await writeFile(temporary, JSON.stringify({ requestId, expectedPid: owner.pid }), {
    flag: 'wx',
    mode: 0o600,
  });
  await rename(temporary, requestFile);
  const deadline = Date.now() + 150000;
  do {
    let receipt;
    try {
      receipt = JSON.parse(
        await readFile(path.join(desktopControl, 'restart.receipt.json'), 'utf8'),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (receipt?.requestId === requestId) {
      assert.equal(receipt.previousPid, owner.pid);
      assert.notEqual(receipt.pid, owner.pid);
      assert.equal(receipt.gracefulStop, true);
      assert.equal(receipt.previousExitCode, 0);
      assert.equal(new URL(receipt.url).origin, url.origin);
      route = '@' + receipt.tabId;
      snapshots.push({ phase: 'desktop-process-restart', ...receipt });
      return;
    }
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail('The owned desktop process did not restart');
}
async function until(accepts, label) {
  const deadline = Date.now() + 30000;
  let value;
  do {
    value = await cdp('eval', route, '--file', probe);
    if (accepts(value)) return value;
    await delay(100);
  } while (Date.now() < deadline);
  await writeFile(path.join(artifacts, 'last-observation.json'), JSON.stringify(value, null, 2));
  await cdp('screenshot', route, path.join(artifacts, 'failed-native-store.png'));
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
const matches = (state, session) =>
  state.sessionId === session.id &&
  state.logicalMessages === 200 &&
  state.renderedMessages === 200 &&
  state.firstMessage === `${session.prefix}_USER_10` &&
  state.lastMessage === `${session.prefix}_ASSISTANT_109_complete_fragment`;
let failure;
let commandAudit;
let commandAuditResult;
try {
  const tab = await cdp('goto', url.href);
  route = '@' + tab.id;
  await cdp('focus', route);
  const connection = await cdp(
    'eval',
    route,
    "const end=Date.now()+20000; let state; do { state=document.querySelector('farm-app')?.connection; if(['connected','auth_required','error'].includes(state)) return {connection:state}; await new Promise(resolve=>setTimeout(resolve,50)); } while(Date.now()<end); return {connection:state};",
  );
  if (connection.connection === 'auth_required') assert((await cdp('login', route)).authenticated);
  const environment = await cdp(
    'eval',
    route,
    "return {desktop:Boolean(window.farmslotDesktop),timeOrigin:performance.timeOrigin,developmentAssets:performance.getEntriesByType('resource').some(entry=>new URL(entry.name).pathname.startsWith('/src/'))}",
  );
  if (desktopControl) {
    assert.equal(environment.desktop, true);
    assert.equal(environment.developmentAssets, false, 'Desktop proof uses production assets');
  }
  if (
    await cdp(
      'eval',
      route,
      "return Boolean(document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('.backdrop'))",
    )
  )
    await cdp('click', route, 'whats-new-modal >>> button.primary');
  await until(
    (state) =>
      state.inventoryIds?.length === sessions.length &&
      sessions.every((session) => state.inventoryIds.includes(session.id)),
    'The real inventory must list every fixture-owned session',
  );
  for (const session of sessions) {
    await cdp(
      'select',
      route,
      'native-session-view >>> [data-testid="native-session-select"]',
      session.nodeId === 'local' ? session.id : JSON.stringify([session.nodeId, session.id]),
    );
    const current = await until(
      (state) =>
        state.status === 'ready' &&
        state.canonical &&
        state.resumeVisible &&
        matches(state, session),
      'The actual native view must render its bounded current history',
    );
    assert.equal(current.storage, 'opfs-sahpool');
    snapshots.push({ phase: 'opened', ...current });
  }
  const selected = sessions.at(-1);
  const saved = await until(
    (state) => state.storedHistoryIds.length === retainedHistories,
    'SQLite must retain the bounded opened histories',
  );
  // Real select typeahead can open intermediate options before committing its requested item.
  // Bound the actual saved inventory and retain the current selection, independent of that order.
  assert(
    saved.storedHistoryIds.every((id) => sessions.some((session) => id.includes(session.id))),
    'Only histories opened from the fixture inventory may be stored',
  );
  assert(saved.storedHistoryIds.some((id) => id.includes(selected.id)));
  assert(saved.observedAt);
  assert.equal(
    saved.resumeDisabled,
    false,
    'The actual Resume action must be available while current',
  );
  await cdp('screenshot', route, path.join(artifacts, 'native-current.png'));
  await withOwnedGatewayOffline(async () => {
    if (desktopControl) await restartDesktop();
    else {
      url.searchParams.set('native-store-cold', randomUUID());
      assert.equal(
        '@' + (await cdp('goto', url.href)).id,
        route,
        'Cold navigation must keep the owned tab',
      );
    }
    await cdp('focus', route);
    if (desktopControl) {
      const coldProcess = await cdp('eval', route, 'return {timeOrigin:performance.timeOrigin}');
      assert.notEqual(coldProcess.timeOrigin, environment.timeOrigin);
    }
    const cold = await until(
      (state) => state.status === 'stale' && state.canonical && matches(state, selected),
      'A new offline document must restore the opened native history',
    );
    snapshots.push({ phase: 'cold', ...cold });
    await cdp('screenshot', route, path.join(artifacts, 'native-cold-offline.png'));
    assert.equal(cold.observedAt, saved.observedAt);
    assert.equal(cold.savedObservedAt, saved.observedAt);
    assert(cold.savedText.includes('Saved conversation history'));
    assert(cold.savedText.includes('Actions wait for a current read'));
    assert.equal(cold.resumeVisible, true);
    assert.equal(cold.resumeDisabled, true);
    assert.equal(cold.inputDisabled, true);
    // Count only commands around the actual disabled action and reconnect, not idle reads.
    commandAudit = cdp(
      'idle-reads',
      route,
      '11000',
      JSON.stringify([
        'native.session.create',
        'native.session.ensure',
        'native.session.send',
        'native.session.respond',
      ]),
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await delay(800);
    const click = await cdp(
      'click',
      route,
      'native-session-view >>> [data-testid="native-resume"]',
      '--allow-disabled',
    );
    assert.equal(click.disabledTargetAllowed, true);
    snapshots.push({ phase: 'stale-resume-click', ...click });
    assert.equal((await cdp('eval', route, '--file', probe)).localCommand, false);
    await cdp('screenshot', route, path.join(artifacts, 'native-cold-offline.png'));
  });
  const recovered = await until(
    (state) =>
      state.status === 'ready' && state.resumeDisabled === false && matches(state, selected),
    'History and action authority must recover through a current read',
  );
  assert.equal(recovered.cursor, saved.cursor);
  snapshots.push({ phase: 'recovered', ...recovered });
  commandAuditResult = await commandAudit;
  if (commandAuditResult.error) throw commandAuditResult.error;
  assert.equal(
    commandAuditResult.value.total,
    0,
    'The stale action must neither send nor replay a command',
  );
  console.log(
    JSON.stringify({
      result: 'PASS',
      actualHostRead: true,
      messages: 200,
      sqliteHistories: retainedHistories,
      nativeOnly,
      desktopColdProcess: Boolean(desktopControl),
      coldHistory: true,
      savedAge: true,
      staleResumeDisabled: true,
      recovery: true,
      commands: 0,
      provenance: fixture.provenance,
    }),
  );
} catch (error) {
  failure = error;
} finally {
  if (commandAudit && !commandAuditResult) commandAuditResult = await commandAudit;
  await writeFile(
    path.join(artifacts, 'native-observations.json'),
    JSON.stringify(snapshots, null, 2),
  );
  await writeFile(
    path.join(artifacts, 'result.json'),
    JSON.stringify(
      {
        result: failure ? 'FAIL' : 'PASS',
        failure: failure?.message,
        commandAudit: commandAuditResult,
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
