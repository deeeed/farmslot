import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isTerminalRunStatus, Methods } from '@farmslot/protocol';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export const SCENARIO_ID = 'native-worker-profile-ui';
export const WORKER_PROFILE_UI_MODES = Object.freeze({
  SETUP: 'setup',
  QUEUE: 'queue',
  DISPATCH: 'dispatch',
});

/** Native profile selection through real dispatch controls and durable gateway records. */
export async function runScenario({
  runnerAdapter,
  slotId,
  model,
  outDir,
  timeoutMs = 120000,
  via,
}) {
  const mode = via ?? WORKER_PROFILE_UI_MODES.SETUP;
  assert.ok(
    Object.values(WORKER_PROFILE_UI_MODES).includes(mode),
    'Unknown worker profile UI mode',
  );
  const report = { runner: runnerAdapter.RUNNER_ID, mode, checks: [], pass: false };
  const cdp = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: ROOT, encoding: 'utf8', timeout: 30000 },
      ),
    );
  const inspect = () =>
    cdp(
      'eval',
      'dispatch',
      '--file',
      path.join(ROOT, 'apps/command-center/scripts/probes/dispatch-native-profile.js'),
    );
  const profilePath = 'dispatch-wizard >>> dispatch-native-profiles >>> native-profiles >>> ';
  const chooseProfile = (id) =>
    cdp('select', 'dispatch', profilePath + '[data-testid=native-profile]', id);
  const click = (expression) =>
    cdp(
      'eval',
      'dispatch',
      `const root=document.querySelector('dispatch-wizard')?.shadowRoot;const control=${expression};if(!control||control.disabled)throw new Error('Control unavailable');control.scrollIntoView({block:'center'});const rect=control.getBoundingClientRect();let hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);while(hit?.shadowRoot){const next=hit.shadowRoot.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);if(!next||next===hit)break;hit=next;}if(!control.contains(hit))throw new Error('Control is covered');control.click();return true;`,
    );
  const clickRunner = (runner) =>
    click(
      `Array.from(root.querySelector('runner-model-effort-picker').shadowRoot.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(runner)})`,
    );
  const signedOutId = `worker-ui-${randomUUID().slice(0, 8)}`;
  let signedOut;
  let node;
  let queueId;
  let runId;
  let ticket;
  const findRun = () =>
    ticket
      ? rpc(Methods.RUN_LIST, { limit: 50 }).runs.find(
          (run) =>
            run.ticketOrPr === ticket || run.engineState?.interactiveDev?.initialContext === ticket,
        )
      : undefined;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.equal(process.env.FARMSLOT_CDP_PORT, '19323');
    assert.equal(new URL(process.env.FARMSLOT_UI_URL).origin, 'http://127.0.0.1:18778');
    const slot = rpc(Methods.FLEET_STATUS).fleet.slots.find((item) => item.slot === slotId);
    assert.ok(
      slot && !slot.currentRunId && slot.lifecycle === 'ready',
      'Use an idle private fixture slot',
    );
    assert.ok(
      fs
        .realpathSync(slot.repo)
        .startsWith(fs.realpathSync(path.join(ROOT, 'temp/native-validation')) + path.sep),
    );
    const catalog = rpc(Methods.NATIVE_SESSION_CATALOG);
    const context = catalog.contexts.find((item) => item.slotId === slotId);
    assert.equal(context?.supportsProfiles, true);
    node = context.executionNodeId ?? 'local';
    const profileId = process.env.FARMSLOT_NATIVE_WORKER_PROFILE;
    assert.ok(profileId);
    const authenticated = rpc(Methods.NATIVE_PROFILE_STATUS, { executionNodeId: node, profileId });
    assert.equal(authenticated.account.login, 'authenticated');
    assert.equal(authenticated.profile.runner, report.runner);
    const reference = {
      executionNodeId: node,
      runner: report.runner,
      profileId,
      accountContextId: authenticated.profile.accountContextId,
    };
    signedOut = rpc(Methods.NATIVE_PROFILE_ADD, {
      executionNodeId: node,
      profileId: signedOutId,
      runner: report.runner,
    }).profile;
    assert.equal(
      rpc(Methods.NATIVE_PROFILE_STATUS, { executionNodeId: node, profileId: signedOutId }).account
        .login,
      'signed-out',
    );
    ticket = `Reply with WORKER_PROFILE_UI_${randomUUID()} and wait for further input. Do not write a completion signal, modify files or execute commands.`;
    const query = new URLSearchParams({
      flow: 'dev',
      project: slot.project,
      slot: slotId,
      ticket,
      transport: 'native',
    });
    cdp('goto', `dispatch?${query}`);
    // Hash-only navigation retains the form draft. Reload through the browser
    // and verify the displayed task before any submission.
    const previousPage = inspect().page;
    cdp('eval', 'dispatch', 'location.reload();return true;');
    await wait(inspect, (state) => state.page !== previousPage && state.catalogReady, timeoutMs);
    cdp(
      'eval',
      'dispatch',
      "const modal=document.querySelector('whats-new-modal');if(modal?.open)modal.shadowRoot.querySelector('button.primary').click();return true;",
    );
    await wait(
      inspect,
      (state) => state.catalogReady && state.slotId === slotId && state.profileMounted,
      timeoutMs,
    );
    clickRunner(report.runner);
    if (model)
      click(
        `Array.from(root.querySelector('runner-model-effort-picker').shadowRoot.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(model)})`,
      );
    click(
      "Array.from(root.querySelector('slot-prepare-options').shadowRoot.querySelectorAll('button')).find(e=>e.textContent.trim()==='Skip Prepare')",
    );
    await wait(
      inspect,
      (state) =>
        state.runner === report.runner && state.profiles.some((item) => item.id === profileId),
      timeoutMs,
    );
    const profileRefresh =
      "root.querySelector('dispatch-native-profiles').shadowRoot.querySelector('native-profiles').shadowRoot.querySelector('[data-testid=native-profile-refresh]')";
    await wait(
      () =>
        cdp(
          'eval',
          'dispatch',
          `const root=document.querySelector('dispatch-wizard').shadowRoot;return !${profileRefresh}.disabled;`,
        ),
      Boolean,
      timeoutMs,
    );
    click(profileRefresh);
    await wait(
      inspect,
      (state) => state.profiles.some((item) => item.id === signedOutId),
      timeoutMs,
    );
    chooseProfile(profileId);
    const ready = await wait(
      inspect,
      (state) =>
        state.selectedProfile === profileId &&
        state.selection?.ready &&
        !state.dispatchDisabled &&
        !state.queueDisabled,
      timeoutMs,
    );
    assert.deepEqual(ready.selection.profile, reference);
    assert.equal(ready.ticket, ticket, 'Displayed task does not match this proof');
    chooseProfile(signedOutId);
    const refused = await wait(
      inspect,
      (state) =>
        state.selectedProfile === signedOutId && state.profileStatus?.includes('signed-out'),
      timeoutMs,
    );
    assert.equal(refused.dispatchDisabled, true, 'Signed-out profile exposed direct dispatch');
    assert.equal(refused.queueDisabled, true, 'Signed-out profile exposed queued dispatch');
    report.checks.push(
      'authenticated profile binds runner/node/registration; signed-out profile blocks both dispatch and queue',
    );
    chooseProfile(profileId);
    await wait(
      inspect,
      (state) => state.selection?.ready && state.selectedProfile === profileId,
      timeoutMs,
    );
    cdp('select', 'dispatch', 'dispatch-wizard >>> [data-testid=dispatch-transport]', 'tmux');
    const terminal = await wait(
      inspect,
      (state) => state.transport === 'tmux' && !state.profileMounted,
      timeoutMs,
    );
    assert.equal(terminal.selection, null);
    cdp('select', 'dispatch', 'dispatch-wizard >>> [data-testid=dispatch-transport]', 'native');
    await wait(
      inspect,
      (state) => state.profileMounted && state.selectedProfile === '' && state.selection?.ready,
      timeoutMs,
    );
    report.checks.push(
      'terminal selection clears the native profile; returning to native starts with the displayed default account',
    );
    click(
      "Array.from(root.querySelector('slot-choice-list').shadowRoot.querySelectorAll('slot-choice-row')).find(e=>e.slotId==='Any eligible')?.shadowRoot.querySelector('button')",
    );
    await wait(inspect, (state) => state.slotId === '' && state.nodeDisabled === false, timeoutMs);
    cdp(
      'select',
      'dispatch',
      'dispatch-wizard >>> dispatch-native-profiles >>> [data-testid=dispatch-native-node]',
      node,
    );
    await wait(inspect, (state) => state.node === node && state.profileMounted, timeoutMs);
    chooseProfile(profileId);
    const automatic = await wait(
      inspect,
      (state) =>
        state.selection?.ready && state.selectedProfile === profileId && !state.dispatchDisabled,
      timeoutMs,
    );
    const nodeSlots = new Set(
      catalog.contexts
        .filter(
          (item) => (item.executionNodeId ?? 'local') === node && item.project === slot.project,
        )
        .map((item) => item.slotId),
    );
    assert.ok(
      automatic.allowedSlots.length > 0 && automatic.allowedSlots.every((id) => nodeSlots.has(id)),
    );
    report.checks.push(
      'automatic slot selection constrains allowed slots to the explicitly chosen profile node',
    );
    // Pin the private slot before submitting; this fixture never chooses another live workspace.
    click(
      `Array.from(root.querySelector('slot-choice-list').shadowRoot.querySelectorAll('slot-choice-row')).find(e=>e.slotId===${JSON.stringify(slotId)})?.shadowRoot.querySelector('button')`,
    );
    await wait(inspect, (state) => state.slotId === slotId && state.selection?.ready, timeoutMs);
    chooseProfile(profileId);
    const submitted = await wait(
      inspect,
      (state) => state.selection?.ready && !state.dispatchDisabled && !state.queueDisabled,
      timeoutMs,
    );
    assert.deepEqual(submitted.selection.profile, reference);
    cdp('screenshot', 'dispatch', path.join(outDir, 'worker-profile-dispatch.png'));
    if (mode === WORKER_PROFILE_UI_MODES.QUEUE) {
      click("root.querySelector('[data-testid=dispatch-queue]')");
      const queued = await wait(
        () => ({
          item: rpc(Methods.DISPATCH_QUEUE_LIST).items.find((item) => item.ticketOrPr === ticket),
          run: findRun(),
        }),
        (state) => Boolean(state.item || state.run),
        timeoutMs,
      );
      queueId = queued.item?.id;
      runId = queued.item?.runId ?? queued.run?.id;
      const persisted = queued.item ?? queued.run;
      assert.deepEqual(persisted.nativeProfile, reference);
      assert.equal(persisted.transport, 'native');
      report.checks.push(
        'real Queue action preserves the displayed profile in its queued item or consumed run',
      );
    } else if (mode === WORKER_PROFILE_UI_MODES.DISPATCH) {
      click("root.querySelector('[data-testid=dispatch-submit]')");
      const run = await wait(findRun, Boolean, timeoutMs);
      runId = run.id;
      assert.deepEqual(run.nativeProfile, reference);
      assert.equal(run.transport, 'native');
      assert.equal(run.slotId, slotId);
      report.checks.push(
        'real Dispatch action creates a native run with the displayed profile and private slot',
      );
    }
    if (mode !== WORKER_PROFILE_UI_MODES.SETUP) {
      const launched = await wait(
        findRun,
        (run) => {
          if (!run) return false;
          runId = run.id;
          assert.ok(!['failed', 'cancelled'].includes(run.status), run.error);
          return run.agentContexts?.some((context) => context.nativeSession?.acceptedAt);
        },
        timeoutMs,
      );
      const context = launched.agentContexts.find((context) => context.nativeSession?.acceptedAt);
      const binding = context.nativeSession;
      assert.deepEqual(binding.profile, reference);
      const page = rpc(
        Methods.NATIVE_SESSION_READ,
        pinnedWorkerTarget(runId, context.id, binding.leaseId),
      );
      assert.equal(page.session.profileId, reference.profileId);
      assert.equal(page.session.accountContextId, reference.accountContextId);
      report.checks.push(
        'UI submission reaches an accepted native worker under the displayed profile',
      );
    }
    fs.writeFileSync(
      path.join(outDir, 'worker-profile-form.json'),
      JSON.stringify({ ready, refused, terminal, automatic, submitted, runId, queueId }, null, 2),
    );
    report.pass = true;
  } catch (error) {
    report.error = error.stack ?? String(error);
  } finally {
    try {
      if (queueId) {
        const item = rpc(Methods.DISPATCH_QUEUE_LIST).items.find((item) => item.id === queueId);
        runId ??= item?.runId;
        if (item) rpc(Methods.DISPATCH_QUEUE_REMOVE, { itemId: queueId });
      }
      runId ??= findRun()?.id;
      report.runId = runId;
      report.queueId = queueId;
      if (runId) {
        let run = rpc(Methods.RUN_GET, { runId }).run;
        if (!isTerminalRunStatus(run.status)) {
          const cancelled = rpc(Methods.RUN_CANCEL, { runId });
          assert.ok(cancelled.effects.every((effect) => effect.status !== 'failed'));
        }
        run = rpc(Methods.RUN_GET, { runId }).run;
        for (const context of run.agentContexts ?? []) {
          const binding = context.nativeSession;
          if (!binding?.generation) continue;
          assert.equal(
            rpc(Methods.NATIVE_SESSION_READ, pinnedWorkerTarget(runId, context.id, binding.leaseId))
              .session.processStopped,
            true,
          );
        }
      }
      if (signedOut)
        rpc(Methods.NATIVE_PROFILE_REMOVE, {
          executionNodeId: node,
          profileId: signedOut.id,
          accountContextId: signedOut.accountContextId,
        });
    } catch (error) {
      report.pass = false;
      report.cleanupError = error.stack ?? String(error);
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
