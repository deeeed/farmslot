#!/usr/bin/env tsx
// Live PR workspace proof. Reads gateway state; never starts reviews or repairs.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CdpWebPage, listCdpTargets } from '../packages/recipe-harness/src/runtime/cdp.js';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import type {
  PRMonitor,
  PRRulesListResult,
  PRWatchListResult,
} from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const url = process.env.FARMSLOT_UI_URL;
assert(url, 'Set FARMSLOT_UI_URL to the connected PR dashboard');
const out = process.env.SETUP_ARTIFACTS ?? '/tmp/pr-workspace';
await mkdir(out, { recursive: true });
const conn = await new GatewayClient({
  url: process.env.GW_URL ?? `ws://localhost:${process.env.GATEWAY_PORT ?? 7777}`,
  timeout: 15000,
}).connect();
const before = await conn.call<PRWatchListResult>('prWatch.list');
const reviews = await conn.call<PRRulesListResult>('prRules.list');
const monitors = before.monitors.filter((m) => !['finished', 'stopped'].includes(m.lifecycle));
assert(monitors.length >= 2, 'Need at least two current monitors');
const first = monitors.find(
  (m) =>
    m.lifecycle === 'active' && !m.activeRuns?.length && m.incidents.some((i) => !i.resolvedAt),
);
assert(first, 'Need an idle monitored PR with an incident for repair-form checks');
const held = monitors.find((m) => m.lifecycle === 'active' && m.activeRuns?.length);
if (process.env.SETUP_REQUIRE_ACTIVE_WORK === '1') assert(held);
if (held) {
  const { monitor } = await conn.call<{ monitor: PRMonitor }>('prWatch.refresh', { id: held.id });
  assert.deepEqual(monitor.observation, held.observation);
  assert.equal(monitor.nextCheckAt, held.nextCheckAt);
  assert.equal(monitor.revision, held.revision);
}
const port = Number(process.env.FARMSLOT_CDP_PORT ?? 9323);
const target = (await listCdpTargets('127.0.0.1', port)).find(
  (t) => t.type === 'page' && t.webSocketDebuggerUrl,
);
assert(target);
const host = await CdpWebPage.connectToTarget(target);
const { targetId } = await host.session.call<{ targetId: string }>('Target.createTarget', {
  url: 'about:blank',
});
const created = (await listCdpTargets('127.0.0.1', port)).find((t) => t.id === targetId);
assert(created);
const page = await CdpWebPage.connectToTarget(created);
const roots = `const roots=[document];for(let i=0;i<roots.length;i++)for(const el of roots[i].querySelectorAll('*'))if(el.shadowRoot)roots.push(el.shadowRoot);`;
const read = <T,>(body: string) => page.evaluate<T>(`(()=>{${roots}${body}})()`);
const query = (selector: string) =>
  `roots.map(r=>r.querySelector(${JSON.stringify(selector)})).find(Boolean)`;
const row = (id: string) => `[data-monitor-ids~="${id}"]`;
const card = (id: string) => `[data-monitor-id="${id}"]`;
const shot = async (name: string) => {
  await page.waitForExpression(
    `(()=>{${roots}const detail=${query('[data-testid="pr-workspace-detail"]')};return !detail || detail.getAnimations().every(a=>a.playState==='finished');})()`,
  );
  await writeFile(join(out, name), Buffer.from((await page.screenshot()) as string, 'base64'));
};
const click = async (selector: string) => {
  console.log('Click', selector);
  await page.click(selector);
};
let expandedSidebar = false;
try {
  await page.session.call('Page.bringToFront');
  await page.session.call('Page.navigate', { url });
  await page.waitForSelector('[data-testid="pr-workspace-prs"]', { timeoutMs: 90000 });
  await click('[data-testid="pr-workspace-prs"]');
  await click('[data-testid="pr-automation-tab-monitors"]');
  await page.waitForSelector(row(first.id), { timeoutMs: 90000 });
  expandedSidebar = await page.evaluate<boolean>(
    `!!document.querySelector('[title="Collapse sidebar"]')`,
  );
  if (expandedSidebar) await click('[title="Collapse sidebar"]');
  let accountReads = 0;
  const submittedWork: string[] = [];
  await page.session.call('Network.enable');
  page.session.on('Network.webSocketFrameSent', (params) => {
    const raw = (params.response as { payloadData?: string } | undefined)?.payloadData;
    if (!raw?.startsWith('{')) return;
    const frame = JSON.parse(raw);
    if (frame.type === 'req' && frame.method === 'config.githubAccounts') accountReads++;
    if (
      frame.type === 'req' &&
      [
        'prReview.submit',
        'prRules.accept',
        'prWatch.repair',
        'run.create',
        'dispatch.execute',
      ].includes(frame.method)
    )
      submittedWork.push(frame.method);
  });
  for (const width of [1280, 390]) {
    await page.session.call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await click('[data-testid="pr-workspace-prs"]');
    await click('[data-testid="pr-automation-tab-monitors"]');
    if (
      await read<boolean>(
        `return ${query('[data-testid="pr-workspace-back"]')}?.getBoundingClientRect().width>0;`,
      )
    )
      await click('[data-testid="pr-workspace-back"]');
    const rows = await read<string[]>(
      `return roots.flatMap(r=>[...r.querySelectorAll('[data-testid="pr-workspace-row"]')]).map(el=>el.dataset.prKey);`,
    );
    assert.equal(rows.length, new Set(rows).size, 'One row per canonical PR');
    for (const monitor of monitors)
      assert(await read<boolean>(`return Boolean(${query(row(monitor.id))});`));
    const fits = await read<boolean>(
      `const el=${query('[data-testid="pr-workspace"]')};const box=el.getBoundingClientRect();return box.height>200&&box.bottom<=innerHeight+1&&box.right<=innerWidth+1&&el.scrollWidth<=el.clientWidth;`,
    );
    assert(fits, 'Workspace stays inside viewport');
    assert(
      await read<boolean>(
        `const list=${query('[data-testid="pr-workspace-list"]')};const workspace=${query('[data-testid="pr-workspace"]')};const detail=${query('[data-testid="pr-workspace-detail"]')};return Math.abs(list.getBoundingClientRect().width-workspace.getBoundingClientRect().width)<2 && detail.getBoundingClientRect().width===0;`,
      ),
      'The unselected list fills the workspace and no detail column is reserved',
    );
    await shot(`list-${width}.png`);
    // Selecting the last row scrolls through the real browser interaction path.
    assert(rows.length);
    await click(`[data-pr-key="${rows.at(-1)}"]`);
    const endScroll = await read<number>(
      `return ${query('[data-testid="pr-workspace-list"]')}.scrollTop;`,
    );
    const hasOverflow = await read<boolean>(
      `const list=${query('[data-testid="pr-workspace-list"]')};return list.scrollHeight>list.clientHeight+1;`,
    );
    if (hasOverflow) assert(endScroll > 0, 'Exercise return from a scrolled list');
    await shot(`last-pr-${width}.png`);
    await click('[data-testid="pr-workspace-back"]');
    assert.equal(
      await read<number>(`return ${query('[data-testid="pr-workspace-list"]')}.scrollTop;`),
      endScroll,
      'Closing keeps the scrolled list position',
    );
    await click(row(first.id));
    await page.waitForSelector(card(first.id));
    assert.equal(
      await read<number>(
        `return roots.reduce((n,r)=>n+r.querySelectorAll('[data-monitor-id]').length,0);`,
      ),
      1,
      'Only selected PR monitoring is rendered',
    );
    const params = new URLSearchParams(
      (await page.evaluate<string>('location.hash')).split('?')[1],
    );
    assert.equal(params.get('pr'), String(first.config.pr.number));
    assert.equal(params.get('repo')?.toLowerCase(), first.config.pr.repo.toLowerCase());
    assert.equal(params.get('prPane'), 'monitoring');
    await page.waitForExpression(
      `(()=>{${roots}return ${query('[data-testid="pr-workspace-detail"]')}.getAnimations().every(a=>a.playState==='finished');})()`,
    );
    assert(
      await read<boolean>(
        `const list=${query('[data-testid="pr-workspace-list"]')}.getBoundingClientRect();const detail=${query('[data-testid="pr-workspace-detail"]')};const d=detail.getBoundingClientRect();const w=${query('[data-testid="pr-workspace"]')}.getBoundingClientRect();return getComputedStyle(detail).position==='absolute' && Math.abs(list.width-w.width)<2 && Math.abs(d.right-w.right)<2 && d.left>=w.left && d.bottom<=w.bottom+1 && (innerWidth>760 ? d.width<w.width : Math.abs(d.width-w.width)<2);`,
      ),
      'Detail overlays the unchanged full-width list and fits the viewport',
    );
    const listScroll = await read<number>(
      `return ${query('[data-testid="pr-workspace-list"]')}.scrollTop;`,
    );
    if (width > 760) {
      // The overlay covers the row's center. Click the exposed portion a human can use.
      const point = await read<{ x: number; y: number; hit: boolean }>(
        `const el=${query(row(first.id))};const r=el.getBoundingClientRect();const d=${query('[data-testid="pr-workspace-detail"]')}.getBoundingClientRect();const x=r.left+Math.min(30,(d.left-r.left)/2);const y=r.top+r.height/2;return {x,y,hit:el.contains(el.getRootNode().elementFromPoint(x,y))};`,
      );
      assert(point.hit, 'The selected row remains clickable beside the overlay');
      await page.clickPoint(point.x, point.y);
    } else await click('[data-testid="pr-workspace-back"]');
    assert.equal(
      await read<number>(
        `return ${query('[data-testid="pr-workspace-detail"]')}.getBoundingClientRect().width;`,
      ),
      0,
    );
    assert.equal(
      await read<number>(`return ${query('[data-testid="pr-workspace-list"]')}.scrollTop;`),
      listScroll,
    );
    assert.equal(
      new URLSearchParams((await page.evaluate<string>('location.hash')).split('?')[1]).get('pr'),
      null,
    );
    assert(
      await read<boolean>(
        `const el=${query(row(first.id))};return el.getRootNode().activeElement===el;`,
      ),
      'Closing restores row focus',
    );
    await page.evaluate('history.back()');
    await page.waitForSelector(card(first.id));
    await page.keyPress('Escape');
    await page.waitForExpression(`location.hash.indexOf('pr=${first.config.pr.number}')===-1`);
    assert.equal(
      await read<number>(
        `return ${query('[data-testid="pr-workspace-detail"]')}.getBoundingClientRect().width;`,
      ),
      0,
    );
    await click(row(first.id));
    await page.waitForSelector(card(first.id));
    await shot(`monitoring-${width}.png`);
    await click('[data-testid="pr-detail-overview"]');
    await page.waitForSelector('[data-testid="pr-workspace-detail"] pr-card', { timeoutMs: 90000 });
    assert.equal(
      await read<number>(`return ${query('[data-testid="pr-workspace-detail"] pr-card')}.pr.pr;`),
      first.config.pr.number,
    );
    await shot(`viewer-${width}.png`);
    await page.evaluate('history.back()');
    await page.waitForSelector(card(first.id));
    await page.evaluate('history.forward()');
    await page.waitForSelector('[data-testid="pr-workspace-detail"] pr-card');
    const priorOrigin = await page.evaluate<number>('performance.timeOrigin');
    await page.session.call('Page.reload');
    await page.waitForExpression(
      `performance.timeOrigin !== ${priorOrigin} && document.readyState === 'complete'`,
      { timeoutMs: 90000 },
    );
    await page.waitForSelector('[data-testid="pr-workspace-detail"] pr-card', { timeoutMs: 90000 });
    assert.equal(
      await read<number>(`return ${query('[data-testid="pr-workspace-detail"] pr-card')}.pr.pr;`),
      first.config.pr.number,
    );
    await click('[data-testid="pr-detail-monitoring"]');
    await page.waitForSelector(card(first.id));
    await click(`${card(first.id)} [data-testid="pr-monitor-edit"]`);
    await page.waitForSelector('[data-testid="pr-monitor-limits"]');
    await click('[data-testid="pr-monitor-limits"]');
    assert.equal(
      await read<string>(`return ${query('[data-testid="pr-monitor-interval"]')}.value;`),
      String(first.config.pollIntervalMs / 60000),
    );
    await click('[data-testid="pr-automation-editor-close"]');
    await click(`${card(first.id)} [data-testid="pr-monitor-repair"]`);
    await page.waitForSelector('[data-testid="pr-agent-repair-form"]');
    assert(
      await read<boolean>(
        `return ${query('[data-testid="pr-agent-repair-form"]')}.textContent.includes('push commits');`,
      ),
    );
    await click('[data-testid="pr-automation-editor-close"]');
    if (held) {
      await click(`${card(first.id)} > summary`);
      assert.equal(await read<boolean>(`return ${query(card(first.id))}.open;`), false);
      await click(`${card(first.id)} > summary`);
      assert.equal(await read<boolean>(`return ${query(card(first.id))}.open;`), true);
      await click('[data-testid="pr-workspace-back"]');
      await click(row(held.id));
      await page.waitForSelector(`${card(held.id)}[data-work-suspended="true"]`);
      assert(
        await read<boolean>(
          `return ${query(`${card(held.id)} [data-testid="pr-monitor-refresh"]`)}.disabled && ${query(`${card(held.id)} [data-testid="pr-monitor-repair"]`)}.disabled;`,
        ),
      );
      await shot(`active-work-${width}.png`);
    }
    await click('[data-testid="pr-automation-tab-reviews"]');
    await click('[data-testid="pr-workspace-request-review"]');
    await page.waitForSelector('pr-review-request-form');
    await shot(`request-${width}.png`);
    assert(
      await read<boolean>(
        `const d=${query('[data-testid="pr-workspace-detail"]')};return d.getRootNode().activeElement===d;`,
      ),
      'Opening a global form focuses the overlay',
    );
    await page.keyPress('Escape');
    assert(
      await read<boolean>(
        `return ${query('[data-testid="pr-automation-editor-close"]')}.getBoundingClientRect().width>0;`,
      ),
      'Escape does not discard an open editor',
    );
    await click('[data-testid="pr-automation-editor-close"]');
    assert(
      await read<boolean>(
        `const b=${query('[data-testid="pr-workspace-request-review"]')};return b.getRootNode().activeElement===b;`,
      ),
      'Closing a global form restores its trigger',
    );
    const candidate =
      reviews.intents.find(
        (i) =>
          !['completed', 'failed', 'withdrawn'].includes(i.status) &&
          (!process.env.SETUP_REVIEW_PR || i.pr.number === Number(process.env.SETUP_REVIEW_PR)),
      ) ??
      reviews.intents.find(
        (i) => !process.env.SETUP_REVIEW_PR || i.pr.number === Number(process.env.SETUP_REVIEW_PR),
      );
    assert(candidate, 'Need a saved review candidate to validate review status');
    if (candidate) {
      if (
        !(await read<boolean>(`return Boolean(${query(`[data-review-ids~="${candidate.id}"]`)});`))
      ) {
        await click('.workspace-toolbar input[type=checkbox]');
      }
      await page.waitForSelector(`[data-review-ids~="${candidate.id}"]`);
      await click(`[data-review-ids~="${candidate.id}"]`);
      await page.waitForSelector(`[data-review-id="${candidate.id}"]`);
      await page.waitForExpression(
        `(()=>{${roots}const button=${query('[data-testid="pr-review-status-refresh"]')};return button && !button.disabled;})()`,
        { timeoutMs: 90000 },
      );
      const blocked = await read<boolean>(
        `return Boolean(${query('[data-testid="pr-review-start-blocked"]')});`,
      );
      const status = await read<string>(
        `return ${query('[data-testid="pr-review-readiness"]')}.textContent;`,
      );
      assert(status.includes('GitHub') || /Merged|Closed|Draft/.test(status));
      assert(!status.includes('Could not refresh:'), 'Current GitHub review observation succeeded');
      assert.equal(
        await read<number>(
          `return new Set(roots.flatMap(r=>[...r.querySelectorAll('.pr-row-statuses .rec-chip')]).map(el=>getComputedStyle(el).color)).size;`,
        ),
        1,
        'Run setup has one neutral color independent of GitHub status',
      );
      if (blocked) {
        assert(
          await read<boolean>(
            `return ${query('[data-testid="pr-review-request-open"]')}.disabled && !${query('[data-testid="pr-review-dispatch"]')};`,
          ),
          'Unnecessary reviews cannot start from the normal UI path',
        );
      } else {
        const dispatchHref = await read<string>(
          `return ${query('[data-testid="pr-review-dispatch"]')}.getAttribute('href');`,
        );
        const dispatch = new URLSearchParams(dispatchHref.split('?')[1]);
        assert.equal(dispatch.get('flow'), 'review-pr');
        assert.equal(
          dispatch.get('ticket')?.toLowerCase(),
          `${candidate.pr.repo}#${candidate.pr.number}`.toLowerCase(),
        );
      }
      await page.waitForExpression(
        `(()=>{${roots}return ${query('[data-testid="pr-detail-author"]')}?.textContent.includes('@');})()`,
        { timeoutMs: 90000 },
      );
      const authorText = await read<string>(
        `return ${query('[data-testid="pr-detail-author"]')}.textContent.trim();`,
      );
      if (process.env.SETUP_REVIEW_AUTHOR)
        assert(authorText.includes(`@${process.env.SETUP_REVIEW_AUTHOR}`));
      assert(
        await read<boolean>(
          `return ${query(`[data-review-ids~="${candidate.id}"] [data-testid="pr-row-author"]`)}.textContent.includes(${JSON.stringify(authorText.match(/@\S+/)?.[0])});`,
        ),
        'The review row and details show the same PR author',
      );
      await shot(`review-${width}.png`);
      if (blocked) {
        const href = await read<string>(
          `return ${query('[data-testid="pr-review-force"]')}.getAttribute('href');`,
        );
        const params = new URLSearchParams(href.split('?')[1]);
        assert.equal(params.get('flow'), 'review-pr');
        assert.equal(
          params.get('ticket')?.toLowerCase(),
          `${candidate.pr.repo}#${candidate.pr.number}`.toLowerCase(),
        );
        await click('[data-testid="pr-review-force"]');
        await page.waitForSelector('dispatch-wizard', { timeoutMs: 90000 });
        await page.waitForExpression(
          `(()=>{${roots}return ${query('input.ticket-input')}?.value.toLowerCase()===${JSON.stringify(`${candidate.pr.repo}#${candidate.pr.number}`.toLowerCase())};})()`,
          { timeoutMs: 90000 },
        );
        assert(
          await read<boolean>(
            `return roots.some(r=>[...r.querySelectorAll('.pill.selected')].some(el=>el.textContent.includes('Review PR')));`,
          ),
          'Manual override opens the review flow',
        );
        assert((await page.evaluate<string>('location.hash')).startsWith('#dispatch?'));
        await shot(`review-anyway-${width}.png`);
        await page.evaluate('history.back()');
        await page.waitForSelector(`[data-review-id="${candidate.id}"]`, { timeoutMs: 90000 });
      }
    }
    await click('[data-testid="pr-workspace-automation"]');
    await click('[aria-label="PR automation views"] [data-testid="pr-automation-tab-rules"]');
    await page.waitForSelector('[data-testid="pr-team-create"]');
    assert(
      await read<boolean>(
        `return roots.some(r=>r.querySelector('.team-config-card .team-kind')?.textContent.trim()==='Team') && roots.some(r=>r.querySelector('.rule-config-card .rule-kind')?.textContent.trim()==='Rule');`,
      ),
    );
    await shot(`rules-${width}.png`);
    assert.equal(
      await read<number>(
        `return roots.reduce((n,r)=>n+r.querySelectorAll('[data-monitor-id]').length,0);`,
      ),
      0,
    );
    await click('[data-testid="pr-automation-tab-policies"]');
    await shot(`automation-${width}.png`);
    // Reload and returning from manual dispatch legitimately mount fresh controllers.
    assert(accountReads <= 3, 'Only reload/full-route navigation refreshes account inventory');
    accountReads = 0;
  }
  const after = await conn.call<PRWatchListResult>('prWatch.list');
  assert.deepEqual(
    submittedWork,
    [],
    'No review, repair, or run was submitted by the browser flow',
  );
  for (const original of before.monitors) {
    const current = after.monitors.find((m) => m.id === original.id);
    assert(current);
    assert.deepEqual(current.config, original.config);
    assert.equal(current.lifecycle, original.lifecycle);
    assert.deepEqual(current.repairs, original.repairs);
  }
  console.log(
    JSON.stringify({
      passed: true,
      monitors: monitors.length,
      desktop: true,
      mobile: true,
      viewer: true,
      history: true,
      reload: true,
      settings: true,
      repairSetupOnly: true,
      activeWork: Boolean(held),
    }),
  );
} finally {
  if (
    expandedSidebar &&
    (await page.evaluate<boolean>(`!!document.querySelector('[title="Expand sidebar"]')`))
  )
    await click('[title="Expand sidebar"]');
  page.close();
  await host.session.call('Target.closeTarget', { targetId });
  host.close();
  conn.close();
}
