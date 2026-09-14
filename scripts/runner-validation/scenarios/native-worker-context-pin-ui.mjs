import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';

import { wait } from './native-worker-lifecycle.mjs';

// Called from the real history scenario after its run/context has rendered successfully.
export async function verifyNativeContextPinFailures({ cdp, run, context, outDir, timeoutMs }) {
  const fault = process.env.FARMSLOT_NATIVE_CONTEXT_SLOT_FAULT;
  if (!fault) return [];
  assert.ok(path.resolve(fault).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep));
  assert.equal(fs.existsSync(fault), false, 'Archive a prior fault configuration before testing');
  const pids = execFileSync('lsof', ['-t', '-nP', '-iTCP:18777', '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/)
    .map(Number);
  assert.equal(pids.length, 1);
  assert.ok(
    fs.existsSync(`${fault}.${pids[0]}.loaded`),
    'Private gateway must preload the fixture',
  );
  const route = `slot/${run.slotId}?runId=${run.id}&contextId=${context.id}`;
  const walk =
    'const walk=r=>[...r.querySelectorAll("*")].flatMap(e=>e.shadowRoot?[e,...walk(e.shadowRoot)]:[e]);';
  const checks = [];
  for (const mode of ['delay', 'fail']) {
    cdp('goto', route);
    await wait(
      () =>
        cdp(
          'eval',
          route,
          walk +
            `return walk(document).some(e=>e.matches('native-session-view')&&e.worker?.runId===${JSON.stringify(run.id)}&&e.worker?.contextId===${JSON.stringify(context.id)});`,
        ),
      Boolean,
      timeoutMs,
    );
    const caseId = randomUUID();
    const release = `${fault}.${caseId}.release`;
    const eventsPath = `${fault}.${caseId}.events`;
    const events = () =>
      fs.existsSync(eventsPath)
        ? fs
            .readFileSync(eventsPath, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    const missingRoute = `slot/${run.slotId}?runId=${run.id}&contextId=unknown-${caseId}`;
    fs.writeFileSync(
      fault,
      JSON.stringify({ gatewayPid: pids[0], slotId: run.slotId, runId: run.id, caseId, mode }),
      { mode: 0o600 },
    );
    try {
      // Hash navigation is the real user route. Read the DOM across the async boundary;
      // no component, gateway-client or store value is replaced by the recipe.
      const sample = `const samples=[];for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,20));const all=walk(document);samples.push({linkedRunId:all.find(e=>e.matches('slot-view'))?._linkedRun?.id??null,missing:all.some(e=>e.matches('[data-testid=native-context-unavailable]')),native:all.some(e=>e.matches('native-session-view')),terminal:all.some(e=>e.matches('terminal-view'))});}return samples;`;
      const pending = cdp(
        'eval',
        route,
        walk +
          `location.hash=${JSON.stringify('#' + missingRoute)};await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));` +
          sample,
      );
      await wait(
        events,
        (entries) =>
          entries.some(
            (e) =>
              e.method === 'run.get' &&
              e.phase === 'delivered' &&
              e.ok === true &&
              e.runId === run.id,
          ) && entries.some((e) => e.method === 'run.forSlot' && e.phase === 'held'),
        5000,
      );
      const verify = (samples, phase) => {
        assert.ok(samples.length > 0);
        for (const state of samples) {
          assert.equal(
            state.linkedRunId,
            null,
            `${mode}/${phase}: published a run with a rejected pin`,
          );
          assert.equal(
            state.missing,
            true,
            `${mode}/${phase}: unknown same-run context must stay unavailable`,
          );
          assert.equal(state.native, false, `${mode}/${phase}: exposed the primary conversation`);
          assert.equal(state.terminal, false, `${mode}/${phase}: exposed a terminal fallback`);
        }
      };
      verify(pending, 'pending');
      fs.writeFileSync(release, '', { mode: 0o600 });
      await wait(
        events,
        (entries) =>
          entries.some(
            (e) =>
              e.method === 'run.forSlot' && e.phase === (mode === 'fail' ? 'failed' : 'delivered'),
          ),
        5000,
      );
      const settled = cdp('eval', missingRoute, walk + sample);
      verify(settled, 'settled');
      cdp('screenshot', missingRoute, path.join(outDir, `context-pin-${mode}.png`));
      fs.writeFileSync(
        path.join(outDir, `context-pin-${mode}.json`),
        JSON.stringify({ pending, settled, events: events() }, null, 2),
      );
      checks.push(
        `unknown same-run context stays unavailable before and after ${mode === 'fail' ? 'failed' : 'delayed'} slot lookup, with direct run hydration delivered`,
      );
    } finally {
      fs.writeFileSync(release, '', { mode: 0o600 });
      fs.renameSync(fault, `${fault}.${caseId}.completed`);
    }
  }
  cdp('goto', route);
  await wait(
    () =>
      cdp(
        'eval',
        route,
        walk +
          `return walk(document).some(e=>e.matches('native-session-view')&&e.worker?.contextId===${JSON.stringify(context.id)});`,
      ),
    Boolean,
    timeoutMs,
  );
  return checks;
}
