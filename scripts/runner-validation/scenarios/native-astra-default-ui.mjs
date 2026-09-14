import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Methods, NativeSessionEventTypes } from '@farmslot/protocol';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';

export const SCENARIO_ID = 'native-astra-default-ui';
export const RUNNER_AGNOSTIC = true;

/** New UI defaults, a real native turn and the official runner's own reasoning metadata. */
export async function runScenario({ explicit, outDir, timeoutMs = 120000 }) {
  if (!explicit) return { scenario: SCENARIO_ID, runner: 'codex', pass: true, skipped: true };
  const report = { runner: 'codex', pass: false, checks: [] };
  const cdp = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 30000 },
      ),
    );
  const view = (body) =>
    cdp(
      'eval',
      'native',
      `const view=document.querySelector('native-session-view');const root=view?.shadowRoot;${body}`,
    );
  const click = (selector) =>
    view(
      `const button=root?.querySelector(${JSON.stringify(selector)});if(!button||button.disabled)throw Error('Control unavailable');button.click();return {clicked:true};`,
    );
  let target;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.equal(process.env.FARMSLOT_CDP_PORT, '19323');
    const fixture = fs.realpathSync(path.join(ROOT, 'temp/native-validation/g003-codex-fixture'));
    const config = rpc(Methods.LLM_CONFIG_GET);
    assert.equal(config.copilotModel, 'gpt-6-astra');
    assert.equal(config.copilotEffort, 'low');
    await wait(
      () =>
        view(
          `return {ready:Boolean(view?.catalog&&root?.querySelector('[data-testid="native-new"]'))};`,
        ),
      (value) => value.ready,
      30000,
    );
    const current = view('return {selected:!!view?.session};');
    if (current.selected) click('[data-testid=native-new]');
    const defaults = view('return {runner:view.runner,model:view.model,mode:view.mode};');
    assert.deepEqual(defaults, { runner: 'codex', model: 'gpt-6-astra', mode: 'default' });
    cdp('select', 'native', 'native-session-view >>> [data-testid="native-context"]', fixture);
    await wait(
      () =>
        view(
          'return {ready:!!root?.querySelector("[data-testid=native-create]")&&!root.querySelector("[data-testid=native-create]").disabled};',
        ),
      (value) => value.ready,
      30000,
    );
    const existing = new Set(
      rpc(Methods.NATIVE_SESSION_LIST, { executionNodeId: 'local' }).sessions.map(
        (item) => item.id,
      ),
    );
    click('[data-testid=native-create]');
    const session = await wait(
      () =>
        rpc(Methods.NATIVE_SESSION_LIST, { executionNodeId: 'local' }).sessions.find(
          (item) => !existing.has(item.id) && item.runner === 'codex' && item.cwd === fixture,
        ),
      Boolean,
      timeoutMs,
    );
    target = { executionNodeId: 'local', sessionId: session.id };
    report.sessionId = session.id;
    assert.equal(session.model, 'gpt-6-astra');
    assert.equal(session.effort, 'low');
    assert.equal(session.workerManaged, undefined);
    await wait(
      () =>
        view(
          `const input=root?.querySelector('[data-testid="native-message"]');return {ready:view?.session?.id===${JSON.stringify(session.id)}&&!!input&&!input.disabled&&input.getClientRects().length>0};`,
        ),
      (value) => value.ready,
      30000,
    );
    const word = `ASTRA_LOW_${randomUUID().replaceAll('-', '')}`;
    cdp(
      'fill',
      'native',
      'native-session-view >>> [data-testid="native-message"]',
      `Reply exactly ${word}. Do not use tools, edit files, contact services, or run commands.`,
    );
    await wait(
      () =>
        view(
          'return {ready:!!root?.querySelector("[data-testid=native-send]")&&!root.querySelector("[data-testid=native-send]").disabled};',
        ),
      (value) => value.ready,
      30000,
    );
    click('[data-testid=native-send]');
    const page = await wait(
      () => rpc(Methods.NATIVE_SESSION_READ, target),
      (page) =>
        page.session.state === 'idle' &&
        page.commands.some((command) => command.accepted && command.outcome === 'completed'),
      timeoutMs,
    );
    assert.equal(page.commands.length, 1);
    assert.equal(page.session.effort, 'low');
    const text = page.events
      .filter((event) => event.type === NativeSessionEventTypes.TEXT_DELTA)
      .map((event) => event.text)
      .join('');
    assert.ok(text.includes(word));
    assert.ok(!page.events.some((event) => event.type === NativeSessionEventTypes.TOOL_STARTED));
    await wait(
      () => view(`return {shown:root?.textContent.includes(${JSON.stringify(word)})};`),
      (value) => value.shown,
      30000,
    );
    // Match only the conversation just created. Never read another native session or auth material.
    const sessionRoot = path.join(
      process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
      'sessions',
    );
    const files = execFileSync('rg', ['--files', '--hidden', sessionRoot], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(
        (file) =>
          path.basename(file).includes(page.session.nativeSessionId) && file.endsWith('.jsonl'),
      );
    assert.equal(files.length, 1, 'The actual native conversation must have one rollout file');
    const context = await wait(
      () =>
        fs
          .readFileSync(files[0], 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .find((item) => item.type === 'turn_context')?.payload,
      Boolean,
      30000,
    );
    assert.equal(context.model, 'gpt-6-astra');
    assert.equal(context.effort, 'low');
    assert.equal(context.cwd, fixture);
    report.native = {
      sessionId: page.session.nativeSessionId,
      model: context.model,
      effort: context.effort,
      rollout: path.basename(files[0]),
    };
    report.checks.push(
      'New Copilot UI defaults create Astra/low, the real native turn completes without tools, the reply renders, and the official rollout records low effort',
    );
    fs.mkdirSync(outDir, { recursive: true });
    cdp('screenshot', 'native', path.join(outDir, 'astra-low.png'));
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (target)
      try {
        rpc(Methods.NATIVE_SESSION_CLOSE, target);
        assert.equal(rpc(Methods.NATIVE_SESSION_READ, target).session.processStopped, true);
        report.stopped = true;
      } catch (error) {
        report.pass = false;
        report.cleanupError = error.message;
      }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, report, outPath };
}
