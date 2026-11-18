// Read-only browser proof. Opens real runs and local panels; never sends a farm command.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { CdpWebPage, listCdpTargets } from '../../../packages/recipe-runner/src/runtime/cdp.ts';

const [phase] = process.argv.slice(2);
const port = Number(process.env.FARMSLOT_CDP_PORT);
const targetId = process.env.FARMSLOT_URL_PROOF_TAB?.replace(/^@/, '');
const origin = process.env.FARMSLOT_URL_PROOF_ORIGIN;
const runId = process.env.FARMSLOT_URL_PROOF_RUN;
const otherId = process.env.FARMSLOT_URL_PROOF_OTHER_RUN;
const output = process.env.FARMSLOT_URL_PROOF_OUTPUT;
assert(
  ['before', 'after'].includes(phase) && port && targetId && origin && runId && otherId && output,
);
assert.equal(new URL(origin).hostname, '127.0.0.1');
await mkdir(output, { recursive: true });
const target = (await listCdpTargets('127.0.0.1', port)).find((t) => t.id === targetId);
assert(target, 'Select an owned authenticated Agent Chrome tab');
const page = await CdpWebPage.connectToTarget(target);
const errors = [];
const walk =
  "const walk=r=>[...r.querySelectorAll('*')].flatMap(e=>e.shadowRoot?[e,...walk(e.shadowRoot)]:[e]);const all=walk(document);";
const inspect = () =>
  page.evaluate(
    `(()=>{${walk}const detail=all.find(e=>e.localName==='run-detail');const params=new URLSearchParams(location.hash.split('?')[1]);return {url:location.hash,run:params.get('run'),loadedRun:detail?.run?.id,subtasks:params.get('subtasks'),stepDetails:params.get('stepDetails'),sidebar:params.get('panels'),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}}})()`,
  );
const until = async (accept) => {
  const end = Date.now() + 60_000;
  for (;;) {
    const value = await inspect();
    if (accept(value)) return value;
    assert(Date.now() < end, JSON.stringify(value));
    await delay(100);
  }
};
const save = (name, data) =>
  writeFile(path.join(output, name + '.json'), JSON.stringify(data, null, 2) + '\n');
const shot = async (name) => {
  const image = await page.session.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, name + '.png'), Buffer.from(image.data, 'base64'));
};
try {
  await page.session.call('Runtime.enable');
  page.session.on('Runtime.exceptionThrown', (event) => errors.push(event.exceptionDetails));
  await page.session.call('Page.bringToFront');
  await page.session.call('Emulation.setDeviceMetricsOverride', {
    width: 1234,
    height: 1050,
    deviceScaleFactor: 0.9,
    mobile: false,
  });
  const params = new URLSearchParams({
    run: runId,
    runsTab: 'all',
    subtasks: `!${runId}:worker`,
    stepDetails: `${otherId}:6`,
    panels: 'sidebar',
  });
  await page.navigate(`${origin}/#runs?${params}`);
  await until((s) => s.loadedRun === runId);
  await save('opened', await inspect());
  await page.click('[data-testid="runs-back-to-list"]');
  const closed = await until((s) => !s.run);
  await save('closed', closed);
  const next = await page.evaluate(
    `(()=>{${walk}return all.find(e=>e.getAttribute('data-testid')?.startsWith('runs-row-')&&e.getClientRects().length)?.getAttribute('data-testid')})()`,
  );
  assert(next, 'A real inventory row must be visible');
  await page.click(`[data-testid="${next}"]`);
  const selectedId = next.slice('runs-row-'.length);
  const selected = await until((s) => s.loadedRun === selectedId);
  await save('selected', selected);
  await shot('selected');
  const stale = (s) => s.subtasks !== null || s.stepDetails !== null;
  assert.equal(
    stale(closed),
    phase === 'before',
    'Close details must drop the previous run’s choices',
  );
  assert.equal(stale(selected), phase === 'before', 'The next run must not inherit them');
  assert.equal(selected.sidebar, 'sidebar');
  if (phase === 'after') {
    await page.session.call('Page.reload');
    const reloaded = await until((s) => s.loadedRun === selectedId);
    await save('reloaded', reloaded);
    assert.equal(stale(reloaded), false);
    assert.equal(reloaded.sidebar, 'sidebar');
    await shot('reloaded');
  }
  assert.deepEqual(errors, []);
  await save('result', { phase, status: 'PASS', closed, selected, errors });
} finally {
  page.close();
}
