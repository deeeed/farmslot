import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import browserCdp from '../../../../packages/adapter-web/src/browser-cdp.cjs';

/** Real wheel input proves that an overflowing fixture fleet remains reachable. */
export async function proveFleetScrolling(output, route) {
  assert.ok(process.env.FARMSLOT_UI_URL, 'Set the owned proof UI URL');
  const origin = new URL(process.env.FARMSLOT_UI_URL).origin;
  const browser = await browserCdp.connectBrowserCdp(Number(process.env.FARMSLOT_CDP_PORT));
  try {
    const { targetInfos } = await browser.send('Target.getTargets');
    const targets = targetInfos.filter(
      (target) =>
        target.type === 'page' &&
        target.url.startsWith(origin + '/') &&
        (new URL(target.url).hash === '#' + route ||
          new URL(target.url).hash.startsWith('#' + route + '&')),
    );
    assert.equal(targets.length, 1, 'Select exactly the owned proof tab');
    const { sessionId } = await browser.send('Target.attachToTarget', {
      targetId: targets[0].targetId,
      flatten: true,
    });
    await browser.send('Page.bringToFront', {}, sessionId);
    const expression = `(() => {
      const fleet=document.querySelector('fleet-canvas');
      const canvas=fleet?.shadowRoot.querySelector('.canvas');
      if(!canvas) throw Error('Fleet canvas absent');
      const deep=(selector,root)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].flatMap(e=>e.shadowRoot?deep(selector,e.shadowRoot):[])];
      const last=deep('slot-card',fleet.shadowRoot).find(e=>e.slotData?.slot==='proof-layout-23');
      if(!last) throw Error('Overflow fixture row absent');
      const rect=canvas.getBoundingClientRect(), end=last.getBoundingClientRect();
      return {height:canvas.clientHeight,total:canvas.scrollHeight,scroll:canvas.scrollTop,
        top:rect.top,bottom:rect.bottom,x:rect.x+rect.width/2,y:rect.y+rect.height/2,
        lastTop:end.top,lastBottom:end.bottom,viewport:innerHeight};
    })()`;
    const read = async () => {
      const value = await browser.send(
        'Runtime.evaluate',
        { expression, returnByValue: true },
        sessionId,
      );
      assert.ok(!value.exceptionDetails, JSON.stringify(value.exceptionDetails));
      return value.result.value;
    };
    const before = await read();
    assert.ok(
      before.height > 0 && before.total > before.height,
      'Fleet must overflow its scroll container',
    );
    assert.ok(
      before.bottom <= before.viewport + 1,
      'Fleet scroll container must remain inside the viewport',
    );
    await browser.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: before.x, y: before.y, deltaX: 0, deltaY: 100000 },
      sessionId,
    );
    await browser.send(
      'Runtime.evaluate',
      {
        expression: 'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
        awaitPromise: true,
      },
      sessionId,
    );
    const after = await read();
    assert.ok(after.scroll > 0, 'Real wheel input must scroll the fleet');
    assert.ok(
      after.lastTop >= after.top - 1 && after.lastBottom <= after.bottom + 1,
      'Last fleet row must be reachable',
    );
    await browser.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: before.x, y: before.y, deltaX: 0, deltaY: -100000 },
      sessionId,
    );
    return { pass: true, before, after, output: path.join(output, 'fleet-scroll-proof.json') };
  } finally {
    browser.close();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await proveFleetScrolling(
    process.env.FARMSLOT_WORKSPACE_UI_PROOF_OUT,
    process.env.FARMSLOT_WORKSPACE_PROOF_ROUTE ?? 'fleet?proof=fleet1490',
  );
  const { writeFile } = await import('node:fs/promises');
  await writeFile(result.output, JSON.stringify(result, null, 2) + '\n');
  console.log('Overflowing fleet wheel/last-row proof PASS');
}
