import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from '../lib/common.mjs';

import { rpc, wait } from './native-worker-lifecycle.mjs';
import { pinnedWorkerTarget } from './native-worker-read.mjs';

export async function verifyNativeWorkerUi({
  runId,
  context,
  binding,
  cwd,
  slotId,
  timeoutMs,
  outDir,
}) {
  assert.equal(process.env.FARMSLOT_CDP_PORT, '19323');
  assert.equal(new URL(process.env.FARMSLOT_UI_URL).origin, 'http://127.0.0.1:18778');
  const cdp = (...args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: ROOT, encoding: 'utf8', timeout: 30000 },
      ),
    );
  const route = `slot/${slotId}?runId=${runId}`;
  const walk =
    'const walk=r=>[...r.querySelectorAll("*")].flatMap(e=>e.shadowRoot?[e,...walk(e.shadowRoot)]:[e]);const all=walk(document);';
  const click = (selector) =>
    cdp(
      'eval',
      route,
      walk +
        `const b=all.find(e=>e.matches(${JSON.stringify(selector)}));if(!b||b.disabled)throw Error('Control unavailable');b.click();return true;`,
    );
  cdp('goto', route);
  await wait(
    () =>
      cdp(
        'eval',
        route,
        walk +
          `const b=all.find(e=>e.matches('.sv-bottom-tab')&&e.textContent.trim()==='Conversation');if(b)b.click();return Boolean(b);`,
      ),
    Boolean,
    timeoutMs,
  );
  const ui = () =>
    cdp(
      'eval',
      route,
      '--file',
      path.join(ROOT, 'apps/command-center/scripts/probes/native-worker-view.js'),
    );
  await wait(ui, (state) => state.inputReady, timeoutMs);
  let state = ui();
  assert.equal(state.label, context.label);
  assert.equal(state.newSession, false);
  assert.deepEqual(state.errors, []);
  assert.ok(state.send.width > 30 && state.send.height > 20);
  assert.equal(state.send.visible, true, 'Native composer controls are clipped');
  assert.ok(state.timelineHeight >= 60, 'Native conversation has no usable history viewport');
  const marker = `native-ui-${randomUUID()}.txt`;
  const token = randomUUID();
  const before = rpc('native.session.read', pinnedWorkerTarget(runId, context.id, binding.leaseId));
  const prompt = `Write ${marker} containing exactly ${token}. Do not change other files or write terminal signals. Then end this turn.`;
  // Fill uses actual CDP keystrokes; no DOM/state value injection.
  const selector = cdp(
    'eval',
    route,
    walk +
      `const v=all.find(e=>e.matches('native-session-view'));let p=v;const parts=['native-session-view'];while(p){const host=p.getRootNode().host;if(!host)break;parts.unshift(host.localName);p=host;}return {selector:parts.join(' >>> ')+' >>> textarea'};`,
  ).selector;
  cdp('fill', route, selector, prompt);
  await wait(ui, (state) => state.send && !state.send.disabled, timeoutMs);
  click('[data-testid=native-send]');
  await wait(
    () => {
      const state = ui();
      assert.deepEqual(state.errors, [], 'Pinned worker input failed in the browser');
      return rpc('native.session.read', pinnedWorkerTarget(runId, context.id, binding.leaseId));
    },
    (snapshot) => snapshot.commands.length === before.commands.length + 1,
    timeoutMs,
  );
  const after = await wait(
    () => rpc('native.session.read', pinnedWorkerTarget(runId, context.id, binding.leaseId)),
    (snapshot) =>
      snapshot.commands.length === before.commands.length + 1 &&
      snapshot.commands.at(-1)?.outcome === 'completed' &&
      snapshot.session.state === 'idle',
    timeoutMs,
  );
  assert.equal(fs.readFileSync(path.join(cwd, marker), 'utf8').trim(), token);
  assert.equal(after.session.generation, binding.generation);
  assert.equal(after.session.workerLeaseId, binding.leaseId);
  await wait(
    ui,
    (state) =>
      state.text?.includes(marker) && state.state === 'idle' && state.delivery === 'Completed',
    timeoutMs,
  );
  cdp(
    'eval',
    route,
    walk +
      `const v=all.find(e=>e.matches('native-session-view'));v?.shadowRoot.querySelector('.timeline article:last-child')?.scrollIntoView({block:'end'});return true;`,
  );
  cdp('screenshot', route, path.join(outDir, 'worker-conversation.png'));
  click('[data-testid=native-workspace-toggle]');
  await wait(
    () =>
      cdp(
        'eval',
        route,
        walk +
          `const w=all.find(e=>e.matches('native-workspace'));const b=[...(w?.shadowRoot?.querySelectorAll('button')??[])].find(e=>e.textContent.trim()==='Files');if(b)b.click();return Boolean(b);`,
      ),
    Boolean,
    timeoutMs,
  );
  await wait(
    () =>
      cdp(
        'eval',
        route,
        walk +
          `const file=all.find(e=>e.matches('[data-path=${JSON.stringify(marker)}]'));if(file)file.click();return Boolean(file);`,
      ),
    Boolean,
    timeoutMs,
  );
  await wait(
    () =>
      cdp(
        'eval',
        route,
        walk +
          `return all.filter(e=>e.matches('native-workspace')).some(e=>e.shadowRoot?.textContent.includes(${JSON.stringify(token)}));`,
      ),
    Boolean,
    timeoutMs,
  );
  click('[data-testid=workspace-diff]');
  await wait(
    () =>
      cdp(
        'eval',
        route,
        walk +
          `return all.filter(e=>e.matches('diff-review')).some(e=>e.textContent.includes(${JSON.stringify(token)}));`,
      ),
    Boolean,
    timeoutMs,
  );
  cdp('screenshot', route, path.join(outDir, 'worker-diff.png'));
  click('[data-testid=native-workspace-toggle]');
  cdp('eval', route, 'location.reload();return true;');
  await wait(ui, (state) => state.text?.includes(marker) && state.inputReady, timeoutMs);
  assert.equal(
    rpc('native.session.read', pinnedWorkerTarget(runId, context.id, binding.leaseId)).commands
      .length,
    after.commands.length,
    'Refresh resent worker input',
  );
  return { marker, token };
}
