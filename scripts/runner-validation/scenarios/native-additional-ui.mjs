import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createAgentDeviceClient } from 'agent-device';

import { Methods } from '@farmslot/protocol';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';

export const SCENARIO_ID = 'native-additional-ui';
export const RUNNER_AGNOSTIC = true;

/** Actual creation controls expose each runner's supported modes without launching inference. */
export async function runScenario({ explicit, outDir }) {
  if (!explicit) return { scenario: SCENARIO_ID, runner: 'native', skipped: true, pass: true };
  const report = { runner: 'native', pass: false, checks: [], inferenceExpected: false };
  const cdp = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 30000 },
      ),
    );
  const desktopRunner = (runner) =>
    cdp(
      'eval',
      'native',
      `const v=document.querySelector('native-session-view');const p=v.shadowRoot.querySelector('runner-model-effort-picker');const b=[...p.shadowRoot.querySelectorAll('button')].find(item=>item.textContent.trim()===${JSON.stringify(runner)});if(!b||b.disabled)throw Error('Runner control is unavailable');b.click();await v.updateComplete;return {runner:v.runner,mode:v.mode,modes:[...v.shadowRoot.querySelectorAll('select option')].filter(o=>['default','plan'].includes(o.value)).map(o=>({value:o.value,disabled:o.disabled})),models:[...p.shadowRoot.querySelectorAll('.config-group')][1]?.textContent.trim()};`,
    );
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.equal(process.env.FARMSLOT_CDP_PORT, '19323');
    assert.equal(process.env.IOS_SIMULATOR, '842A0B52-C423-4C61-B6ED-5011E29C021E');
    fs.mkdirSync(outDir, { recursive: true });
    const catalog = rpc(Methods.NATIVE_SESSION_CATALOG);
    await wait(
      () =>
        cdp(
          'eval',
          'native',
          "const view=document.querySelector('native-session-view');const select=view?.shadowRoot.querySelector('select');return Boolean(view?.catalog && select && !select.disabled && select.getClientRects().length);",
        ),
      Boolean,
      30000,
    );
    const selectedSession = cdp(
      'eval',
      'native',
      "return {value:document.querySelector('native-session-view').shadowRoot.querySelector('select').value};",
    );
    if (selectedSession.value) cdp('select', 'native', 'native-session-view >>> select', '');
    for (const runner of ['cursor', 'grok']) {
      const capability = catalog.runners.find((item) => item.runner === runner);
      assert.deepEqual(capability.modes, ['default']);
      assert.equal(capability.supportsWorkers, false);
      assert.equal(capability.supportsQueuedWorkers, false);
      desktopRunner('codex');
      cdp('select', 'native', 'native-session-view >>> select:has(option[value="plan"])', 'plan');
      const rendered = desktopRunner(runner);
      assert.equal(rendered.runner, runner);
      assert.equal(rendered.mode, 'default');
      assert.deepEqual(rendered.modes, [{ value: 'default', disabled: false }]);
      assert.ok(rendered.models?.includes(capability.defaultModel));
      report.checks.push(
        `Desktop ${runner}: advertised models, unsupported Plan unavailable, previous Plan selection cleared`,
      );
      cdp('screenshot', 'native', path.join(outDir, `desktop-${runner}.png`));
    }
    desktopRunner('codex');
    const device = createAgentDeviceClient({
      stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR,
    });
    const selection = {
      session: 'farmslot-owner-transition',
      platform: 'ios',
      target: 'mobile',
      udid: process.env.IOS_SIMULATOR,
    };
    await device.apps.open({
      ...selection,
      app: 'net.siteed.farmslot.development',
      noRecord: true,
    });
    const snapshot = () =>
      device.capture.snapshot({ ...selection, interactiveOnly: false, forceFull: true });
    execFileSync(
      'xcrun',
      ['simctl', 'openurl', selection.udid, 'farmslot-development:///connection'],
      { stdio: 'pipe' },
    );
    await wait(
      snapshot,
      (page) => page.nodes.some((item) => item.identifier === 'companion-native-connection-screen'),
      30000,
    );
    execFileSync('xcrun', ['simctl', 'openurl', selection.udid, 'farmslot-development:///native'], {
      stdio: 'pipe',
    });
    const reveal = (id, direction) =>
      execFileSync(
        process.execPath,
        [
          path.join(ROOT, 'apps/companion/scripts/agentic/native-profile-reveal.mjs'),
          id,
          direction,
        ],
        { env: process.env, stdio: 'pipe', timeout: 30000 },
      );
    const press = async (id) => {
      reveal(id, 'up');
      const nodes = (await snapshot()).nodes;
      const node = nodes.find((item) => item.identifier === id && item.rect);
      assert.ok(node, `Missing native control ${id}`);
      await device.interactions.press({
        ...selection,
        x: node.rect.x + node.rect.width / 2,
        y: node.rect.y + node.rect.height / 2,
      });
    };
    await wait(
      snapshot,
      (page) => page.nodes.some((item) => item.identifier === 'companion-native-setup'),
      30000,
    );
    for (const runner of ['cursor', 'grok']) {
      await press('companion-native-runner-codex');
      reveal('companion-native-mode-plan', 'down');
      await press('companion-native-mode-plan');
      await press(`companion-native-runner-${runner}`);
      const selected = await snapshot();
      assert.ok(
        selected.nodes.some(
          (item) =>
            item.identifier === `companion-native-runner-${runner}` && item.label?.startsWith('✓ '),
        ),
      );
      reveal('companion-native-create', 'down');
      const page = await snapshot();
      assert.ok(
        page.nodes.some((item) => item.identifier === 'companion-native-create' && item.rect),
        'The creation controls below the optional mode row must be visible',
      );
      assert.ok(
        !page.nodes.some(
          (item) => item.identifier === 'companion-native-mode-plan' && item.enabled !== false,
        ),
      );
      report.checks.push(
        `Companion ${runner}: real runner selected and unsupported Plan unavailable at the visible creation controls`,
      );
      execFileSync(
        'xcrun',
        [
          'simctl',
          'io',
          selection.udid,
          'screenshot',
          path.join(outDir, `companion-${runner}.png`),
        ],
        { stdio: 'pipe' },
      );
    }
    await press('companion-native-runner-codex');
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, report, outPath };
}
