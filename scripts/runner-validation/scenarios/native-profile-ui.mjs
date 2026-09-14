import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Methods, NativeSessionEventTypes } from '@farmslot/protocol';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';

export const SCENARIO_ID = 'native-profile-ui';
export const RUNNER_AGNOSTIC = true;
export const PROFILE_UI_MODES = Object.freeze({
  FULL: 'full',
  SETUP_ONLY: 'setup-only',
  PENDING_WRITE: 'write-pending',
});

/** Real browser controls, checked against the private gateway's durable state. */
export async function runScenario({ outDir, timeoutMs = 120000, via }) {
  const mode = via ?? PROFILE_UI_MODES.FULL;
  if (!Object.values(PROFILE_UI_MODES).includes(mode))
    throw new Error(`Unknown native profile UI validation mode: ${mode}`);
  const profileId = `ui-${randomUUID().slice(0, 8)}`;
  const report = { runner: 'claude', profileId, mode, checks: [], pass: false };
  let sessionId;
  const cdp = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: ROOT, encoding: 'utf8', timeout: 30000 },
      ),
    );
  const view =
    "const v=document.querySelector('native-session-view');const r=v?.shadowRoot;const p=r?.querySelector('native-profiles')?.shadowRoot;";
  const inspect = () =>
    cdp(
      'eval',
      'native',
      view +
        `return {
    connected:v?.api?.connectionState==='connected',
    page:performance.timeOrigin,
    catalogReady:!!v?.catalog,
    creating:!!r?.querySelector('[data-testid="native-create"]'),
    createDisabled:r?.querySelector('[data-testid="native-create"]')?.disabled,
    selected:p?.querySelector('select')?.value,
    selectionDisabled:p?.querySelector('select')?.disabled,
    mutationPending:p?.host.mutating,
    signedOut:p?.querySelector('[data-testid="native-profile-status"]')?.textContent.includes('signed-out'),
    sessionId:v?.session?.id,
    messageDisabled:r?.querySelector('[data-testid="native-message"]')?.disabled,
    errors:[...(r?.querySelectorAll('[role="alert"]')??[]),...(p?.querySelectorAll('[role="alert"]')??[])].map(e=>e.textContent.trim())
  };`,
    );
  const click = (selector, profile = false) =>
    cdp(
      'eval',
      'native',
      view +
        `
    const e=${profile ? 'p' : 'r'}?.querySelector(${JSON.stringify(selector)});
    if(!e || e.disabled || !e.getClientRects().length) throw new Error('Control unavailable: '+${JSON.stringify(selector)});
    e.scrollIntoView({block:'center'});
    const rect=e.getBoundingClientRect(), x=rect.x+rect.width/2, y=rect.y+rect.height/2;
    let hit=document.elementFromPoint(x,y);
    while(hit?.shadowRoot){const next=hit.shadowRoot.elementFromPoint(x,y);if(!next||next===hit)break;hit=next;}
    if(!e.contains(hit))throw new Error('Control is covered: '+${JSON.stringify(selector)});
    e.click();return true;`,
    );
  const field = (name, profile = false) =>
    `native-session-view >>> ${profile ? 'native-profiles >>> ' : ''}[data-testid="${name}"]`;
  const choose = (id) => cdp('select', 'native', field('native-profile', true), id);
  const profiles = () => rpc(Methods.NATIVE_PROFILE_LIST).profiles;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.equal(process.env.FARMSLOT_CDP_PORT, '19323');
    const tabs = cdp('tabs');
    assert.ok(tabs.some((tab) => tab.url === 'http://127.0.0.1:18778/#native'));
    const authenticatedId = process.env.FARMSLOT_NATIVE_PROFILE_PROOF;
    assert.ok(authenticatedId);
    const authenticated = rpc(Methods.NATIVE_PROFILE_STATUS, { profileId: authenticatedId });
    assert.equal(authenticated.account.login, 'authenticated');
    assert.equal(authenticated.profile.runner, 'claude');
    const previousPage = inspect().page;
    cdp('eval', 'native', 'location.reload();return true;');
    await wait(inspect, (state) => state.connected && state.page !== previousPage, timeoutMs);
    cdp(
      'eval',
      'native',
      `const modal=document.querySelector('whats-new-modal');
      if(modal?.open)modal.shadowRoot.querySelector('button.primary').click();return true;`,
    );
    click('[data-testid="native-new"]');
    await wait(inspect, (state) => state.creating && state.createDisabled === false, timeoutMs);
    choose(authenticatedId);
    await wait(
      inspect,
      (state) => state.selected === authenticatedId && !state.createDisabled,
      timeoutMs,
    );
    click('[data-testid="native-new"]');
    await wait(inspect, (state) => state.selected === '' && !state.createDisabled, timeoutMs);
    report.checks.push(
      'New session clears the previous profile selection in both form and request state',
    );
    choose(authenticatedId);
    await wait(
      inspect,
      (state) => state.selected === authenticatedId && !state.createDisabled,
      timeoutMs,
    );
    click('details:last-of-type > summary', true);
    cdp('fill', 'native', field('native-profile-name', true), 'Invalid profile label');
    click('[data-testid="native-profile-add"]', true);
    await wait(
      inspect,
      (state) =>
        state.errors.some((error) => error.includes('Profile label must')) &&
        !state.createDisabled &&
        !state.selectionDisabled,
      timeoutMs,
    );
    assert.equal(inspect().selected, authenticatedId);
    report.checks.push('Rejected profile registration restores the previous ready selection');
    cdp('fill', 'native', field('native-profile-name', true), profileId);
    click('[data-testid="native-profile-add"]', true);
    if (mode === PROFILE_UI_MODES.PENDING_WRITE) {
      const pending = inspect();
      assert.equal(
        pending.selectionDisabled,
        true,
        'Profile selection stayed enabled during registration',
      );
      assert.equal(
        pending.createDisabled,
        true,
        'Session creation stayed enabled during registration',
      );
      assert.equal(
        profiles().some((profile) => profile.id === profileId),
        false,
        'Expected the injected registration delay before the real RPC',
      );
      report.checks.push(
        'Pending profile registration blocks stale selection and session creation',
      );
    }
    await wait(inspect, (state) => state.selected === profileId && state.signedOut, timeoutMs);
    assert.equal(inspect().createDisabled, true, 'Signed-out profile enabled session creation');
    const added = profiles().find((profile) => profile.id === profileId);
    assert.ok(added, 'UI add did not persist a profile');
    assert.equal(added.runner, 'claude');
    assert.notEqual(added.accountContextId, authenticated.profile.accountContextId);
    assert.equal(rpc(Methods.NATIVE_PROFILE_STATUS, { profileId }).account.login, 'signed-out');
    assert.equal(fs.existsSync(added.directory), true);
    const login = cdp(
      'eval',
      'native',
      view +
        `return {command:p.querySelector('[data-testid="native-profile-login-command"]')?.textContent};`,
    );
    assert.ok(
      login.command.includes(added.directory),
      'Login command omitted selected profile directory',
    );
    report.checks.push(
      'UI add persists distinct signed-out profile; creation disabled; login command targets its directory',
    );
    click('[data-testid="native-profile-remove"]', true);
    if (mode === PROFILE_UI_MODES.PENDING_WRITE) {
      const pending = inspect();
      assert.equal(
        pending.selectionDisabled,
        true,
        'Profile selection stayed enabled during removal',
      );
      assert.equal(pending.createDisabled, true, 'Session creation stayed enabled during removal');
      assert.equal(
        profiles().some((profile) => profile.id === profileId),
        true,
        'Expected the injected removal delay before the real RPC',
      );
      report.checks.push('Pending profile removal blocks stale selection and session creation');
    }
    await wait(
      () => profiles().some((profile) => profile.id === profileId),
      (exists) => !exists,
      timeoutMs,
    );
    await wait(inspect, (state) => state.selected === '' && !state.createDisabled, timeoutMs);
    assert.equal(
      fs.existsSync(added.directory),
      true,
      'Profile removal deleted native login directory',
    );
    report.checks.push(
      'UI removal deletes mapping, retains directory and restores default selection',
    );

    if (mode === PROFILE_UI_MODES.FULL) {
      choose(authenticatedId);
      await wait(
        inspect,
        (state) => state.selected === authenticatedId && !state.createDisabled,
        timeoutMs,
      );
      cdp(
        'eval',
        'native',
        view +
          `const picker=r.querySelector('runner-model-effort-picker');
        const e=[...(picker.shadowRoot??picker).querySelectorAll('button')].find(e=>e.textContent.trim()==='sonnet');
        if(!e || e.disabled)throw new Error('Sonnet option unavailable');e.click();return true;`,
      );
      const previous = new Set(
        rpc(Methods.NATIVE_SESSION_LIST).sessions.map((session) => session.id),
      );
      click('[data-testid="native-create"]');
      const created = await wait(
        () =>
          rpc(Methods.NATIVE_SESSION_LIST).sessions.find(
            (session) =>
              !previous.has(session.id) &&
              session.profileId === authenticatedId &&
              session.state === 'idle' &&
              session.nativeSessionId,
          ),
        Boolean,
        timeoutMs,
      );
      sessionId = created.id;
      report.sessionId = sessionId;
      assert.equal(created.accountContextId, authenticated.profile.accountContextId);
      assert.equal(created.model, 'sonnet');
      const read = () => rpc(Methods.NATIVE_SESSION_READ, { sessionId });
      await wait(
        inspect,
        (state) => state.sessionId === sessionId && state.messageDisabled === false,
        timeoutMs,
      );
      const token = `UI_PROFILE_${randomUUID().replaceAll('-', '')}`;
      const turn = async (text) => {
        const before = new Set(read().commands.map((command) => command.commandId));
        cdp('fill', 'native', field('native-message'), text);
        await wait(
          () =>
            cdp(
              'eval',
              'native',
              view + `return !r.querySelector('[data-testid="native-send"]')?.disabled;`,
            ),
          Boolean,
          timeoutMs,
        );
        click('[data-testid="native-send"]');
        const page = await wait(
          read,
          (page) =>
            page.session.state === 'idle' &&
            page.commands.some(
              (command) =>
                !before.has(command.commandId) &&
                command.accepted &&
                command.outcome === 'completed',
            ),
          timeoutMs,
        );
        const commands = page.commands.filter((command) => !before.has(command.commandId));
        assert.equal(commands.length, 1, 'One UI send created multiple commands');
        const answer = page.events
          .filter(
            (event) =>
              event.commandId === commands[0].commandId &&
              event.type === NativeSessionEventTypes.TEXT_DELTA,
          )
          .map((event) => event.text ?? '')
          .join('');
        assert.ok(answer.includes(token), 'Native conversation did not retain profile memory');
        await wait(
          () =>
            cdp(
              'eval',
              'native',
              view +
                `return r.querySelector('.timeline')?.textContent.includes(${JSON.stringify(token)});`,
            ),
          Boolean,
          timeoutMs,
        );
      };
      await turn(
        `Remember ${token} for this conversation. Reply with exactly that token; use no tools.`,
      );
      click('[data-testid="native-close"]');
      await wait(read, (page) => page.session.processStopped === true, timeoutMs);
      await wait(
        () =>
          cdp(
            'eval',
            'native',
            view + `return !!r.querySelector('[data-testid="native-resume"]');`,
          ),
        Boolean,
        timeoutMs,
      );
      click('[data-testid="native-resume"]');
      const resumed = await wait(
        read,
        (page) => page.session.state === 'idle' && page.session.generation !== created.generation,
        timeoutMs,
      );
      assert.equal(resumed.session.profileId, authenticatedId);
      assert.equal(resumed.session.accountContextId, authenticated.profile.accountContextId);
      assert.equal(resumed.session.nativeSessionId, created.nativeSessionId);
      await wait(inspect, (state) => state.messageDisabled === false, timeoutMs);
      await turn('Reply with only the token you remembered earlier. Use no tools.');
      report.checks.push(
        'UI model selection, creation, single accepted send, stopped process and resume preserve profile binding and conversation memory',
      );
      click('[data-testid="native-close"]');
      await wait(read, (page) => page.session.processStopped === true, timeoutMs);
    }
    assert.deepEqual(inspect().errors, []);
    report.pass = true;
  } catch (error) {
    report.error = error.message;
    try {
      report.lastUi = inspect();
    } catch (inspectionError) {
      report.inspectionError = inspectionError.message;
    }
  } finally {
    try {
      if (mode === PROFILE_UI_MODES.PENDING_WRITE)
        await wait(inspect, (state) => !state.mutationPending, timeoutMs);
      if (sessionId) {
        rpc(Methods.NATIVE_SESSION_CLOSE, { sessionId });
        assert.equal(rpc(Methods.NATIVE_SESSION_READ, { sessionId }).session.processStopped, true);
      }
      const remaining = profiles().find((profile) => profile.id === profileId);
      if (remaining)
        rpc(Methods.NATIVE_PROFILE_REMOVE, {
          profileId,
          accountContextId: remaining.accountContextId,
        });
    } catch (error) {
      report.pass = false;
      report.cleanupError = error.message;
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, report, outPath };
}
