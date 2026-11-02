import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const phase = process.argv[2];
assert(['warm', 'cold'].includes(phase));
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
const endpoint = process.env.FARMSLOT_CDP_ENDPOINT;
const modulePath = process.env.FARMSLOT_PROOF_BROWSER_MODULE;
const targetUrl = process.env.FARMSLOT_OFFLINE_ROUTE_WEB_URL;
const output = process.env.FARMSLOT_OFFLINE_ROUTE_OUT;
assert(endpoint && modulePath && targetUrl && output);
assert(['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname));
assert(['127.0.0.1', 'localhost'].includes(new URL(targetUrl).hostname));
const cases = JSON.parse(await fs.readFile(new URL('./offline-route-cases.json', import.meta.url), 'utf8'));
await fs.mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.connectOverCDP(endpoint);
const results = [];
const errors = [];
const poll = async (read, accept, label) => {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    assert(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
try {
  const page = browser.contexts().flatMap((context) => context.pages())
    .find((entry) => entry.url().startsWith(new URL(targetUrl).origin));
  assert(page, 'Use the existing owned CC dev-harness browser');
  page.on('pageerror', (error) => errors.push(error.message.replace(/((?:token|password)=)[^&\s]+/gi, '$1[redacted]').slice(0, 500)));
  await page.goto(new URL('#runs', targetUrl).href, { waitUntil: 'domcontentloaded' });
  const bootstrap = await poll(() => page.evaluate(async () => {
    const { getState } = await import('/src/state.ts');
    const { gateway } = await import('/src/gateway-client.ts');
    const state = getState();
    return { connection: gateway.connectionState, fleet: Boolean(state.fleet), runs: state.runs.length };
  }), (state) => state.fleet && state.runs > 0 && (phase === 'cold' || state.connection === 'connected'), 'stored core data');
  let subjects;
  const subjectFile = path.join(output, '..', 'subjects.json');
  if (phase === 'warm') {
    subjects = await page.evaluate(async (requestedRun) => {
      const { gateway } = await import('/src/gateway-client.ts');
      const methods = ['run.list', 'fleet.status', 'decision.list', 'backlog.list', 'roadmap.list'];
      const args = [{ limit: 1000, sort: 'newest' }, {}, {}, { includeArchived: true }, { includeArchived: true }];
      const replies = await Promise.allSettled(methods.map((method, index) => gateway.request(method, args[index])));
      const value = (index) => replies[index].status === 'fulfilled' ? replies[index].value : undefined;
      const runs = value(0)?.runs ?? [];
      const run = runs.find((entry) => entry.id === requestedRun) ?? runs.find((entry) => entry.status === 'done') ?? runs[0];
      const active = runs.find((entry) => !['done', 'cancelled', 'failed'].includes(entry.status));
      const decisions = value(2)?.decisions ?? [];
      const gate = decisions.find((entry) => entry.type === 'engine_human_gate' && entry.runMeta?.runId && entry.payload?.kind === 'ready') ?? decisions[0];
      return {
        runId: run?.id, otherRunId: runs.find((entry) => entry.id !== run?.id)?.id,
        activeRunId: active?.id, slotId: active?.slotId ?? value(1)?.fleet?.slots?.[0]?.slot,
        familyId: run?.familyId, decisionId: gate?.id, gateRunId: gate?.runMeta?.runId,
        backlogId: value(3)?.items?.[0]?.id, roadmapId: value(4)?.items?.[0]?.id,
        readFailures: methods.filter((_method, index) => replies[index].status === 'rejected'),
      };
    }, process.env.FARMSLOT_PROOF_RUN_ID ?? '');
    await fs.writeFile(subjectFile, JSON.stringify(subjects, null, 2));
  } else subjects = JSON.parse(await fs.readFile(subjectFile, 'utf8'));
  for (const entry of cases.commandCenter) {
    if (['connection', 'development'].includes(entry.kind)) {
      results.push({ route: entry.route, classification: entry.kind, result: 'NAMED EXCEPTION' });
      continue;
    }
    const missing = [...entry.href.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).filter((name) => !subjects[name]);
    assert.equal(missing.length, 0, `${entry.route} needs an existing subject: ${missing.join(', ')}`);
    const href = entry.href.replace(/\{([^}]+)\}/g, (_match, name) => encodeURIComponent(subjects[name]));
    await page.goto(new URL(href, targetUrl).href, { waitUntil: 'domcontentloaded' });
    const notes = page.locator('whats-new-modal button.primary');
    if (await notes.isVisible()) await notes.click();
    let tag = entry.tag;
    if (entry.kind === 'alpha') tag = `${tag}:visible, fleet-canvas:visible`;
    const host = page.locator(tag).first();
    await host.waitFor({ state: 'visible', timeout: 60_000 });
    const snapshot = await poll(() => host.evaluate(async (element, route) => {
      const visible = (node) => {
        const style = getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' && node.getBoundingClientRect().height > 0;
      };
      const read = (node) => {
        if (node instanceof Element && !visible(node)) return '';
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
        return [...(node.shadowRoot?.childNodes ?? node.childNodes)].map(read).join(' ');
      };
      const queries = [];
      const seen = new Set();
      const inspect = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || seen.has(value) || depth > 2) return;
        seen.add(value);
        if (typeof value.setQuery === 'function' && value.state) {
          queries.push({ status: value.state.status, hasData: value.state.data !== undefined });
          return;
        }
        if (Array.isArray(value) || value instanceof Node) return;
        for (const nested of Object.values(value)) inspect(nested, depth + 1);
      };
      const inspectHost = (node) => {
        for (const value of Object.values(node)) inspect(value);
        for (const child of node.shadowRoot?.querySelectorAll('*') ?? []) inspectHost(child);
      };
      inspectHost(element);
      const { getState } = await import('/src/state.ts');
      const state = getState();
      const globalData = {
        fleet: state.fleetObservation?.data !== undefined,
        runs: state.runsObservation?.data !== undefined,
        prs: state.prsObservation?.data !== undefined,
        run: Boolean(element.run?.id),
        slot: Boolean(element._slot?.slot),
      };
      return {
        text: read(element).replace(/\s+/g, ' ').trim().slice(0, 1400),
        tag: element.tagName.toLowerCase(), queries,
        hasData: Boolean(globalData[route] || queries.some((query) => query.hasData) ||
          (element.tagName.toLowerCase() === 'fleet-canvas' && globalData.fleet)),
      };
    }, entry.route), (value) => value.text.length > 0 && !/^Loading(?:\s|\.)/.test(value.text) &&
      (entry.kind !== 'cached' || value.hasData), `${entry.route} rendered stored body`);
    const shot = `${String(results.length).padStart(2, '0')}-${entry.route}.png`;
    await page.screenshot({ path: path.join(output, shot) });
    results.push({ route: entry.route, href, kind: entry.kind, snapshot, screenshot: shot, result: 'RENDERED' });
  }
  assert.deepEqual(errors, [], 'No uncaught browser error while rendering stored routes');
  console.log(JSON.stringify({ phase, result: 'PASS', routes: results.length, bootstrap }));
} finally {
  await fs.writeFile(path.join(output, 'route-results.json'), JSON.stringify({ phase, results, errors }, null, 2));
  await browser.close();
}
