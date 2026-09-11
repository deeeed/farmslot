#!/usr/bin/env tsx
// Real browser interactions and gateway config reads; no team/rule writes or GitHub imports.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CdpWebPage, listCdpTargets } from '../packages/recipe-harness/src/runtime/cdp.js';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import type {
  ConfigProjectsResult,
  ConfigGitHubAccountsResult,
} from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const ui = process.env.FARMSLOT_UI_URL;
const farmName = process.env.SETUP_FARM;
assert(ui && farmName, 'Set FARMSLOT_UI_URL and SETUP_FARM to an existing farm');
const output = process.env.SETUP_ARTIFACTS ?? '/tmp/pr-team-setup';
await mkdir(output, { recursive: true });
const connection = await new GatewayClient({
  url: process.env.GW_URL ?? `ws://localhost:${process.env.GATEWAY_PORT ?? 7777}`,
  timeout: 15000,
}).connect();
const { projects } = await connection.call<ConfigProjectsResult>('config.projects');
const inventory = await connection.call<ConfigGitHubAccountsResult>('config.githubAccounts', {});
const login =
  process.env.SETUP_GITHUB_LOGIN ??
  (inventory.accounts.length === 1 ? inventory.accounts[0].login : undefined);
assert(
  login && inventory.accounts.some((account) => account.login === login),
  'Set SETUP_GITHUB_LOGIN to select a configured gateway account when multiple accounts exist',
);
const farm = projects.find((p) => p.name === farmName);
assert(farm?.ci.repo, 'Selected farm must have a configured repository');
connection.close();
const port = Number(process.env.FARMSLOT_CDP_PORT ?? 9323);
const targets = await listCdpTargets('127.0.0.1', port);
const hostTarget = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
assert(hostTarget);
const host = await CdpWebPage.connectToTarget(hostTarget);
const { targetId } = await host.session.call<{ targetId: string }>('Target.createTarget', {
  url: 'about:blank',
});
let page: CdpWebPage | undefined;
try {
  const target = (await listCdpTargets('127.0.0.1', port)).find((t) => t.id === targetId);
  assert(target);
  page = await CdpWebPage.connectToTarget(target);
  await page.session.call('Page.bringToFront');
  const methods: string[] = [];
  await page.session.call('Network.enable');
  page.session.on('Network.webSocketFrameSent', (params) => {
    const raw = (params.response as { payloadData?: unknown } | undefined)?.payloadData;
    if (typeof raw !== 'string') return;
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch (error) {
      if (error instanceof SyntaxError) return; // Other websocket protocols may send non-JSON frames.
      throw error;
    }
    if (frame.type === 'req' && typeof frame.method === 'string') methods.push(frame.method);
  });
  await page.navigate(ui);
  await page.waitForSelector('pr-automation-panel', { timeoutMs: 30000 });
  await page.waitForExpression(`document.querySelector('fleet-summary-bar')?.hydrated === true`, {
    timeoutMs: 90000,
  });
  await page.click('[data-testid="pr-workspace-automation"]');
  await page.click('[aria-label="PR automation views"] [data-testid="pr-automation-tab-rules"]');
  await page.waitForSelector('[data-testid="pr-team-create"]:not(:disabled)', { timeoutMs: 30000 });
  await page.click('[data-testid="pr-team-create"]');
  await page.waitForSelector('[data-testid="pr-team-farm"]');
  const query = `const roots=[document];let form;for(let i=0;i<roots.length;i++)for(const e of roots[i].querySelectorAll('*')){if(e.shadowRoot)roots.push(e.shadowRoot);if(e.tagName==='PR-TEAM-FORM')form=e;}if(!form)throw new Error('Team form missing');`;
  const inspect = <T,>(expression: string) => page!.evaluate<T>(`(()=>{${query}${expression}})()`);
  await page.waitForExpression(
    `(()=>{${query}return form.farms.some(f=>f.name===${JSON.stringify(farmName)})})()`,
    { timeoutMs: 15000 },
  );
  const selectedAccount = inventory.accounts.find((account) => account.login === login)!;
  await page.click('[data-testid="pr-team-account"]');
  await page.waitForSelector(
    `[data-choice-value="${selectedAccount.host}/${selectedAccount.login}"]`,
    { timeoutMs: 15000 },
  );
  await page.click(`[data-choice-value="${selectedAccount.host}/${selectedAccount.login}"]`);
  await page.waitForExpression(
    `(()=>{${query}return form.draft.account.login===${JSON.stringify(login)}})()`,
    { timeoutMs: 5000 },
  );
  const callsBefore = methods.length;
  assert(
    await inspect<boolean>(
      'return form.accounts.length > 0 && form.accounts.some(a=>a.login===form.draft.account.login);',
    ),
    'Account must come from the gateway inventory',
  );
  assert.equal(
    await inspect<number>('return form.shadowRoot.querySelectorAll("details[open]").length;'),
    0,
  );
  await page.click('[data-testid="pr-team-farm"]');
  await page.waitForSelector(`[data-choice-value="${farmName}"]`);
  await page.click(`[data-choice-value="${farmName}"]`);
  await page.waitForSelector('[data-testid="pr-team-add-farm"]:not(:disabled)', {
    timeoutMs: 5000,
  });
  await page.click('[data-testid="pr-team-add-farm"]');
  const result = await inspect<{ repo: string; project: string; count: number }>(
    `return {repo:form.draft.sources[0]?.repo,project:form.draft.repositories[0]?.project,count:form.draft.sources.length};`,
  );
  assert.equal(result.repo, farm.ci.repo);
  assert.equal(result.project, farmName);
  assert.equal(result.count, 1);
  const sidebarExpanded = await page.evaluate<boolean>(
    `!!document.querySelector('[title="Collapse sidebar"]')`,
  );
  for (const [width, height, label] of [
    [1280, 1000, 'desktop'],
    [390, 844, 'mobile'],
  ] as const) {
    await page.session.call('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    if (label === 'mobile' && sidebarExpanded) await page.click('[title="Collapse sidebar"]');
    await page.session.call('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: width / 2,
      y: height / 2,
      deltaY: -10000,
      deltaX: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const size = await inspect<{
      width: number;
      viewport: number;
      scroll: number;
      left: number;
      right: number;
      navRight: number;
    }>(
      `const rect=form.getBoundingClientRect();return {width:rect.width,viewport:innerWidth,scroll:document.documentElement.scrollWidth,left:rect.left,right:rect.right,navRight:document.querySelector('farm-app > nav').getBoundingClientRect().right};`,
    );
    assert(
      size.left >= size.navRight - 1 && size.right <= size.viewport + 1,
      `${label}: form is clipped (${JSON.stringify(size)})`,
    );
    assert(size.width <= size.viewport, `${label}: team form overflows (${JSON.stringify(size)})`);
    assert(size.scroll <= size.viewport, `${label}: page overflows (${JSON.stringify(size)})`);
    await writeFile(
      join(output, `${label}.png`),
      Buffer.from((await page.screenshot()) as string, 'base64'),
    );
    if (label === 'mobile') {
      await page.scroll({ selector: '[data-testid="pr-team-add-farm"]', intoView: true });
      await writeFile(
        join(output, 'mobile-sources.png'),
        Buffer.from((await page.screenshot()) as string, 'base64'),
      );
    }
  }
  if (sidebarExpanded) await page.click('[title="Expand sidebar"]');
  await page.session.call('Emulation.clearDeviceMetricsOverride');
  await page.click('[data-testid="pr-source-mode-project"]');
  await page.setInput(
    '[data-testid="pr-project-import-url"]',
    'https://github.com/orgs/owner/projects/1/views/1',
  );
  assert.equal(
    await inspect<number>(
      `return [...form.shadowRoot.querySelectorAll('input')].filter(e=>e.placeholder==='PVT_…' && e.getClientRects().length).length;`,
    ),
    0,
    'Project IDs must not be required in the default URL flow',
  );
  assert.deepEqual(
    methods.slice(callsBefore),
    [],
    'Draft source selection must not request GitHub discovery or mutate gateway state',
  );
  // Wait beyond the existing dashboard polling interval, with the editor visibly open.
  await new Promise((resolve) => setTimeout(resolve, 65000));
  assert(
    !methods.slice(callsBefore).includes('pr.list'),
    'Dashboard polling must pause while editing',
  );
  assert.deepEqual(
    methods
      .slice(callsBefore)
      .filter(
        (method) =>
          (method.startsWith('prRules.') && method !== 'prRules.list') ||
          (method.startsWith('prReview.') && method !== 'prReview.get') ||
          ['prWatch.subscribe', 'prWatch.repair', 'run.create', 'dispatch.execute'].includes(
            method,
          ),
      ),
    [],
    'Draft must not create or scan automation',
  );
  await page.click('[data-testid="pr-draft-discard"]');
  console.log(
    JSON.stringify({
      passed: true,
      farm: farmName,
      repo: farm.ci.repo,
      noDraftProviderRequests: true,
      layouts: ['desktop', 'mobile'],
    }),
  );
} finally {
  if (page) page.session.close();
  await host.session.call('Target.closeTarget', { targetId });
  host.session.close();
}
