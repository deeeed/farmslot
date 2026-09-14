import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Methods } from '@farmslot/protocol';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';

export const SCENARIO_ID = 'native-profile-stale-reply-ui';
export const RUNNER_AGNOSTIC = true;

export async function runScenario({
  outDir,
  timeoutMs = 30000,
  expectListGuard = true,
  expectStatusGuard = true,
}) {
  const report = { runner: 'native', checks: [], pass: false };
  let temporary;
  const fault = process.env.FARMSLOT_NATIVE_PROFILE_REPLY_FAULT;
  const gatewayPid = Number(process.env.FARMSLOT_NATIVE_PROFILE_REPLY_PID);
  assert.ok(
    fault && path.resolve(fault).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
  );
  assert.ok(fs.existsSync(`${fault}.${gatewayPid}.loaded`), 'Load the private reply-delay fixture');
  const cdp = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: ROOT, encoding: 'utf8', timeout: 30000 },
      ),
    );
  const roots =
    "const v=document.querySelector('native-session-view');const r=v?.shadowRoot;const p=r?.querySelector('native-profiles');const s=p?.shadowRoot;";
  const inspect = () =>
    cdp(
      'eval',
      'native',
      `
    const v=document.querySelector('native-session-view');await v?.updateComplete;
    const r=v?.shadowRoot;const p=r?.querySelector('native-profiles');await p?.updateComplete;const s=p?.shadowRoot;
    return {node:v?.executionNodeId,profile:v?.profile?.id,selected:s?.querySelector('select')?.value,
      disabled:r?.querySelector('[data-testid=native-create]')?.disabled,
      status:s?.querySelector('[data-testid=native-profile-status]')?.textContent.trim(),
      options:[...(s?.querySelector('select')?.options??[])].map(o=>o.value),
      contexts:[...(r?.querySelector('[data-testid=native-context]')?.options??[])].map(o=>o.value),
      pending:[...(v?.api?.pending?.keys()??[])],profileRevision:p?.revision,viewRevision:v?.revision,
      listGuard:!!p?.refresh?.toString().match(/revision\\s*!==\\s*this\\.revision/),
      statusGuard:!!p?.choose?.toString().match(/revision\\s*!==\\s*this\\.revision/)};`,
    );
  const click = (selector) =>
    cdp(
      'eval',
      'native',
      roots +
        `
    const e=r?.querySelector(${JSON.stringify(selector)})??s?.querySelector(${JSON.stringify(selector)});
    if(!e||e.disabled)throw new Error('Control unavailable');e.scrollIntoView({block:'center'});e.click();return true;`,
    );
  const choose = (id) =>
    cdp(
      'select',
      'native',
      'native-session-view >>> native-profiles >>> [data-testid=native-profile]',
      id,
    );
  const arm = (method, profileId) => {
    assert.equal(fs.existsSync(fault), false);
    fs.writeFileSync(
      fault,
      JSON.stringify({ gatewayPid, method, profileId, executionNodeId: 'local' }),
      { mode: 0o600 },
    );
  };
  const held = () =>
    wait(
      () =>
        fs.existsSync(`${fault}.held`)
          ? JSON.parse(fs.readFileSync(`${fault}.held`, 'utf8'))
          : undefined,
      Boolean,
      timeoutMs,
    );
  const release = async (receipt) => {
    assert.ok(
      inspect().pending.includes(receipt.requestId),
      'The old request timed out before its response was released',
    );
    fs.writeFileSync(`${fault}.release`, 'release\n');
    const released = await wait(
      () =>
        fs.existsSync(`${fault}.released`)
          ? JSON.parse(fs.readFileSync(`${fault}.released`, 'utf8'))
          : undefined,
      Boolean,
      timeoutMs,
    );
    assert.equal(released.delivered, true);
    assert.equal(released.requested, true, 'The fixture timed out instead of following the recipe');
    await wait(inspect, (state) => !state.pending.includes(receipt.requestId), timeoutMs);
    cdp(
      'eval',
      'native',
      'await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);return true;',
    );
    return inspect();
  };
  const archive = (name) => {
    fs.mkdirSync(path.join(outDir, name), { recursive: true });
    for (const suffix of ['', '.held', '.release', '.released']) {
      const file = fault + suffix;
      if (fs.existsSync(file)) fs.renameSync(file, path.join(outDir, name, path.basename(file)));
    }
  };
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.equal(process.env.FARMSLOT_CDP_PORT, '19323');
    const profileId = process.env.FARMSLOT_NATIVE_PROFILE_PROOF;
    const otherId = process.env.FARMSLOT_NATIVE_PROFILE_OTHER;
    assert.ok(profileId && otherId && profileId !== otherId);
    assert.equal(rpc(Methods.NATIVE_PROFILE_STATUS, { profileId }).account.login, 'authenticated');
    assert.equal(
      rpc(Methods.NATIVE_PROFILE_STATUS, { profileId: otherId }).account.login,
      'signed-out',
    );
    const sessionIds = () =>
      ['local', 'native-macpro-validation']
        .flatMap((executionNodeId) => {
          const result = rpc(Methods.NATIVE_SESSION_LIST, { executionNodeId });
          assert.equal(
            result.unavailableExecutionNodes?.length ?? 0,
            0,
            'Both fixture nodes must be available for the session census',
          );
          return result.sessions.map((session) => `${executionNodeId}:${session.id}`);
        })
        .sort();
    cdp('goto', 'native');
    const page = cdp('eval', 'native', 'return performance.timeOrigin;');
    cdp('eval', 'native', 'setTimeout(()=>location.reload(),20);return true;');
    await wait(
      () => cdp('eval', 'native', 'return performance.timeOrigin;'),
      (current) => current !== page,
      timeoutMs,
    );
    cdp(
      'eval',
      'native',
      "document.querySelector('whats-new-modal')?.shadowRoot.querySelector('button.primary')?.click();return true;",
    );
    await wait(
      () => cdp('eval', 'native', roots + "return !!r?.querySelector('[data-testid=native-new]');"),
      Boolean,
      timeoutMs,
    );
    click('[data-testid=native-new]');
    await wait(inspect, (state) => !!state.contexts.length, timeoutMs);
    if (inspect().node !== 'local') {
      const local = inspect().contexts.find((value) => value.startsWith('/'));
      assert.ok(local);
      cdp('select', 'native', 'native-session-view >>> [data-testid=native-context]', local);
    }
    await wait(
      () => inspect().contexts.some((value) => value.includes('native-macpro-validation')),
      Boolean,
      timeoutMs,
    );
    const beforeIds = sessionIds();
    await wait(
      inspect,
      (state) =>
        state.node === 'local' && state.options.includes(profileId) && state.disabled === false,
      timeoutMs,
    );
    assert.equal(
      inspect().listGuard,
      expectListGuard,
      'The browser did not load the intended inventory guard',
    );
    assert.equal(
      inspect().statusGuard,
      expectStatusGuard,
      'The browser did not load the intended login guard',
    );
    arm(Methods.NATIVE_PROFILE_STATUS, profileId);
    choose(profileId);
    const statusReceipt = await held();
    assert.equal(inspect().disabled, true);
    choose(otherId);
    await wait(
      inspect,
      (state) => state.selected === otherId && state.status?.includes('signed-out'),
      timeoutMs,
    );
    const status = await release(statusReceipt);
    assert.equal(status.selected, otherId);
    assert.equal(status.profile, otherId, 'Late login response replaced the chosen profile');
    assert.equal(
      status.disabled,
      true,
      'Late authenticated response enabled the signed-out profile',
    );
    assert.ok(status.status.includes('signed-out'));
    report.checks.push(
      'A delayed actual login response cannot replace or enable the subsequently chosen signed-out profile',
    );
    archive('status');

    choose(profileId);
    await wait(
      inspect,
      (state) => state.selected === profileId && state.disabled === false,
      timeoutMs,
    );
    temporary = rpc(Methods.NATIVE_PROFILE_ADD, {
      profileId: `reply-${randomUUID().slice(0, 8)}`,
      runner: 'claude',
    }).profile;
    click('[data-testid=native-profile-refresh]');
    await wait(
      inspect,
      (state) => state.options.includes(temporary.id) && !state.disabled,
      timeoutMs,
    );
    arm(Methods.NATIVE_PROFILE_LIST);
    click('[data-testid=native-profile-refresh]');
    const olderInventory = await held();
    assert.ok(olderInventory.profileIds.includes(temporary.id));
    rpc(Methods.NATIVE_PROFILE_REMOVE, {
      profileId: temporary.id,
      accountContextId: temporary.accountContextId,
    });
    choose('');
    await wait(inspect, (state) => state.selected === '' && state.disabled === false, timeoutMs);
    click('[data-testid=native-profile-refresh]');
    await wait(
      inspect,
      (state) => !state.options.includes(temporary.id) && !state.disabled,
      timeoutMs,
    );
    const freshInventory = await release(olderInventory);
    assert.equal(
      freshInventory.options.includes(temporary.id),
      false,
      'Late profile inventory revived a removed registration',
    );
    report.checks.push(
      'An older same-node inventory cannot replace a refreshed list or revive a removed profile',
    );
    archive('inventory');

    const remote = await wait(
      () => inspect().contexts.find((value) => value.includes('native-macpro-validation')),
      Boolean,
      timeoutMs,
    );
    arm(Methods.NATIVE_PROFILE_LIST);
    click('[data-testid=native-profile-refresh]');
    const listReceipt = await held();
    assert.ok(
      listReceipt.profileIds.includes(otherId),
      'The held reply must contain the old local profiles',
    );
    cdp('select', 'native', 'native-session-view >>> [data-testid=native-context]', remote);
    await wait(
      inspect,
      (state) =>
        state.node === 'native-macpro-validation' &&
        state.options.includes('empty-claude') &&
        !state.options.includes(otherId),
      timeoutMs,
    );
    const listBefore = inspect();
    const list = await release(listReceipt);
    report.listObservation = { before: listBefore, after: list, receipt: listReceipt };
    assert.equal(list.node, 'native-macpro-validation');
    assert.equal(
      list.options.includes(otherId),
      false,
      'Late local inventory replaced the remote profile choices',
    );
    assert.ok(list.options.includes('empty-claude'));
    report.checks.push(
      'A delayed local profile inventory cannot overwrite a new execution node selection',
    );
    archive('list');
    assert.deepEqual(sessionIds(), beforeIds, 'Profile selection unexpectedly launched a session');
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (fs.existsSync(fault)) {
      fs.writeFileSync(`${fault}.release`, 'release\n');
      if (fs.existsSync(`${fault}.held`))
        await wait(() => fs.existsSync(`${fault}.released`), Boolean, timeoutMs);
      archive('cleanup');
    }
    if (temporary) {
      const current = rpc(Methods.NATIVE_PROFILE_LIST).profiles.find(
        (profile) => profile.id === temporary.id,
      );
      if (current)
        rpc(Methods.NATIVE_PROFILE_REMOVE, {
          profileId: current.id,
          accountContextId: current.accountContextId,
        });
      if (fs.existsSync(temporary.directory) && !fs.readdirSync(temporary.directory).length)
        fs.rmdirSync(temporary.directory);
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, report, outPath };
}
