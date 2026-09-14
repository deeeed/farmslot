import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { Methods } from '@farmslot/protocol';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { connect } from './native-node-broker-smoke.mjs';
import { observePage } from './native-owner-ui.mjs';
export const SCENARIO_ID = 'native-owner-transition-ui';
export const RUNNER_AGNOSTIC = true;

/** Real role/account changes, native history selection and browser input; no UI state writes. */
export async function runScenario({ explicit, outDir }) {
  if (!explicit) return { scenario: SCENARIO_ID, runner: 'native', pass: true, skipped: true };
  assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
  assert.equal(process.env.FARMSLOT_CDP_PORT, '19323');
  assert.equal(process.env.FARMSLOT_UI_URL, 'http://127.0.0.1:18778');
  const ownerToken = process.env.FARMSLOT_GATEWAY_TOKEN;
  assert.ok(ownerToken && process.env.FARMSLOT_NATIVE_DENIAL_ADMIN_TOKEN);
  const admin = await connect(process.env.FARMSLOT_NATIVE_DENIAL_ADMIN_TOKEN, 'ui');
  const ok = async (method, params = {}) => {
    const r = await admin.request(method, params);
    assert.equal(r.ok, true, `${method}: ${r.error?.message ?? 'request refused'}`);
    return r.payload;
  };
  const report = { runner: 'native', pass: false, checks: [], inferenceExpected: false };
  let changed = false;
  let observer;
  let credential;
  const evalPage = async (body) => {
    const r = await observer.send('Runtime.evaluate', {
      expression: `(async()=>{${body}})()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const wait = async (fn, pred) => {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const r = await fn();
      if (pred(r)) return r;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw Error('Timed out waiting for desktop authority state');
  };
  const inspect = () =>
    evalPage(
      `const a=document.querySelector('farm-app');const v=document.querySelector('native-session-view');const resource=performance.getEntriesByType('resource').map(e=>e.name).find(n=>/\\/src\\/state\\.ts(?:\\?|$)/.test(n));if(!resource)return {connection:'loading'};const s=(await import(resource)).getState();return {connection:a.connection,access:v?.api.workspaceAccess,owner:v?.api.authenticatedPrincipalId,slots:s.fleet?.slots.length??0,runs:s.runs.length,prs:s.prs.length,decisions:s.decisions.length,queue:s.queueItems.length,backlog:s.backlogItems.length,graphs:s.workGraphs.length,filters:s.globalFilters,session:v?.session?.id,events:v?.transcript.events.length??0,requests:v?.requests.length??0,draft:v?.draft??'',forbidden:[...document.querySelectorAll('fleet-canvas,run-list,run-detail,slot-view,chat-panel,terminal-split-view,config-panel')].map(e=>e.localName)};`,
    );
  const emptyFarm = (s) => {
    for (const k of ['slots', 'runs', 'prs', 'decisions', 'queue', 'backlog', 'graphs'])
      assert.equal(s[k], 0, k);
    assert.deepEqual(s.filters, { projects: [], machines: [] });
    assert.deepEqual(s.forbidden, []);
  };
  const login = async (token) => {
    await evalPage(
      `document.querySelector('.native-connection summary')?.click();const input=document.querySelector('.auth-input');if(!input)throw Error('Missing auth control');input.focus();input.select();return true;`,
    );
    await observer.send('Input.insertText', { text: token });
    await evalPage(
      `const button=document.querySelector('.auth-submit');if(!button||button.disabled)throw Error('Missing enabled Connect button');button.click();return true;`,
    );
  };
  try {
    const principals = (await ok(Methods.PRINCIPAL_LIST)).principals;
    assert.equal(admin.principalId, 'native-other');
    assert.deepEqual(principals.find((p) => p.id === 'native-owner').roles, [
      { role: 'admin', scope: { kind: 'global' } },
    ]);
    const tabs = await (await fetch('http://127.0.0.1:19323/json')).json();
    const tab = tabs.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:18778/'));
    assert.ok(tab, 'Open the isolated desktop validation page first');
    observer = await observePage(tab.webSocketDebuggerUrl);
    await evalPage("location.hash='#native';return true;");
    await observer.send('Page.reload', { ignoreCache: true });
    await new Promise((r) => setTimeout(r, 1500));
    const before = await wait(
      inspect,
      (s) => s.owner === 'native-owner' && s.access === 'farm' && s.slots > 0 && s.runs > 0,
    );
    report.before = before;
    changed = true;
    await ok(Methods.PRINCIPAL_REVOKE_ROLE, {
      principalId: 'native-owner',
      role: 'admin',
      scope: { kind: 'global' },
    });
    const native = await wait(inspect, (s) => s.owner === 'native-owner' && s.access === 'native');
    emptyFarm(native);
    report.checks.push('Admin to native owner clears previously populated farm state');
    const candidate = await wait(
      () =>
        evalPage(
          `const v=document.querySelector('native-session-view');const s=v.sessions.find(s=>!s.workerManaged&&s.executionNodeId==='native-macpro-validation');return s?JSON.stringify([s.executionNodeId,s.id]):null;`,
        ),
      Boolean,
    );
    execFileSync(
      process.execPath,
      [
        'apps/command-center/scripts/cdp.mjs',
        'select',
        'native',
        'native-session-view >>> select',
        candidate,
      ],
      { cwd: ROOT, env: process.env, stdio: 'pipe' },
    );
    const history = await wait(inspect, (s) => s.events > 0 && !!s.session);
    report.history = { session: history.session, events: history.events };
    const person = (
      await ok(Methods.PRINCIPAL_CREATE, {
        subject: { type: 'person', displayName: 'Private desktop owner transition' },
        roles: [],
      })
    ).principal;
    await ok(Methods.PRINCIPAL_CREATE, {
      subject: {
        type: 'node',
        displayName: 'Private offline authority node',
        machine: 'desktop-authority-' + Date.now(),
        nativeOwnerPrincipalId: person.id,
      },
      roles: [],
    });
    credential = await ok(Methods.CREDENTIAL_ISSUE, {
      principalId: person.id,
      displayName: 'Private desktop transition',
    });
    await login(credential.secret);
    const switched = await wait(inspect, (s) => s.owner === person.id && s.access === 'native');
    emptyFarm(switched);
    assert.equal(switched.session, undefined);
    assert.equal(switched.events, 0);
    assert.equal(switched.requests, 0);
    assert.equal(switched.draft, '');
    report.checks.push('Owner to owner clears the displayed real conversation');
    for (const route of ['runs', 'slot/native-worker-proof', 'dev/native-owner-forbidden']) {
      await evalPage(`location.hash=${JSON.stringify('#' + route)};return true;`);
      await new Promise((r) => setTimeout(r, 200));
      emptyFarm(await inspect());
    }
    report.checks.push('Runs, slot and dev routes cannot mount farm views for the new owner');
    await ok(Methods.CREDENTIAL_REVOKE, { credentialId: credential.credential.id });
    credential = null;
    const revoked = await wait(inspect, (s) => s.connection === 'auth_required');
    emptyFarm(revoked);
    assert.equal(revoked.session, undefined);
    assert.equal(revoked.events, 0);
    report.checks.push(
      'Credential revocation removes the native view and all prior workspace state',
    );
    report.pass = true;
  } catch (e) {
    report.error = e.message;
  } finally {
    try {
      if (changed)
        await ok(Methods.PRINCIPAL_GRANT, {
          principalId: 'native-owner',
          role: 'admin',
          scope: { kind: 'global' },
        });
      if (credential)
        await ok(Methods.CREDENTIAL_REVOKE, { credentialId: credential.credential.id });
      if (observer) {
        const state = await wait(inspect, (s) =>
          ['connected', 'auth_required'].includes(s.connection),
        );
        if (state.owner !== 'native-owner' && !(state.slots > 0)) await login(ownerToken);
        await wait(
          inspect,
          (s) => s.connection === 'connected' && (s.owner === 'native-owner' || s.slots > 0),
        );
        report.restored = true;
      }
    } catch (e) {
      report.pass = false;
      report.cleanupError = e.message;
    }
    observer?.close();
    admin.ws.close();
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
