// Real imported run, real gateway search and browser input. Never dispatches a worker.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { CdpWebPage, listCdpTargets } from '../../../packages/recipe-runner/src/runtime/cdp.ts';

const phase = process.argv[2];
const port = Number(process.env.FARMSLOT_CDP_PORT);
const targetId = process.env.ARTIFACT_SEARCH_PROOF_TAB;
const origin = process.env.ARTIFACT_SEARCH_PROOF_ORIGIN;
const fixtureFile = process.env.ARTIFACT_SEARCH_PROOF_FIXTURE;
const output = process.env.ARTIFACT_SEARCH_PROOF_OUTPUT;
assert(['before', 'after'].includes(phase) && port && targetId && origin && fixtureFile && output);
assert.equal(new URL(origin).hostname, '127.0.0.1');
const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'));
const target = (await listCdpTargets('127.0.0.1', port)).find((t) => t.id === targetId);
assert(target, 'Choose an owned authenticated Agent Chrome tab');
const page = await CdpWebPage.connectToTarget(target);
await mkdir(output, { recursive: true });
const query = 'fail closed';
const walk =
  "const walk=r=>[...r.querySelectorAll('*')].flatMap(e=>e.shadowRoot?[e,...walk(e.shadowRoot)]:[e]);const all=walk(document);";
const inspect = () =>
  page.evaluate(
    `(()=>{${walk}const explorer=all.find(e=>e.getAttribute('data-testid')==='run-artifact-explorer');const pane=explorer?walk(explorer):[];const browser=pane.find(e=>e.localName==='artifact-browser');const detail=all.find(e=>e.localName==='run-detail');const search=pane.find(e=>e.localName==='artifact-content-search');const preview=pane.find(e=>e.localName==='artifact-content-preview');return {url:location.hash,run:detail?.run?.id,files:browser?.artifacts?.length,view:browser?.viewState,hits:search?.shadowRoot?.querySelectorAll('.hit').length??0,searchText:search?.shadowRoot?.textContent?.slice(-1200),activeLine:preview?.line,activeText:preview?.shadowRoot?.querySelector('.line.active')?.textContent,previewError:preview?.error,treeText:browser?.shadowRoot?.textContent?.slice(-500),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}}})()`,
  );
const until = async (accept, label) => {
  const end = Date.now() + 90000;
  for (;;) {
    const v = await inspect();
    if (accept(v)) return v;
    assert(Date.now() < end, label + ':' + JSON.stringify(v));
    await delay(100);
  }
};
const save = (name, value) =>
  writeFile(path.join(output, name + '.json'), JSON.stringify(value, null, 2) + '\n');
const shot = async (name) => {
  await page.evaluate(
    `(()=>{${walk}const root=all.find(e=>e.getAttribute('data-testid')==='run-artifact-explorer');root?.closest('[data-panel="run-artifacts"]')?.scrollIntoView({block:'start'});return true})()`,
  );
  await page.evaluate(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
  );
  const r = await page.session.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, name + '.png'), Buffer.from(r.data, 'base64'));
};
const errors = [];
try {
  await page.session.call('Runtime.enable');
  page.session.on('Runtime.exceptionThrown', (r) => errors.push(r.exceptionDetails));
  await page.session.call('Page.bringToFront');
  await page.session.call('Emulation.setDeviceMetricsOverride', {
    width: 1234,
    height: 1050,
    deviceScaleFactor: 0.9,
    mobile: false,
  });
  await page.navigate(
    `${origin}/#run/${fixture.runId}?artifactQuery=${encodeURIComponent(query)}&panels=sidebar`,
  );
  await page.session.call('Page.reload', { ignoreCache: true });
  await page.waitForDocumentReady({ timeoutMs: 45000 });
  await until((v) => v.run === fixture.runId && v.files > 0, 'real imported artifact inventory');
  const intro = await page.evaluate(
    `(()=>{${walk}return all.some(e=>e.tagName==='BUTTON'&&e.textContent.trim()==='Got it')})()`,
  );
  if (intro) await page.clickText('Got it');
  if (phase === 'before') {
    const before = await until(
      (v) => v.treeText?.includes('No files match'),
      'path-only filter cannot find content',
    );
    await save('result', {
      phase,
      status: 'PASS',
      sourceRunId: fixture.sourceRunId,
      snapshot: before,
      errors,
    });
    await shot('path-only');
  } else {
    await page.setInput('input[aria-label="Filter files"]', '');
    await page.click('button[data-testid="artifact-search-toggle"]');
    await page.waitForSelector('input[aria-label="Search file contents"]', { timeoutMs: 15000 });
    await page.setInput('input[aria-label="Search file contents"]', query);
    await page.click('button[type="submit"]');
    const found = await until((v) => v.hits > 0, 'content-only match');
    await save('matches', found);
    await shot('matches');
    await page.click('button.hit');
    const selected = await until(
      (v) => v.activeText?.toLowerCase().includes(query),
      'original matching line in preview',
    );
    assert(selected.activeLine > 0);
    await save('selected', selected);
    await shot('selected');
    await page.setInput(
      'input[aria-label="Search file contents"]',
      'ccux-no-content-match-8675309',
    );
    await page.click('button[type="submit"]');
    const empty = await until(
      (v) => v.hits === 0 && v.searchText?.includes('No content matches'),
      'no-match response',
    );
    await save('no-match', empty);
    await page.setInput('input[aria-label="Search file contents"]', query);
    await page.click('button[type="submit"]');
    await until((v) => v.hits > 0, 'restored query');
    await page.click('button.hit');
    await until((v) => v.activeText?.toLowerCase().includes(query), 'restored line');
    await page.session.call('Page.reload');
    const reloaded = await until(
      (v) => v.run === fixture.runId && v.activeText?.toLowerCase().includes(query),
      'search and exact line restore after reload',
    );
    await save('reloaded', reloaded);
    await shot('reloaded');
    assert.deepEqual(errors, []);
    await save('result', {
      phase,
      status: 'PASS',
      sourceRunId: fixture.sourceRunId,
      selected,
      reloaded,
      errors,
    });
  }
} finally {
  page.close();
}
