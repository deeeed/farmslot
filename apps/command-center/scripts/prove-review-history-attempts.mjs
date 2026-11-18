// Read a real retained review history through the connected UI. No run or gate writes.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { CdpWebPage, listCdpTargets } from '../../../packages/recipe-runner/src/runtime/cdp.ts';

const phase = process.argv[2];
const port = Number(process.env.FARMSLOT_CDP_PORT);
const targetId = process.env.REVIEW_HISTORY_PROOF_TAB;
const runId = process.env.REVIEW_HISTORY_PROOF_RUN;
const output = process.env.REVIEW_HISTORY_PROOF_OUTPUT;
assert(['before', 'after'].includes(phase) && port && targetId && runId && output);
const target = (await listCdpTargets('127.0.0.1', port)).find((entry) => entry.id === targetId);
assert(target, 'Use an owned, authenticated Agent Chrome tab');
const page = await CdpWebPage.connectToTarget(target);
await mkdir(output, { recursive: true });
const walk =
  "const walk=r=>[...r.querySelectorAll('*')].flatMap(e=>e.shadowRoot?[e,...walk(e.shadowRoot)]:[e]);const all=walk(document);";
const inspect = () =>
  page.evaluate(
    `(()=>{${walk}const panel=all.find(e=>e.localName==='review-history-panel');const root=panel?.shadowRoot;return {connection:document.querySelector('farm-app')?.connection,runId:panel?.run?.id,loading:panel?._historyLoading,rounds:[...(root?.querySelectorAll('[data-round]')??[])].map(e=>({number:Number(e.dataset.round),key:e.dataset.event,summary:e.querySelector('summary').textContent.trim().replace(/\\s+/g,' '),findings:e.querySelectorAll('[data-finding]').length,attempts:e.querySelectorAll('[data-attempt]').length,fixes:[...e.querySelectorAll('[data-fix]')].map(f=>f.textContent.trim().replace(/\\s+/g,' '))})),text:root?.textContent?.slice(-9000),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}}})()`,
  );
const until = async (accept, label) => {
  const end = Date.now() + 60000;
  for (;;) {
    const value = await inspect();
    if (accept(value)) return value;
    assert(Date.now() < end, `${label}: ${JSON.stringify(value)}`);
    await delay(100);
  }
};
const errors = [];
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
  await page.navigate(
    `${new URL(target.url).origin}/#runs?run=${encodeURIComponent(runId)}&tab=evidence&panels=run-review-history,sidebar`,
  );
  await page.session.call('Page.reload', { ignoreCache: true });
  await page.waitForDocumentReady({ timeoutMs: 45000 });
  await until(
    (value) =>
      value.connection === 'connected' &&
      value.runId === runId &&
      !value.loading &&
      value.rounds.length > 0,
    'retained history loaded',
  );
  const intro = await page.evaluate(
    `(()=>{${walk}return all.some(e=>e.tagName==='BUTTON'&&e.textContent.trim()==='Got it')})()`,
  );
  if (intro) await page.clickText('Got it');
  const expectedRounds = phase === 'before' ? 4 : 1;
  const loaded = await until(
    (value) => value.rounds.length === expectedRounds,
    'expected review count',
  );
  if (phase === 'after') {
    assert.equal(loaded.rounds[0].findings, 2);
    assert.equal(loaded.rounds[0].attempts, 2);
    assert.match(loaded.rounds[0].summary, /2 findings/);
    assert.match(loaded.rounds[0].summary, /Fix yes/);
    assert.doesNotMatch(loaded.rounds[0].summary, /not recorded/);
    assert.equal(loaded.rounds[0].fixes.length, 1);
    assert.match(loaded.rounds[0].fixes[0], /Fix after round 1/);
  }
  const roundSelector = phase === 'after' ? '[data-round="1"]' : '[data-round="3"]';
  await page.click(`${roundSelector} > summary`);
  if (phase === 'after') {
    await page.click('.review-launch-attempts > summary');
  }
  await page.evaluate(
    `(()=>{${walk}all.find(e=>e.localName==='review-history-panel')?.scrollIntoView({block:'start'});return true})()`,
  );
  await page.evaluate(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
  );
  const screenshot = await page.session.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, phase + '.png'), Buffer.from(screenshot.data, 'base64'));
  if (phase === 'after') {
    await page.evaluate(
      `(()=>{${walk}all.find(e=>e.localName==='review-history-panel')?.shadowRoot?.querySelector('[data-fix]')?.scrollIntoView({block:'center'});return true})()`,
    );
    await page.evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
    );
    const fixShot = await page.session.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, 'after-fix.png'), Buffer.from(fixShot.data, 'base64'));
  }
  let diff;
  if (phase === 'after') {
    await page.click('[data-fix] > summary');
    const available = await page.evaluate(
      `(()=>{${walk}const panel=all.find(e=>e.localName==='review-history-panel');const button=panel?.shadowRoot?.querySelector('[data-fix] button');return Boolean(button && !button.disabled)})()`,
    );
    assert(available, 'Following-fix diff control must be available');
    await page.click('[data-fix] button');
    const end = Date.now() + 15000;
    for (;;) {
      diff = await page.evaluate(
        `(()=>{${walk}const modal=all.find(e=>e.localName==='diff-viewer-modal' && e.open);return modal ? {opened:true,path:modal.title,bytes:modal.diffText?.length} : null})()`,
      );
      if (diff?.opened && typeof diff.bytes === 'number') break;
      assert(Date.now() < end, 'Following-fix comparison did not open');
      await delay(50);
    }
    await page.click('.dvm-close');
  }
  const result = await inspect();
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, phase + '.json'),
    JSON.stringify({ status: 'PASS', phase, result, diff, errors }, null, 2) + '\n',
  );
} finally {
  page.close();
}
