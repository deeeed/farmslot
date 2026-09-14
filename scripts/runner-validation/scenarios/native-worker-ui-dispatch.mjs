import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export const SCENARIO_ID = 'native-worker-ui-dispatch';

export async function runScenario({
  runnerAdapter,
  slotId,
  model,
  timeoutMs,
  outDir,
  explicit,
  via,
}) {
  const report = { runner: runnerAdapter.RUNNER_ID, checks: [], pass: false, error: null };
  if (!slotId && !explicit)
    return { scenario: SCENARIO_ID, runner: report.runner, pass: true, skipped: true };
  let template;
  let runId;
  let ticket;
  try {
    assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
    assert.equal(process.env.FARMSLOT_CDP_PORT, '19323');
    const slot = rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId);
    assert.ok(slot?.project.startsWith('native-worker-'));
    assert.equal(slot.currentRunId, null);
    const cwd = fs.realpathSync(slot.repo);
    assert.ok(cwd.startsWith(path.join(ROOT, 'temp/native-validation') + path.sep));
    if (slot.lifecycle === 'held') rpc('slot.release', { slotId, keepWork: true });
    const marker = `native-dispatch-ui-${randomUUID()}.txt`;
    const token = randomUUID();
    ticket = `NATIVE-DISPATCH-${Date.now()}`;
    const templatePath = path.join(
      ROOT,
      'temp/native-validation/projects',
      slot.project,
      'templates/worker/dev.md',
    );
    template = { path: templatePath, content: fs.readFileSync(templatePath, 'utf8') };
    fs.writeFileSync(
      templatePath,
      `# Worker: dev\n\n## Checklist\n\n- [ ] Write ${marker} containing exactly ${token}.\n\nEnd the turn after marking the step. Do not write a terminal signal, commit, contact services or change other files.\n`,
    );
    const route = `dispatch?flow=dev&project=${slot.project}&slot=${slotId}`;
    const cdp = (...args) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'), ...args],
          { cwd: ROOT, encoding: 'utf8', timeout: 30000 },
        ),
      );
    const walk =
      'const walk=r=>[...r.querySelectorAll("*")].flatMap(e=>e.shadowRoot?[e,...walk(e.shadowRoot)]:[e]);const all=walk(document);';
    const click = (label) =>
      cdp(
        'eval',
        route,
        walk +
          `const b=all.find(e=>e.matches('button')&&e.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Button unavailable');b.click();return true;`,
      );
    const selectState = () =>
      cdp(
        'eval',
        route,
        walk +
          `const s=all.find(e=>e.matches('[data-testid=dispatch-transport]'));return s?{value:s.value,nativeDisabled:[...s.options].find(o=>o.value==='native')?.disabled}:null;`,
      );
    cdp('goto', route);
    await wait(selectState, (state) => state && !state.nativeDisabled, timeoutMs);
    assert.equal(selectState().value, 'tmux', 'Native replaced the default terminal transport');
    const supported = new Set(
      rpc('native.session.catalog')
        .runners.filter((runner) => runner.supportsWorkers)
        .map((runner) => runner.runner),
    );
    const unsupported = ['cursor', 'grok', 'claude', 'codex'].find(
      (runner) => !supported.has(runner),
    );
    if (unsupported) {
      click(unsupported);
      await wait(selectState, (state) => state.nativeDisabled, timeoutMs);
      assert.equal(selectState().value, 'tmux');
      report.checks.push('runner without native worker capability cannot select native transport');
    }
    click(report.runner);
    if (model) click(model);
    await wait(selectState, (state) => !state.nativeDisabled, timeoutMs);
    const selector = (leaf) =>
      cdp(
        'eval',
        route,
        walk +
          `const e=all.find(e=>e.matches(${JSON.stringify(leaf)}));if(!e)throw Error('Control missing');let p=e;const parts=[${JSON.stringify(leaf)}];while(p){const h=p.getRootNode().host;if(!h)break;parts.unshift(h.localName);p=h;}return {selector:parts.join(' >>> ')};`,
      ).selector;
    cdp('select', route, selector('[data-testid=dispatch-transport]'), 'native');
    cdp('fill', route, selector('.ticket-input'), ticket);
    click('Skip Prepare');
    click('Reviewed');
    const controls = () =>
      cdp(
        'eval',
        route,
        walk +
          `return all.filter(e=>e.matches('button')&&['Dispatch','Queue'].includes(e.textContent.trim())).map(e=>({label:e.textContent.trim(),disabled:e.disabled,reason:e.title}));`,
      );
    await wait(
      controls,
      (buttons) => buttons.some((button) => button.label === 'Dispatch' && !button.disabled),
      timeoutMs,
    );
    if (
      !rpc('native.session.catalog').runners.find((runner) => runner.runner === report.runner)
        ?.supportsQueuedWorkers
    )
      assert.ok(
        controls().find((button) => button.label === 'Queue').disabled,
        'Queue silently dropped native transport',
      );
    cdp('screenshot', route, path.join(outDir, 'native-dispatch-options.png'));
    click(via === 'queue' ? 'Queue' : 'Dispatch');
    const run = await wait(
      () => rpc('run.list', { limit: 20 }).runs.find((run) => run.ticketOrPr.includes(ticket)),
      Boolean,
      timeoutMs,
    );
    runId = run.id;
    report.runId = runId;
    writeEvidence(report, SCENARIO_ID, report.runner, outDir);
    assert.equal(run.transport, 'native', 'Wizard dispatched a terminal worker');
    assert.equal(run.metrics.runner, report.runner);
    if (model) assert.equal(run.metrics.model, model);
    const accepted = await wait(
      () => rpc('run.get', { runId }).run,
      (run) => {
        assert.ok(!['failed', 'cancelled', 'blocked'].includes(run.status), run.error);
        return run.agentContexts?.some((context) => context.nativeSession?.acceptedAt);
      },
      timeoutMs,
    );
    const context = accepted.agentContexts.find((context) => context.nativeSession?.acceptedAt);
    assert.equal(
      accepted.steps.find((step) => step.name === 'prepare')?.outputs?.reason,
      'operator-skip',
    );
    const slotRoute = `slot/${slotId}?runId=${runId}`;
    cdp('goto', slotRoute);
    await wait(
      () =>
        cdp(
          'eval',
          slotRoute,
          walk +
            `const b=all.find(e=>e.matches('.sv-bottom-tab')&&e.textContent.trim()==='Conversation');if(b)b.click();return Boolean(b);`,
        ),
      Boolean,
      timeoutMs,
    );
    const approved = new Set();
    await wait(
      async () => {
        const snapshot = rpc(
          'native.session.read',
          pinnedWorkerTarget(runId, context.id, context.nativeSession.leaseId),
        );
        for (const request of snapshot.pendingRequests) {
          assert.equal(request.type, 'approval.requested');
          assert.equal(request.generation, context.nativeSession.generation);
          if (request.data?.cwd) assert.equal(request.data.cwd, cwd);
          if (approved.has(request.request.id)) continue;
          const clickApproval = () =>
            cdp(
              'eval',
              slotRoute,
              walk +
                `const b=all.find(e=>e.matches('[data-testid=native-approve]')&&e.closest('[data-request-id]')?.getAttribute('data-request-id')===${JSON.stringify(request.request.id)});if(!b||b.disabled)return false;b.click();return true;`,
            );
          await wait(clickApproval, Boolean, timeoutMs);
          approved.add(request.request.id);
        }
        return snapshot;
      },
      (snapshot) =>
        snapshot.session.state === 'idle' &&
        snapshot.commands.find((command) => command.commandId === context.nativeSession.commandId)
          ?.outcome === 'completed',
      timeoutMs,
    );
    assert.ok(approved.size > 0, 'Sandboxed native worker produced no approval proof');
    report.checks.push(
      'default-safety worker approvals are answered through its pinned slot conversation',
    );
    assert.equal(fs.readFileSync(path.join(cwd, marker), 'utf8').trim(), token);
    report.checks.push(
      'terminal default retained; unsupported native runner disabled; real wizard native choice selects model and dispatches accepted worker with file side effect',
    );
    if (via === 'queue')
      report.checks.push(
        'actual Queue button preserves native transport and preparation choice through delayed run creation',
      );
    report.pass = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    if (template) fs.writeFileSync(template.path, template.content);
    if (!runId && ticket) {
      try {
        runId = rpc('run.list', { limit: 100 }).runs.find((run) =>
          run.ticketOrPr.includes(ticket),
        )?.id;
      } catch (error) {
        report.pass = false;
        report.error = [report.error, `lookup cleanup: ${error.message}`]
          .filter(Boolean)
          .join('; ');
      }
    }
    if (runId) {
      try {
        const run = rpc('run.get', { runId }).run;
        if (!['done', 'failed', 'cancelled'].includes(run.status)) {
          const result = rpc('run.cancel', { runId, reason: 'Native wizard validation cleanup' });
          assert.ok(result.effects.every((effect) => effect.status !== 'failed'));
        } else if (run.status === 'failed') {
          const slot = rpc('fleet.status').fleet.slots.find((slot) => slot.slot === slotId);
          assert.ok(!slot.currentRunId || slot.currentRunId === runId);
          rpc('slot.release', { slotId, keepWork: true, expectedRunId: runId });
        }
      } catch (error) {
        report.pass = false;
        report.error = [report.error, `cleanup: ${error.message}`].filter(Boolean).join('; ');
      }
    }
  }
  const outPath = writeEvidence(report, SCENARIO_ID, report.runner, outDir);
  return { scenario: SCENARIO_ID, runner: report.runner, pass: report.pass, outPath, report };
}
