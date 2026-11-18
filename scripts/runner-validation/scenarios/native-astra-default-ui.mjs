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
  const cdpCall = (timeoutMs, args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: timeoutMs },
      ),
    );
  const cdp = (...args) => cdpCall(30000, args);
  const viewWithin = (timeoutMs, body) =>
    cdpCall(timeoutMs, [
      'eval',
      'native',
      `const view=document.querySelector('native-session-view');const root=view?.shadowRoot;${body}`,
    ]);
  const view = (body) => viewWithin(30000, body);
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
      `const token=${JSON.stringify(launchToken)};const box=document.__nativeLaunchBook?.receipts??{};return box[token]??{id:""};`,
    );
  const rememberReceipt = (receipt) => {
    if (receipt?.id && !target) target = { executionNodeId: receipt.node, sessionId: receipt.id };
  };
  const noteUnresolved = (snapshot) => {
    rememberReceipt(snapshot);
    if (target) {
      delete report.unresolvedCreate;
      return;
    }
    if (snapshot?.pending === 'pending' || snapshot?.pending === 'unknown') {
      report.pass = false;
      report.unresolvedCreate =
        snapshot.pending === 'unknown'
          ? `native.session.create outcome is unknown${snapshot.error ? `: ${snapshot.error}` : ''}`
          : 'native.session.create was still in flight after the cleanup wait';
      return;
    }
    if (snapshot?.pending === 'idle') delete report.unresolvedCreate;
  };
  // Return an id still in the book without deleting it. Delete only after close, or when the
  // attempt finished with no session id. A lost CDP reply can call this again.
  const releaseLaunch = (knownId, closed) =>
    view(
      `const token=${JSON.stringify(launchToken)};const known=${JSON.stringify(knownId)};const closed=${closed ? 'true' : 'false'};const book=document.__nativeLaunchBook;if(!book)return {released:true,id:""};if(book.token!==token&&!book.receipts?.[token]&&book.pending?.[token]===undefined)return {released:true,id:""};if(book.token===token&&book.view&&(book.originalRequest||book.request))book.view.api.request=book.originalRequest||book.request;const receipt=book.receipts?.[token]??null;const id=receipt?.id??"";const flag=book.pending?.[token];const pending=flag===true?"pending":flag==="unknown"?"unknown":flag===false?"idle":"unknown";const error=receipt?.error??"";if(id&&!(id===known&&closed))return {released:false,hold:true,id,node:receipt.node??"",runner:receipt.runner??"",cwd:receipt.cwd??"",pending,error};if(!id&&flag===true)return {released:false,hold:true,id:"",node:"",runner:"",cwd:"",pending:"pending",error};const settled=book.settled??(book.settled={});settled[token]=true;if(book.receipts)delete book.receipts[token];if(book.pending)delete book.pending[token];if(book.token===token){delete book.view;delete book.request;delete book.token;}if(book.receipts&&!Object.keys(book.receipts).length&&book.pending&&!Object.keys(book.pending).length&&!book.view)delete document.__nativeLaunchBook;return {released:true,id,pending,error};`,
    );
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
    // Arm before the click eval. A lost CDP reply can still leave a receipt to close.
    armed = true;
    view(
      `const method=${JSON.stringify(Methods.NATIVE_SESSION_CREATE)};const cwd=${JSON.stringify(fixture)};const token=${JSON.stringify(launchToken)};const button=root?.querySelector('[data-testid="native-create"]');if(!button||button.disabled)throw Error('Control unavailable');const book=document.__nativeLaunchBook??(document.__nativeLaunchBook={});const receipts=book.receipts??(book.receipts={});const pending=book.pending??(book.pending={});const request=view.api.request.bind(view.api);if(!book.originalRequest)book.originalRequest=request;book.request=book.originalRequest;book.view=view;book.token=token;view.api.request=async(...args)=>{const [name,params]=args;const mine=name===method&&!params?.resumeSessionId&&params?.cwd===cwd&&params?.runner==='codex'&&(params?.executionNodeId??'local')==='local'&&book.token===token;if(mine){view.api.request=book.originalRequest;pending[token]=true;}try{const result=await request(...args);const session=result?.session;if(mine&&session?.id&&!receipts[token]&&book.settled?.[token]!==true)receipts[token]={id:session.id,node:session.executionNodeId,runner:session.runner,cwd:session.cwd};return result;}catch(error){if(mine&&book.settled?.[token]!==true){pending[token]='unknown';if(!receipts[token])receipts[token]={id:'',error:String(error?.message??error)};}throw error;}finally{if(mine&&book.settled?.[token]!==true&&pending[token]===true)pending[token]=false;}};button.click();return {clicked:true};`,
    );
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
          `const token=${JSON.stringify(launchToken)};const book=document.__nativeLaunchBook;if(book?.token===token&&book.view&&(book.originalRequest||book.request)){book.view.api.request=book.originalRequest||book.request;return {restored:true}}return {restored:false};`,
        );
      } catch (error) {
        report.pass = false;
        report.restoreError = error.message;
      }
    const stateBody = `const token=${JSON.stringify(launchToken)};const book=document.__nativeLaunchBook;if(!book?.receipts||!book.pending)return {id:"",node:"",runner:"",cwd:"",pending:"unknown",error:"launch record missing"};const receipt=book.receipts[token]??null;const flag=book.pending[token];return {id:receipt?.id??"",node:receipt?.node??"",runner:receipt?.runner??"",cwd:receipt?.cwd??"",pending:flag===true?"pending":flag==="unknown"?"unknown":flag===false?"idle":"unknown",error:receipt?.error??""};`;
    if (browser && armed && !target) {
      // One snapshot carries the receipt and the pending flag. The poll stops at one deadline.
      const deadline = Date.now() + 5000;
      let snapshot = null;
      let snapshotError = null;
      while (!target && Date.now() < deadline) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
          snapshot = viewWithin(remaining, stateBody);
          snapshotError = null;
          rememberReceipt(snapshot);
        } catch (error) {
          snapshotError = error;
          const retryPause = Math.min(500, deadline - Date.now());
          if (retryPause <= 0) break;
          await new Promise((resolve) => setTimeout(resolve, retryPause));
          continue;
        }
        if (target) break;
        const pause = Math.min(500, deadline - Date.now());
        if (pause <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
      if (snapshot) noteUnresolved(snapshot);
      if (snapshotError) {
        report.pass = false;
        report.receiptError = snapshotError.message;
      }
    }
    if (browser && armed && !target)
      try {
        // Read without sealing. A lost reply leaves the receipt for the release below.
        noteUnresolved(view(stateBody));
      } catch (error) {
        report.pass = false;
        if (!report.receiptError) report.receiptError = error.message;
      }
    if (browser && armed && !target)
      try {
        noteUnresolved(releaseLaunch('', false));
      } catch (error) {
        report.pass = false;
        if (!report.releaseError) report.releaseError = error.message;
      }
    const closeTarget = () => {
      if (!target || report.stopped) return;
      try {
        rpc(Methods.NATIVE_SESSION_CLOSE, target);
        assert.equal(rpc(Methods.NATIVE_SESSION_READ, target).session.processStopped, true);
        report.stopped = true;
      } catch (error) {
        report.pass = false;
        report.closeError = error.message;
      }
    };
    const releaseKnown = () => {
      if (!browser || !armed) return;
      try {
        // Delete the receipt only after close, or when this attempt has no session id.
        // A second call is safe when the first reply was lost.
        noteUnresolved(releaseLaunch(target?.sessionId ?? '', report.stopped === true));
      } catch {
        try {
          noteUnresolved(releaseLaunch(target?.sessionId ?? '', report.stopped === true));
        } catch (retryError) {
          report.pass = false;
          if (!report.releaseError) report.releaseError = retryError.message;
        }
      }
    };
    closeTarget();
    releaseKnown();
    // The release above can be the first copy of an id when the earlier read was lost.
    if (target && !report.stopped) {
      closeTarget();
      releaseKnown();
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, report, outPath };
}
