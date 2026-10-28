#!/usr/bin/env node
// Read-only production-run companion to the isolated gate attestation recipe.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer as reservePort } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createServer } from 'vite';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.resolve(process.argv[2]);
const runId = process.argv[3];
assert(runId && /^[a-f0-9-]{36}$/.test(runId), 'Supply the actual run UUID');
assert(process.env.FARMSLOT_GATEWAY_PROFILE, 'Select an existing authenticated gateway profile');
await mkdir(output, { recursive: false, mode: 0o700 });
const save = (name, value) =>
  writeFile(path.join(output, name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
const target = await automationGatewayTarget();
process.env.VITE_FARMSLOT_GATEWAY_URL = target.url;
const targetHttp = new URL(target.url);
targetHttp.protocol = targetHttp.protocol === 'wss:' ? 'https:' : 'http:';
const exec = promisify(execFile);
let ui, route, failure;
const cleanup = [];
const env = { ...process.env, FARMSLOT_GATEWAY: target.url };
const cdp = async (...args) =>
  (
    await exec(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
      cwd: source,
      env,
      timeout: 90000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout;
const receiptHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receiptIds = (run) => ({
  overrides: (run.claimOverrideReceipts ?? []).map(receiptHash),
  judgments: (run.visualJudgmentReceipts ?? []).map(receiptHash),
  decisions: run.decisions.map(({ id, resolvedAt, resolvedAction, evidenceAttestation }) => ({
    id,
    resolvedAt,
    resolvedAction,
    attestation: evidenceAttestation ? receiptHash(evidenceAttestation) : null,
  })),
});
try {
  const before = JSON.parse(
    await cdp('gateway', 'run.get', JSON.stringify({ runId, view: 'snapshot' })),
  ).run;
  const decision = before.decisions.find(
    (entry) => !entry.resolvedAt && entry.payload?.kind === 'ready',
  );
  assert(decision, 'The actual run has no open publication gate');
  const criteria =
    decision.payload.acceptanceCriteria ??
    decision.payload.acceptanceStatus?.criteria.map(({ text }) => text);
  assert(criteria?.length, 'The actual gate has no registered criterion text');
  const reservation = reservePort();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  ui = await createServer({
    cacheDir: path.join(output, 'vite-cache'),
    configFile: path.join(source, 'apps/command-center/ui/vite.config.ts'),
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy: {
        '/ws': { target: targetHttp.origin, ws: true },
        '/api': { target: targetHttp.origin },
      },
    },
  });
  await ui.listen();
  const origin = `http://127.0.0.1:${ui.httpServer.address().port}`;
  env.FARMSLOT_UI_URL = origin;
  const fragment = `runs?run=${runId}`;
  const expectedUrl = `${origin}/#${fragment}&tab=evidence`;
  try {
    await cdp('goto', expectedUrl, '--new');
  } catch (error) {
    if (!error.stderr?.startsWith('CDP navigation reached ')) throw error;
    await save('cold-navigation.json', { message: error.message, stderr: error.stderr });
  }
  const owned = JSON.parse(await cdp('tabs')).filter((tab) => {
    try {
      return new URL(tab.url).origin === origin;
    } catch {
      return false;
    }
  });
  assert.equal(owned.length, 1, 'Expected exactly one tab at the owned private origin');
  route = `id:${owned[0].id}`;
  await save('owned-tab.json', { id: owned[0].id, origin, runId });
  await cdp(
    'eval',
    route,
    `const deadline=Date.now()+60000;while(document.readyState!=='complete'){if(Date.now()>deadline)throw Error('Owned document did not finish loading');await new Promise(r=>setTimeout(r,50));}return {url:location.href};`,
  );
  const login = JSON.parse(
    await cdp('eval', route, "return {required:!!document.querySelector('.auth-card')};"),
  );
  if (login.required) await save('login.json', JSON.parse(await cdp('login', route)));
  const query = async (expression) => JSON.parse(await cdp('eval', route, expression));
  const find = `const find=(r,tag)=>{const hit=r.querySelector(tag);if(hit)return hit;for(const e of r.querySelectorAll('*'))if(e.shadowRoot){const hit=find(e.shadowRoot,tag);if(hit)return hit;}};`;
  const deadline = Date.now() + 90000;
  let view;
  do {
    if (await query("return !!document.querySelector('.auth-card');")) await cdp('login', route);
    const notes = await query(
      "return !!document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('button.primary');",
    );
    if (notes) await cdp('click', route, 'whats-new-modal >>> button.primary');
    view = await query(
      `${find}const g=find(document,'ready-workspace');return {runId:g?.runId,text:g?.innerText??'',ready:!!g?._evidenceModel?.recordings.length};`,
    );
    if (view.runId === runId && criteria.every((text) => view.text.includes(text)) && view.ready)
      break;
    assert(Date.now() < deadline, 'Actual gate criterion text and recorded media did not load');
  } while (Date.now() < deadline);
  assert(view.runId === runId && criteria.every((text) => view.text.includes(text)) && view.ready);
  assert(
    !view.text.includes('No evidence files'),
    'Loaded recorded media must not be labeled empty',
  );
  await save('gate.json', { runId, criteria, sourceView: view });
  await cdp('screenshot', route, path.join(output, 'actual-gate.png'));
  const claimId =
    decision.payload.acceptanceStatus?.criteria.find(
      (row) => row.proofMode !== 'review' && row.verdict !== 'untestable',
    )?.id ?? 'AC-1';
  await cdp('click', route, `ready-workspace [data-testid=criterion-evidence-${claimId}]`);
  const header = await query(
    `${find}const r=find(document,'evidence-reviewer');return {heading:r?.shadowRoot?.querySelector('h2')?.textContent,text:r?.shadowRoot?.querySelector('[data-testid=evidence-review-criterion]')?.textContent};`,
  );
  assert(header.heading?.includes(claimId));
  assert(criteria.includes(header.text));
  await save('actual-media-header.json', { runId, claimId, ...header });
  await cdp('screenshot', route, path.join(output, 'actual-media-header.png'));
  const after = JSON.parse(
    await cdp('gateway', 'run.get', JSON.stringify({ runId, view: 'snapshot' })),
  ).run;
  assert.deepEqual(
    receiptIds(after),
    receiptIds(before),
    'Read-only proof must preserve every actual decision and receipt',
  );
  await save('result.json', {
    status: 'PASS',
    runId,
    claimId,
    criteria: criteria.length,
    before: receiptIds(before),
    after: receiptIds(after),
    explicitDeviceCommands: 0,
    explicitMutationCommands: 0,
  });
} catch (error) {
  failure = error;
  await save('failure.json', { message: error.message, stack: error.stack });
} finally {
  for (const action of [
    () => (route ? cdp('close', route) : Promise.resolve()),
    () => {
      ui?.httpServer?.closeAllConnections();
      return ui?.close();
    },
  ]) {
    try {
      await action();
    } catch (error) {
      cleanup.push(error.message);
    }
  }
  await save('cleanup.json', { status: cleanup.length ? 'FAIL' : 'PASS', errors: cleanup });
}
if (failure || cleanup.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...cleanup],
    'Actual gate text proof failed',
  );
console.log(JSON.stringify({ status: 'PASS', output, runId, readOnly: true }));
