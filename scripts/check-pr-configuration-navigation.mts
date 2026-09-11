#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpWebPage, listCdpTargets } from '../packages/recipe-harness/src/runtime/cdp.js';
import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import type {
  ConfigGitHubAccountsResult,
  ConfigProjectsResult,
  FleetStatus,
  PRExecutionProfile,
  PRRulesListResult,
  PRTriggerRuleConfig,
} from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const url = process.env.FARMSLOT_UI_URL;
const farmName = process.env.SETUP_FARM;
assert(url && farmName, 'Set FARMSLOT_UI_URL and SETUP_FARM');
const out = process.env.SETUP_ARTIFACTS ?? '/tmp/pr-configuration-navigation';
await mkdir(out, { recursive: true });
const conn = await new GatewayClient({
  url: process.env.GW_URL ?? `ws://localhost:${process.env.GATEWAY_PORT ?? 7777}`,
  timeout: 15000,
}).connect();
const { projects } = await conn.call<ConfigProjectsResult>('config.projects');
const { fleet } = await conn.call<{ fleet: FleetStatus }>('fleet.status');
const accounts = await conn.call<ConfigGitHubAccountsResult>('config.githubAccounts', {});
const ruleTeamName = process.env.SETUP_RULE_TEAM;
const ruleTeam = ruleTeamName
  ? (await conn.call<PRRulesListResult>('prRules.list')).teams.find(
      (team) => team.config.name === ruleTeamName,
    )
  : undefined;
if (ruleTeamName) assert(ruleTeam, 'SETUP_RULE_TEAM must name an existing team');
conn.close();
const farm = projects.find((f) => f.name === farmName);
assert(farm?.ci.repo);
const slots = fleet.slots
  .filter((slot) => slot.project === farmName && slot.enabled && !slot.missingFromPool)
  .slice(0, 2);
assert.equal(slots.length, 2, 'Choose a farm with at least two configured slots');
const account = accounts.accounts.find(
  (a) => a.login === (process.env.SETUP_GITHUB_LOGIN ?? accounts.accounts[0]?.login),
);
assert(account);
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
const read = <T,>(expression: string) => page.evaluate<T>(`(()=>{${roots}${expression}})()`);
const form = `const form=roots.map(root=>root.querySelector('pr-team-form')).find(Boolean);`;
const choose = async (selector: string, value: string) => {
  await page.click(selector);
  await page.waitForSelector(`[data-choice-value="${value}"]`, { timeoutMs: 10000 });
  await page.click(`[data-choice-value="${value}"]`);
};
let sidebarExpanded = false;
try {
  await page.session.call('Page.bringToFront');
  await page.navigate(url);
  await page.waitForExpression(`document.querySelector('fleet-summary-bar')?.hydrated===true`, {
    timeoutMs: 90000,
  });
  await page.click('[data-testid="pr-workspace-automation"]');
  await page.click('[aria-label="PR automation views"] [data-testid="pr-automation-tab-rules"]');
  await page.waitForSelector('[data-testid="pr-team-rule-help"]');
  sidebarExpanded = await page.evaluate<boolean>(
    `!!document.querySelector('[title="Collapse sidebar"]')`,
  );
  if (sidebarExpanded) await page.click('[title="Collapse sidebar"]');
  for (const width of [390, 1440]) {
    await page.session.call('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const help = await read<{ text: string; fits: boolean }>(`
      const el=roots.map(root=>root.querySelector('[data-testid="pr-team-rule-help"]')).find(Boolean);
      const rect=el.getBoundingClientRect();
      return {text:el.textContent, fits:rect.width>0 && rect.left>=0 && rect.right<=innerWidth && el.scrollWidth<=el.clientWidth};
    `);
    assert(help.text.includes('Teams define which PRs.'));
    assert(help.text.includes('Rules define what happens.'));
    await writeFile(
      join(out, `team-rule-help-${width}.png`),
      Buffer.from((await page.screenshot()) as string, 'base64'),
    );
    assert(help.fits, `Team/rule explanation fits at ${width}px`);
  }
  if (sidebarExpanded) await page.click('[title="Expand sidebar"]');
  if (ruleTeam) {
    await page.click('[data-testid="pr-rule-create"]');
    await choose('[data-testid="pr-rule-team"]', ruleTeam.id);
    await page.click('[data-testid="pr-rule-action-review"]');
    await page.click('[data-testid="pr-rule-action-monitor"]');
    await page.setInput('[data-testid="pr-rule-monitor-interval"]', '120');
    await page.setInput('[data-testid="pr-rule-interval"]', '3600');
    const ruleSnapshot = () =>
      read<PRTriggerRuleConfig>(`
      const rule=roots.map(root=>root.querySelector('pr-rule-form')).find(Boolean);
      return rule.snapshotDraft().value.config;
    `);
    const draft = await ruleSnapshot();
    assert.equal(draft.pollIntervalMs, 3_600_000);
    assert.deepEqual(draft.actions, [
      { kind: 'monitor', policy: { mode: 'notify-only' }, pollIntervalMs: 7_200_000 },
    ]);
    await page.session.call('Page.reload');
    await page.waitForSelector('[data-testid="pr-rule-monitor-interval"]', { timeoutMs: 90000 });
    assert.deepEqual(await ruleSnapshot(), draft);
    await writeFile(
      join(out, 'rule-monitor-interval.png'),
      Buffer.from((await page.screenshot()) as string, 'base64'),
    );
    await page.click('[data-testid="pr-draft-discard"]');
  }
  await page.click('[data-testid="pr-team-create"]');
  await page.waitForSelector('[data-testid="pr-team-account"]:not([disabled])', {
    timeoutMs: 20000,
  });
  await choose('[data-testid="pr-team-account"]', `${account.host}/${account.login}`);
  await choose('[data-testid="pr-team-farm"]', farmName);
  await page.click('[data-testid="pr-team-add-farm"]');
  await page.click('[data-testid="pr-team-review-settings"] > summary');
  await page.click('[data-testid="pr-policy-execution-override"]');
  await page.click('[data-testid="pr-execution-choose-slots"]');
  for (const slot of slots) await page.click(`slot-choice-row[data-slot-id="${slot.slot}"]`);
  await writeFile(
    join(out, 'shared-slot-picker.png'),
    Buffer.from((await page.screenshot()) as string, 'base64'),
  );
  await page.click('[data-testid="slot-selector-done"]');
  await page.click('[data-testid="pr-model-restrictions-0"]');
  await page.click('[data-testid="pr-execution-model-slots-0"]');
  await page.click(`slot-choice-row[data-slot-id="${slots[1].slot}"]`);
  await page.click('[data-testid="slot-selector-done"]');
  const before = await read<PRExecutionProfile>(
    `${form}return form.snapshotDraft().value.config.execution;`,
  );
  assert.deepEqual(before.slotPolicy, {
    kind: 'pool',
    allowedSlots: slots.map((slot) => slot.slot),
  });
  assert.deepEqual(before.models[0].allowedSlots, [slots[0].slot]);
  const address = await page.evaluate<string>('location.href');
  const params = new URL(address).hash.split('?')[1];
  const query = new URLSearchParams(params);
  assert.equal(query.get('layout'), 'list');
  assert.equal(query.get('prTab'), 'rules');
  assert.equal(query.get('prEditor'), 'team');
  assert(query.get('prDraft'));
  assert(!address.includes(account.login));
  assert(!address.includes(slots[0].slot));
  assert(!address.includes(encodeURIComponent(farm.ci.repo)));
  await page.navigate('about:blank');
  await page.navigate(address);
  await page.waitForExpression(`document.querySelector('fleet-summary-bar')?.hydrated===true`, {
    timeoutMs: 90000,
  });
  await page.waitForSelector('[data-testid="pr-draft-notice"]', { timeoutMs: 20000 });
  assert.deepEqual(
    await read(`${form}return form.snapshotDraft().value.config.execution;`),
    before,
  );
  assert(
    await read<boolean>(
      `${form}return form.shadowRoot.querySelector('[data-testid="pr-team-review-settings"]').open;`,
    ),
  );
  assert.equal(
    await read<number>(
      `return roots.flatMap(root=>[...root.querySelectorAll('select')]).filter(el=>el.getClientRects().length).length;`,
    ),
    0,
    'No visible native selects in PR configuration',
  );
  await page.click('[data-testid="pr-automation-editor-close"]');
  assert.equal(
    new URLSearchParams((await page.evaluate<string>('location.hash')).split('?')[1]).get(
      'prEditor',
    ),
    null,
  );
  await page.evaluate('history.back()');
  await page.waitForSelector('pr-team-form', { timeoutMs: 15000 });
  assert.deepEqual(
    await read(`${form}return form.snapshotDraft().value.config.execution;`),
    before,
  );
  await page.evaluate('history.forward()');
  await page.waitForExpression(
    `!document.querySelector('pr-board')?.shadowRoot?.querySelector('pr-automation-panel')?.shadowRoot?.querySelector('pr-team-form')`,
    { timeoutMs: 15000 },
  );
  await page.evaluate('history.back()');
  await page.waitForSelector('pr-team-form', { timeoutMs: 15000 });
  sidebarExpanded = await page.evaluate<boolean>(
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
    await page.click('[data-testid="pr-execution-choose-slots"]');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const box = await read<{ left: number; right: number; width: number }>(
      `const modal=roots.map(root=>root.querySelector('slot-selector-modal')).find(Boolean)?.shadowRoot.querySelector('.modal');const rect=modal.getBoundingClientRect();return {left:rect.left,right:rect.right,width:innerWidth};`,
    );
    assert(box.left >= 0 && box.right <= box.width, `${label}: selector must fit viewport`);
    await writeFile(
      join(out, `${label}-slot-picker.png`),
      Buffer.from((await page.screenshot()) as string, 'base64'),
    );
    await page.click('[data-testid="slot-selector-done"]');
  }
  if (sidebarExpanded) await page.click('[title="Expand sidebar"]');
  sidebarExpanded = false;
  await page.session.call('Emulation.clearDeviceMetricsOverride');
  await page.click('[data-testid="pr-draft-discard"]');
  for (const invalid of ['prTarget=missing-configuration', 'prDraft=missing-private-draft']) {
    await page.evaluate(
      `location.hash = ${JSON.stringify(`#prs?layout=list&prTab=rules&prEditor=team&${invalid}`)}`,
    );
    await page.waitForExpression(`document.querySelector('fleet-summary-bar')?.hydrated===true`, {
      timeoutMs: 90000,
    });
    await page.waitForExpression(
      `!new URLSearchParams(location.hash.split('?')[1]).has('prEditor')`,
      { timeoutMs: 20000 },
    );
    assert.equal(
      await read<boolean>(`return roots.some(root=>root.querySelector('pr-team-form'));`),
      false,
    );
  }
  await page.navigate(new URL('/#dev/choice-picker', url).href);
  await page.waitForSelector('choice-picker');
  await choose('choice-picker', 'mobile');
  assert.equal(
    await read<string>(
      `return roots.map(root=>root.querySelector('choice-picker')).find(Boolean).value;`,
    ),
    'mobile',
  );
  await page.navigate(new URL('/#dev/pr-execution', url).href);
  await page.waitForSelector('[data-testid="pr-execution-choose-slots"]');
  await page.click('[data-testid="pr-execution-choose-slots"]');
  await page.waitForSelector('slot-selector-modal[open]');
  await page.click('[data-testid="slot-selector-done"]');
  const fieldValue = () =>
    read<string>(
      `return roots.map(root=>root.querySelector('[data-testid="pr-project-field-binding"]')).find(Boolean).value;`,
    );
  const optionValue = () =>
    read<string>(
      `return roots.map(root=>root.querySelector('[data-testid="pr-project-field-option"]')).find(Boolean).value;`,
    );
  assert.equal(await fieldValue(), JSON.stringify(['project-demo', 'field-status']));
  assert.equal(await optionValue(), 'review');
  await page.click('[data-testid="pr-project-field-binding"]');
  await page.click('[data-choice-label="Example Project / Status"]');
  assert.equal(
    await optionValue(),
    'review',
    'Re-selecting the same field must not clear its option',
  );
  console.log(
    JSON.stringify({
      passed: true,
      restoredDraft: true,
      history: true,
      privateUrl: true,
      sharedHarness: true,
      slots: slots.map((s) => s.slot),
    }),
  );
} finally {
  if (
    sidebarExpanded &&
    (await page.evaluate<boolean>(`!!document.querySelector('[title="Expand sidebar"]')`))
  )
    await page.click('[title="Expand sidebar"]');
  const discard = await read<boolean>(
    `return roots.some(root=>root.querySelector('[data-testid="pr-draft-discard"]'));`,
  );
  if (discard) await page.click('[data-testid="pr-draft-discard"]');
  page.close();
  await host.session.call('Target.closeTarget', { targetId });
  host.close();
}
