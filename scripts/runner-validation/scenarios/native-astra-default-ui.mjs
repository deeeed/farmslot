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

/**
 * Standalone native screen, not the Co-Pilot launcher.
 * The screen defaults to gpt-6.2-sol at the Codex runner effort, high.
 * LLM copilot config stays gpt-6.2-astra at low, checked before the turn.
 */
export async function runScenario({ explicit, outDir, timeoutMs = 120000 }) {
  if (!explicit) return { scenario: SCENARIO_ID, runner: 'codex', pass: true, skipped: true };
  const { nativeLaunchContextKey } = await import('@farmslot/review-dispatch');
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
  let browser = false;
  let armed = false;
  const launchToken = randomUUID();
  const readLaunchReceipt = () =>
    view(
      `const token=${JSON.stringify(launchToken)};const box=view?.__launchReceipts??{};return box[token]??{id:""};`,
    );
  const rememberReceipt = (receipt) => {
    if (receipt?.id && !target) target = { executionNodeId: receipt.node, sessionId: receipt.id };
  };
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.equal(process.env.FARMSLOT_CDP_PORT, '19323');
    browser = true;
    const fixture = fs.realpathSync(path.join(ROOT, 'temp/native-validation/g003-codex-fixture'));
    const config = rpc(Methods.LLM_CONFIG_GET);
    assert.equal(config.copilotModel, 'gpt-6.2-astra');
    assert.equal(config.copilotEffort, 'low');
    await wait(
      () =>
        view(
          'return {ready:Boolean(view?.catalog&&(view.session||root?.querySelector(\'[data-testid="native-prompt"]\')))};',
        ),
      (value) => value.ready,
      30000,
    );
    const current = view('return {selected:!!view?.session};');
    if (current.selected) click('[data-testid=native-new]');
    await wait(
      () => view('return {ready:!!root?.querySelector(\'[data-testid="native-prompt"]\')};'),
      (value) => value.ready,
      30000,
    );
    const defaults = view('return {runner:view.runner,model:view.model,mode:view.mode};');
    assert.deepEqual(defaults, { runner: 'codex', model: 'gpt-6.2-sol', mode: 'default' });
    const launchKey = nativeLaunchContextKey({ cwd: fixture, executionNodeId: 'local' });
    const launch = view(
      `const key=${JSON.stringify(launchKey)};const match=[...root.querySelectorAll('[data-testid="native-context"] option')].find((option)=>!option.disabled&&option.value===key);return {value:match?.value??''};`,
    );
    assert.ok(launch.value, 'the fixture workspace is not in the native launch list');
    cdp('select', 'native', 'native-session-view >>> [data-testid="native-context"]', launch.value);
    const word = `SOL_HIGH_${randomUUID().replaceAll('-', '')}`;
    const prompt = `Reply exactly ${word}. Do not use tools, edit files, contact services, or run commands.`;
    cdp('fill', 'native', 'native-session-view >>> [data-testid="native-prompt"]', prompt);
    await wait(
      () =>
        view(
          'return {ready:!!root?.querySelector("[data-testid=native-create]")&&!root.querySelector("[data-testid=native-create]").disabled};',
        ),
      (value) => value.ready,
      30000,
    );
    view(
      `const method=${JSON.stringify(Methods.NATIVE_SESSION_CREATE)};const cwd=${JSON.stringify(fixture)};const token=${JSON.stringify(launchToken)};const receipts=view.__launchReceipts??(view.__launchReceipts={});const pending=view.__launchPending??(view.__launchPending={});const request=view.api.request.bind(view.api);view.__launchRequest=request;view.__launchToken=token;view.api.request=async(...args)=>{const [name,params]=args;const mine=name===method&&!params?.resumeSessionId&&params?.cwd===cwd&&params?.runner==='codex'&&(params?.executionNodeId??'local')==='local'&&view.__launchToken===token;if(mine){view.api.request=request;pending[token]=true;}let result;try{result=await request(...args);}finally{if(mine)pending[token]=false;}const session=result?.session;if(mine&&session?.id&&!receipts[token])receipts[token]={id:session.id,node:session.executionNodeId,runner:session.runner,cwd:session.cwd};return result;};const button=root?.querySelector('[data-testid="native-create"]');if(!button||button.disabled)throw Error('Control unavailable');button.click();return {clicked:true};`,
    );
    armed = true;
    const created = await wait(readLaunchReceipt, (value) => Boolean(value.id), timeoutMs);
    rememberReceipt(created);
    assert.equal(created.runner, 'codex');
    assert.equal(created.cwd, fixture);
    assert.equal(created.node, 'local');
    const opened = await wait(
      () => view(`return {open:view.session?.id===${JSON.stringify(created.id)}};`),
      (value) => value.open,
      30000,
    );
    assert.equal(opened.open, true);
    const session = rpc(Methods.NATIVE_SESSION_READ, target).session;
    report.sessionId = session.id;
    assert.equal(session.model, 'gpt-6.2-sol');
    assert.equal(session.effort, 'high');
    assert.equal(session.workerManaged, undefined);
    const page = await wait(
      () => rpc(Methods.NATIVE_SESSION_READ, target),
      (page) =>
        page.session.state === 'idle' &&
        page.commands.some((command) => command.accepted && command.outcome === 'completed'),
      timeoutMs,
    );
    assert.equal(page.commands.length, 1);
    assert.equal(page.session.effort, 'high');
    const text = page.events
      .filter((event) => event.type === NativeSessionEventTypes.TEXT_DELTA)
      .map((event) => event.text)
      .join('');
    assert.ok(text.includes(word));
    assert.ok(!page.events.some((event) => event.type === NativeSessionEventTypes.TOOL_STARTED));
    await wait(
      () =>
        view(
          `const word=${JSON.stringify(word)};const id=${JSON.stringify(session.id)};const rows=[...root.querySelectorAll('article.assistant:not([hidden]) .text')];return {shown:view?.session?.id===id&&rows.some((row)=>row.textContent.includes(word))};`,
        ),
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
    assert.equal(context.model, 'gpt-6.2-sol');
    assert.equal(context.effort, 'high');
    assert.equal(context.cwd, fixture);
    report.native = {
      sessionId: page.session.nativeSessionId,
      model: context.model,
      effort: context.effort,
      rollout: path.basename(files[0]),
    };
    report.checks.push(
      `Native screen defaults create ${context.model} at ${context.effort}. LLM copilot config stays gpt-6.2-astra at low. The turn completes without tools, the reply renders, and the rollout records that effort`,
    );
    fs.mkdirSync(outDir, { recursive: true });
    cdp('screenshot', 'native', path.join(outDir, 'sol-high.png'));
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (browser)
      try {
        view(
          `const token=${JSON.stringify(launchToken)};if(view?.__launchToken===token&&view.__launchRequest){view.api.request=view.__launchRequest;return {restored:true}}return {restored:false};`,
        );
      } catch (error) {
        report.pass = false;
        report.restoreError = error.message;
      }
    if (browser && armed && !target)
      try {
        rememberReceipt(await wait(readLaunchReceipt, (value) => Boolean(value.id), 5000));
      } catch (error) {
        try {
          rememberReceipt(readLaunchReceipt());
        } catch (readError) {
          report.pass = false;
          report.receiptError = readError.message;
        }
        if (!target) {
          try {
            const state = view(
              `const token=${JSON.stringify(launchToken)};return {pending:view?.__launchPending?.[token]===true};`,
            );
            if (state.pending) {
              report.pass = false;
              report.unresolvedCreate =
                'native.session.create was still in flight after the cleanup wait';
            }
          } catch (readError) {
            report.pass = false;
            report.receiptError = report.receiptError
              ? `${report.receiptError}; ${readError.message}`
              : readError.message;
          }
        }
        report.cleanupWaitError = error.message;
      }
    if (target)
      try {
        rpc(Methods.NATIVE_SESSION_CLOSE, target);
        assert.equal(rpc(Methods.NATIVE_SESSION_READ, target).session.processStopped, true);
        report.stopped = true;
      } catch (error) {
        report.pass = false;
        report.closeError = error.message;
      }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, report, outPath };
}
