// Real retained-report UI proof, including its sandboxed child document.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';

const route = process.env.FARMSLOT_HTML_REPORT_ROUTE;
const origin = process.env.FARMSLOT_UI_URL;
const port = process.env.FARMSLOT_CDP_PORT ?? '19223';
assert.ok(route && origin, 'Set FARMSLOT_HTML_REPORT_ROUTE and FARMSLOT_UI_URL');
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = tabs.find(
  (tab) => tab.type === 'page' && tab.url.startsWith(origin) && tab.url.includes(`#${route}`),
);
assert.ok(target, 'Open the retained HTML report on the isolated validation UI');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await once(socket, 'open');
let sequence = 0;
let reportSession;
const pending = new Map();
socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
});
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function evaluate(expression, contextId) {
  const result = await call(
    'Runtime.evaluate',
    { expression, contextId, returnByValue: true, awaitPromise: true },
    contextId ? reportSession : undefined,
  );
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.text + ': ' + result.result?.description);
  return result.result?.value;
}
try {
  await call('Page.bringToFront');
  await call('Page.enable');
  const hostFrame = `document.querySelector('run-detail')?.shadowRoot?.querySelector('media-lightbox')?.shadowRoot?.querySelector('iframe')`;
  const selectedByRoute = await evaluate(
    `new URLSearchParams(location.hash.split('?')[1]).has('artifact')`,
  );
  if (selectedByRoute) {
    for (let i = 0; i < 60; i++) {
      if (await evaluate(`Boolean(${hostFrame})`)) break;
      await delay(100);
    }
  }
  if (!(await evaluate(`Boolean(${hostFrame})`))) {
    if (selectedByRoute) {
      console.error(
        'HTML artifact hydration diagnostics',
        await evaluate(`(() => {
        const run=document.querySelector('run-detail');
        const lightbox=run?.shadowRoot?.querySelector('media-lightbox');
        return {route:location.hash,runId:run?.runId, lightboxOpen:lightbox?.open, items:lightbox?.items?.map(i=>i.path), selected:lightbox?.selectedIndex,
          runReport:run?.run?.output?.reportPath, artifactCount:run?.run?.output?.artifactManifest?.length,
          lightboxText:lightbox?.shadowRoot?.textContent?.slice(-1200)};
      })()`),
      );
    }
    assert.equal(
      selectedByRoute,
      false,
      'Selected HTML artifact must hydrate without replacing it with another report',
    );
    execFileSync(
      process.execPath,
      [
        'apps/command-center/scripts/cdp.mjs',
        'click',
        route,
        'run-detail >>> [data-testid="run-results"] .evidence-actions button',
      ],
      { env: process.env, stdio: 'pipe' },
    );
    for (let i = 0; i < 40; i++) {
      if (await evaluate(`Boolean(${hostFrame})`)) break;
      await delay(100);
    }
  }
  const frameObject = await call('Runtime.evaluate', { expression: hostFrame });
  const { node } = await call('DOM.describeNode', { objectId: frameObject.result.objectId });
  const frameId = node.frameId ?? node.contentDocument?.frameId;
  assert.ok(frameId, 'The displayed report must own an iframe');
  const findFrame = (tree) =>
    tree.frame.id === frameId ? tree.frame : (tree.childFrames ?? []).map(findFrame).find(Boolean);
  let reportFrame;
  for (let i = 0; i < 60; i++) {
    const { frameTree } = await call('Page.getFrameTree', {}, reportSession);
    reportFrame = findFrame(frameTree);
    if (!reportFrame && !reportSession) {
      // Opaque documents may move to a separate process during navigation.
      // Attach only to the frame owned by the displayed iframe.
      const { targetInfos } = await call('Target.getTargets');
      if (targetInfos.some((target) => target.targetId === frameId)) {
        const attached = await call('Target.attachToTarget', { targetId: frameId, flatten: true });
        reportSession = attached.sessionId;
        await call('Page.enable', {}, reportSession);
      }
    }
    if (reportFrame?.url.startsWith('about:srcdoc')) break;
    await delay(100);
  }
  assert.ok(
    reportFrame?.url.startsWith('about:srcdoc'),
    `Report must remain a srcdoc document: ${reportFrame?.url}`,
  );
  const { executionContextId } = await call(
    'Page.createIsolatedWorld',
    { frameId, worldName: 'report-proof-readonly' },
    reportSession,
  );
  const parentBefore = await evaluate('location.href');
  const frameElement = `document.querySelector('run-detail').shadowRoot.querySelector('media-lightbox').shadowRoot.querySelector('iframe')`;
  const sandbox = await evaluate(`${frameElement}.getAttribute('sandbox')`);
  assert.ok(!sandbox.includes('allow-scripts') && !sandbox.includes('allow-same-origin'));
  async function click(selector) {
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`,
      executionContextId,
    );
    await delay(150);
    const point = await evaluate(
      `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error('Missing report control'); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
      executionContextId,
    );
    const offset = await evaluate(
      `(() => { const r=${frameElement}.getBoundingClientRect();return {x:r.x,y:r.y}; })()`,
    );
    const params = {
      x: offset.x + point.x,
      y: offset.y + point.y,
      button: 'left',
      clickCount: 1,
    };
    await call('Input.dispatchMouseEvent', { ...params, type: 'mousePressed' });
    await call('Input.dispatchMouseEvent', { ...params, type: 'mouseReleased' });
    await delay(100);
  }
  if (process.env.FARMSLOT_HTML_HOSTILE_PROOF === '1') {
    const hostile = await evaluate(
      `({
      title: document.querySelector('h1')?.textContent,
      executable: document.querySelectorAll('script,iframe,object,embed,form,meta[http-equiv="refresh"]').length,
      handlers: [...document.querySelectorAll('*')].some(el => [...el.attributes].some(a => a.name.startsWith('on'))),
      javascriptLinks: [...document.querySelectorAll('a[href]')].some(a => /^javascript:/i.test(a.getAttribute('href'))),
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content,
      remoteImageLoaded: [...document.images].some(img => /^https?:/.test(img.src) && img.naturalWidth > 0),
      unresolvedMediaSources: [...document.querySelectorAll('video[src],audio[src],source[src]')].some(el => /^https?:/.test(el.src)),
      parentBlocked: (()=>{try{return !parent.document}catch{return true}})(),
    })`,
      executionContextId,
    );
    assert.equal(hostile.title, 'Hostile report fixture');
    assert.equal(hostile.executable, 0);
    assert.equal(hostile.handlers, false);
    assert.equal(hostile.javascriptLinks, false);
    assert.equal(hostile.remoteImageLoaded, false);
    assert.equal(hostile.unresolvedMediaSources, false);
    assert.equal(hostile.parentBlocked, true);
    assert.ok(hostile.csp.includes("default-src 'none'") && !hostile.csp.includes('unsafe-eval'));
    const mainWorld = await call(
      'Runtime.evaluate',
      { expression: 'Boolean(window.reportAttack)', returnByValue: true },
      reportSession,
    );
    assert.equal(mainWorld.result.value, false);
    assert.equal(await evaluate('Boolean(document.body.dataset.reportAttack)'), false);
    console.log(JSON.stringify({ pass: true, hostileContentIsolated: true, ...hostile }));
  } else if (process.env.FARMSLOT_HTML_VIDEO_PROOF === '1') {
    for (let i = 0; i < 80; i++) {
      if (await evaluate('document.querySelector("video")?.readyState >= 1', executionContextId))
        break;
      await delay(100);
    }
    const media = await evaluate(
      `(() => {
      const v=document.querySelector('video'),a=document.querySelector('a[data-trace-index]');
      return {ready:v?.readyState,duration:v?.duration,controls:v?.controls,href:a?.href,scriptCount:document.scripts.length,
        parentBlocked:(()=>{try{return !parent.document}catch{return true}})()};
    })()`,
      executionContextId,
    );
    assert.ok(media.ready >= 1 && media.duration > 0, 'Retained inline video must load');
    assert.equal(media.controls, true);
    assert.equal(media.scriptCount, 0);
    assert.equal(media.parentBlocked, true);
    const proofUrl = new URL(media.href);
    assert.ok(proofUrl.hash.includes('artifactTrace='));
    assert.ok(
      !proofUrl.search && !proofUrl.hash.includes('token='),
      'Report navigation must not export credentials',
    );
    await click('a[data-trace-index]');
    const proofRoute = proofUrl.hash.slice(1);
    let state;
    for (let i = 0; i < 80; i++) {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (pages.some((page) => page.type === 'page' && page.url === media.href)) {
        state = JSON.parse(
          execFileSync(
            process.execPath,
            [
              'apps/command-center/scripts/cdp.mjs',
              'eval',
              proofRoute,
              `const b=document.querySelector('run-detail')?.shadowRoot?.querySelector('media-lightbox');const v=b?.shadowRoot?.querySelector('video');return {time:v?.currentTime,paused:v?.paused,ready:v?.readyState,enabled:Boolean(b?.shadowRoot?.querySelector('[data-testid="video-next-frame"]:not([disabled])'))};`,
            ],
            { env: process.env, encoding: 'utf8' },
          ),
        );
        if (state.enabled && state.ready >= 2 && state.time > 0) break;
      }
      await delay(150);
    }
    assert.ok(
      state?.enabled && state.time > 0 && state.paused,
      'Proof link must open validated frame navigation at its marker',
    );
    console.log(
      JSON.stringify({ pass: true, inlineVideo: true, proofLink: true, media, viewer: state }),
    );
  } else {
    const initial = await evaluate(
      `({
    title: document.querySelector('h1')?.textContent,
    criteria: document.querySelectorAll('details.criterion').length,
    expanded: document.querySelectorAll('details.criterion[open]').length,
    intentionallyExcluded: document.querySelectorAll('details.criterion[data-outside-plan="true"][data-verdict="UNTESTABLE"]').length,
    sourceStatuses: [...document.querySelectorAll('.toc > ol > li > .badge')].map(el => el.textContent),
    images: [...document.images].filter(image => image.complete && image.naturalWidth > 0).length,
    scriptCount: document.scripts.length,
    parentBlocked: (() => { try { return !parent.document; } catch { return true; } })(),
  })`,
      executionContextId,
    );
    assert.ok(initial.criteria > 0);
    assert.equal(
      initial.expanded,
      initial.criteria - initial.intentionallyExcluded,
      'Selected criteria start expanded; excluded detail stays accessible',
    );
    if (process.env.FARMSLOT_HTML_PLAN_PROOF === '1') {
      assert.ok(initial.sourceStatuses.includes('Selected checks passed'));
      assert.ok(initial.sourceStatuses.includes('Selected checks incomplete'));
      assert.ok(initial.intentionallyExcluded > 0);
      assert.match(
        await evaluate('document.body.textContent', executionContextId),
        /2\/3 selected checks proved; 2\/4 full criteria proved/,
      );
    } else {
      assert.ok(initial.sourceStatuses.includes('Fully validated'));
      assert.ok(initial.sourceStatuses.includes('Partially validated'));
      assert.ok(initial.images > 0, 'Retained screenshots are embedded and loaded');
    }
    assert.equal(initial.scriptCount, 0);
    assert.equal(initial.parentBlocked, true);
    await click('details.criterion summary');
    assert.equal(
      await evaluate(`document.querySelector('details.criterion').open`, executionContextId),
      false,
    );
    await click('details.criterion summary');
    assert.equal(
      await evaluate(`document.querySelector('details.criterion').open`, executionContextId),
      true,
    );
    await click('#filter-gaps');
    assert.equal(
      await evaluate(`document.querySelector('#filter-gaps').checked`, executionContextId),
      true,
    );
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('.criterion[data-verdict="PASS"]')].some(el => getComputedStyle(el).display !== 'none')`,
        executionContextId,
      ),
      false,
    );
    await click('#filter-all');
    if (process.env.FARMSLOT_HTML_PLAN_PROOF === '1') {
      await click('#filter-gaps');
      assert.equal(
        await evaluate(
          `[...document.querySelectorAll('.criterion[data-outside-plan="true"][data-verdict="UNTESTABLE"]')].some(el => getComputedStyle(el).display !== 'none')`,
          executionContextId,
        ),
        false,
      );
      await click('#filter-all');
    }
    const anchor = await evaluate(
      `document.querySelector('.toc a[href^="about:srcdoc#ac-"]').getAttribute('href')`,
      executionContextId,
    );
    await click('.toc a[href^="about:srcdoc#ac-"]');
    assert.equal(await evaluate('location.href', executionContextId), anchor);
    assert.equal(
      await evaluate('location.href'),
      parentBefore,
      'Contents links must not navigate the host app',
    );
    const sticky = await evaluate(
      `(() => { const nav=document.querySelector('.quick-nav'); return {position:getComputedStyle(nav).position,top:nav.getBoundingClientRect().top}; })()`,
      executionContextId,
    );
    assert.equal(sticky.position, 'sticky');
    assert.ok(Math.abs(sticky.top) < 2, 'Quick navigation remains visible after a contents jump');
    execFileSync(
      process.execPath,
      [
        'apps/command-center/scripts/cdp.mjs',
        'click',
        route,
        'run-detail >>> media-lightbox >>> [data-testid="artifact-maximize"]',
      ],
      { env: process.env, stdio: 'pipe' },
    );
    await delay(100);
    const maximized = await evaluate(
      `(() => {const box=document.querySelector('run-detail').shadowRoot.querySelector('media-lightbox').shadowRoot.querySelector('.ml-modal');const r=box.getBoundingClientRect();return {width:r.width,height:r.height,vw:innerWidth,vh:innerHeight};})()`,
    );
    assert.ok(
      Math.abs(maximized.width - maximized.vw) < 2 && Math.abs(maximized.height - maximized.vh) < 2,
    );
    execFileSync(
      process.execPath,
      [
        'apps/command-center/scripts/cdp.mjs',
        'screenshot',
        route,
        '/tmp/html-report-interactive.png',
      ],
      { env: process.env, stdio: 'pipe' },
    );
    console.log(
      JSON.stringify({
        pass: true,
        ...initial,
        collapseExpand: true,
        verdictFilter: true,
        contentsNavigation: true,
        stickyNavigation: true,
        viewerMaximized: true,
      }),
    );
  }
} finally {
  socket.close();
}
