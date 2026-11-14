// Living connected-browser + actual gateway/provider proof. Setup seeds only static review inputs.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { startPublicationProof } from './review-publication-proof-fixture.mjs';

const output = process.env.PUBLICATION_PROOF_OUT;
assert(output, 'Set PUBLICATION_PROOF_OUT to an evidence directory');
await mkdir(output, { recursive: true });
const execute = promisify(execFile);
const fixture = await startPublicationProof(output);
let ui, target;
const logs = [];
const env = {
  ...process.env,
  FARMSLOT_CDP_PORT: process.env.FARMSLOT_CDP_PORT ?? '19223',
  FARMSLOT_HOME: path.join(fixture.root, 'client'),
  FARMSLOT_GATEWAY_PROFILE: 'publication-proof',
};
const cdp = async (...args) => {
  const result = await execute(
    process.execPath,
    [path.join(fixture.source, 'apps/command-center/scripts/cdp.mjs'), ...args],
    { env, cwd: fixture.source, timeout: 40000, maxBuffer: 2 * 1024 * 1024 },
  );
  return JSON.parse(result.stdout);
};
const probe = () =>
  cdp(
    'eval',
    target,
    '--file',
    path.join(fixture.source, 'apps/command-center/scripts/probes/review-publication-error.js'),
  );
const until = async (valid, label) => {
  const deadline = Date.now() + 30000;
  let last;
  do {
    last = await probe();
    if (valid(last)) return last;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(last)}`);
};
const rows = [];
try {
  ui = spawn(
    process.execPath,
    [
      path.join(fixture.source, 'node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(fixture.uiPort),
      '--strictPort',
    ],
    {
      cwd: path.join(fixture.source, 'apps/command-center/ui'),
      env: { ...env, GATEWAY_PORT: new URL(fixture.url).port, GATEWAY_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  ui.stdout.on('data', (chunk) => logs.push(String(chunk)));
  ui.stderr.on('data', (chunk) => logs.push(String(chunk)));
  const origin = `http://127.0.0.1:${fixture.uiPort}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    assert(ui.exitCode === null, `Vite stopped: ${logs.join('')}`);
    try {
      if ((await fetch(origin)).ok) break;
    } catch (error) {
      // Connection refusal is expected only while the owned Vite process binds.
      if (error.cause?.code !== 'ECONNREFUSED') throw error;
    }
    assert(Date.now() < deadline, 'Private UI startup timed out');
    await delay(100);
  }
  const page = await cdp('goto', `${origin}/#run/${fixture.runs.saved.id}`, '--new');
  target = `@${page.id}`;
  assert.equal((await cdp('login', target)).authenticated, true);
  // Onboarding can change the route. Reopen the actual saved review after authentication.
  await cdp('goto', `${origin}/#run/${fixture.runs.saved.id}`);
  if ((await until((value) => value.connected, 'Connected proof page')).modalOpen)
    await cdp('click', target, 'whats-new-modal >>> button.primary');
  const saved = await until(
    (value) =>
      value.connected && value.readOnly && value.errorText?.includes(fixture.runs.saved.error),
    'Saved review must show its persisted publication error',
  );
  assert.equal(saved.runId, fixture.runs.saved.id);
  assert.equal(saved.role, 'alert');
  await cdp(
    'click',
    target,
    'run-detail >>> review-workspace [data-testid="review-publication-error"]',
  );
  assert.equal((await probe()).errorVisible, true);
  await cdp('screenshot', target, path.join(output, 'saved-review-error.png'));
  rows.push({ step: 'saved-error', ...(await probe()) });
  await cdp('click', target, 'run-detail >>> [data-testid="run-review-publication-retry"]');
  rows.push({
    step: 'saved-retry',
    ...(await until(
      (value) =>
        value.receipt === 'published' && value.storedError === null && value.errorText === null,
      'Successful retry clears the saved-review error',
    )),
  });
  await cdp('goto', `${origin}/#run/${fixture.runs.gate.id}`);
  const gate = await until(
    (value) =>
      value.connected &&
      value.readOnly === false &&
      value.errorText?.includes(fixture.runs.gate.error) &&
      value.postDisabled === false,
    'Review gate must show its persisted publication error with Post available',
  );
  assert.equal(gate.role, 'alert');
  assert.equal(gate.runId, fixture.runs.gate.id);
  await cdp(
    'click',
    target,
    'run-detail >>> review-workspace [data-testid="review-publication-error"]',
  );
  assert.equal((await probe()).errorVisible, true);
  await cdp('screenshot', target, path.join(output, 'gate-publication-error.png'));
  rows.push({ step: 'gate-error', ...(await probe()) });
  await cdp('click', target, 'run-detail >>> review-workspace [data-testid="review-post"]');
  await cdp('click', target, 'run-detail >>> review-workspace [data-testid="review-post"]');
  rows.push({
    step: 'fresh-post',
    ...(await until(
      (value) =>
        value.receipt === 'published' && value.storedError === null && value.errorText === null,
      'Fresh explicit Post clears the retained error and publishes once',
    )),
  });
  await cdp('screenshot', target, path.join(output, 'fresh-post-published.png'));
  const backend = await fixture.verify();
  const receipt = {
    status: 'pass',
    rows,
    backend,
    seededBoundary: fixture.seededBoundary,
    proof:
      'Real private authenticated gateway RPC, loopback provider failures and posts, real connected Command Center controls; no UI state injection',
  };
  await writeFile(path.join(output, 'proof.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally {
  try {
    if (target) await cdp('close', target);
  } finally {
    try {
      if (ui && ui.exitCode === null) {
        const closed = new Promise((resolve) => ui.once('exit', resolve));
        ui.kill('SIGTERM');
        await closed;
      }
    } finally {
      await fixture.close();
      await writeFile(path.join(output, 'vite.log'), logs.join(''));
    }
  }
}
