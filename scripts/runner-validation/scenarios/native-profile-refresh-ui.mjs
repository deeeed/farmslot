import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Methods } from '@farmslot/protocol';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';

export const SCENARIO_ID = 'native-profile-refresh-ui';
export const RUNNER_AGNOSTIC = true;

/** Replaced/missing registrations require explicit selection through the real UI. */
export async function runScenario({ outDir, timeoutMs = 60000 }) {
  const report = { runner: 'native', checks: [], pass: false };
  let original;
  const cdp = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: ROOT, encoding: 'utf8', timeout: 30000 },
      ),
    );
  const roots =
    "const v=document.querySelector('native-session-view');const r=v?.shadowRoot;const p=r?.querySelector('native-profiles')?.shadowRoot;";
  const readUi = () =>
    cdp(
      'eval',
      'native',
      roots +
        `return {
    node:v?.executionNodeId,
    profile:p?.querySelector('select')?.value,
    selectedOptions:[...(p?.querySelector('select')?.options??[])].filter(o=>o.value===p.querySelector('select').value).length,
    disabled:r?.querySelector('[data-testid=native-create]')?.disabled,
    registration:v?.profile?.accountContextId,
    updated:!!p?.querySelector('[data-testid=native-profile-use-updated]'),
    error:p?.querySelector('[role=alert]')?.textContent.trim()
  };`,
    );
  const click = (selector, profile = false) =>
    cdp(
      'eval',
      'native',
      roots +
        `
    const button=${profile ? 'p' : 'r'}?.querySelector(${JSON.stringify(selector)});
    if(!button||button.disabled)throw new Error('Control unavailable');
    button.scrollIntoView({block:'center'});button.click();return true;`,
    );
  const choose = (id) =>
    cdp(
      'select',
      'native',
      'native-session-view >>> native-profiles >>> [data-testid=native-profile]',
      id,
    );
  const list = () => rpc(Methods.NATIVE_PROFILE_LIST).profiles;
  const remove = (profile) =>
    rpc(Methods.NATIVE_PROFILE_REMOVE, {
      profileId: profile.id,
      accountContextId: profile.accountContextId,
    });
  const add = () =>
    rpc(Methods.NATIVE_PROFILE_ADD, {
      profileId: original.id,
      runner: original.runner,
      directory: original.directory,
    }).profile;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.equal(process.env.FARMSLOT_CDP_PORT, '19323');
    original = list().find((profile) => profile.id === process.env.FARMSLOT_NATIVE_PROFILE_PROOF);
    assert.ok(original && original.state === 'active');
    const sessions = rpc(Methods.NATIVE_SESSION_LIST, { executionNodeId: 'local' }).sessions.filter(
      (session) => session.profileId === original.id,
    );
    assert.ok(
      sessions.every(
        (session) =>
          ['closed', 'failed'].includes(session.state) &&
          (!session.processPid || session.processStopped),
      ),
      'Stop this private profile before replacing it',
    );
    cdp('goto', 'native');
    cdp(
      'eval',
      'native',
      "document.querySelector('whats-new-modal')?.shadowRoot.querySelector('button.primary')?.click();return true;",
    );
    click('[data-testid=native-new]');
    await wait(readUi, (state) => state.disabled === false, timeoutMs);
    if (readUi().node !== 'local')
      cdp('select', 'native', 'native-session-view >>> [data-testid=native-context]', ROOT);
    await wait(readUi, (state) => state.node === 'local' && state.disabled === false, timeoutMs);
    choose(original.id);
    await wait(
      readUi,
      (state) => !state.disabled && state.registration === original.accountContextId,
      timeoutMs,
    );
    remove(original);
    click('[data-testid=native-profile-refresh]', true);
    const missing = await wait(readUi, (state) => !!state.error, timeoutMs);
    assert.equal(missing.disabled, true);
    assert.equal(missing.profile, original.id, 'Missing selection looked like the default account');
    assert.equal(missing.selectedOptions, 1, 'Missing profile must have one unavailable option');
    choose('');
    await wait(readUi, (state) => state.profile === '' && !state.disabled, timeoutMs);
    report.checks.push(
      'Missing profile stays visibly unavailable and blocks create; explicit default selection recovers',
    );

    const first = add();
    click('[data-testid=native-profile-refresh]', true);
    await wait(
      () =>
        cdp(
          'eval',
          'native',
          roots +
            `return [...p.querySelector('select').options].some(option=>option.value===${JSON.stringify(first.id)});`,
        ),
      Boolean,
      timeoutMs,
    );
    choose(first.id);
    await wait(
      readUi,
      (state) => state.registration === first.accountContextId && !state.disabled,
      timeoutMs,
    );
    remove(first);
    const replacement = add();
    click('[data-testid=native-profile-refresh]', true);
    const changed = await wait(readUi, (state) => state.updated && !!state.error, timeoutMs);
    assert.equal(changed.disabled, true, 'Read-only refresh accepted a replaced registration');
    assert.equal(changed.profile, replacement.id);
    click('[data-testid=native-profile-use-updated]', true);
    const accepted = await wait(
      readUi,
      (state) => !state.disabled && state.registration === replacement.accountContextId,
      timeoutMs,
    );
    assert.equal(accepted.error, undefined);
    assert.equal(fs.existsSync(original.directory), true);
    report.checks.push(
      'Replaced registration stays blocked until Use updated profile checks its current native login',
    );
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'selection-proof.json'),
      JSON.stringify({ missing, changed, accepted }, null, 2),
    );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (original) {
      try {
        const current = list().find((profile) => profile.id === original.id);
        if (!current) add();
        else assert.equal(current.state, 'active', 'Profile retirement requires recovery');
      } catch (error) {
        report.pass = false;
        report.cleanupError = error.message;
      }
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, report, outPath };
}
