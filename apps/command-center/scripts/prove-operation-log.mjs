// Read the real disposable gateway and drive the run artifact viewer through its URL.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const output = process.env.OPERATION_LOG_PROOF_OUTPUT;
const tab = process.env.OPERATION_LOG_PROOF_TAB;
assert(output && tab, 'Select an owned connected tab and fixture output directory');
const fixture = JSON.parse(await readFile(path.join(output, 'fixture.json'), 'utf8'));
const cdpPath = fileURLToPath(new URL('./cdp.mjs', import.meta.url));
const execute = promisify(execFile);
const cdp = async (...args) =>
  JSON.parse(
    (
      await execute(process.execPath, [cdpPath, ...args], {
        timeout: 40000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout,
  );
const read = () =>
  cdp(
    'eval',
    tab,
    `
  const detail = document.querySelector('run-detail');
  const viewer = [...(detail?.shadowRoot?.querySelectorAll('media-lightbox') ?? [])].find((entry) => entry.open);
  return {
    connected: document.querySelector('farm-app')?.connection === 'connected',
    runId: detail?.run?.id,
    path: viewer?.items?.[viewer.selectedIndex]?.path,
    text: viewer?.shadowRoot?.querySelector('pre.ml-json-content')?.textContent.trim() ?? '',
    error: viewer?.shadowRoot?.querySelector('[role="status"]')?.textContent.trim() ?? '',
  };
`,
  );
const until = async (check) => {
  const deadline = Date.now() + 30000;
  let state;
  do {
    state = await read();
    if (check(state)) return state;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('Operation log view did not settle: ' + JSON.stringify(state));
};
const state = await read();
assert(state.connected && state.runId === fixture.runId, 'Use the connected fixture run');
const cases = [
  { name: 'empty', path: fixture.paths[0], status: 416, text: 'Log is empty.' },
  { name: 'populated', path: fixture.paths[1], status: 206, text: 'Recorded operation output' },
  { name: 'missing', path: fixture.paths[2], status: 404, error: 'File not found (HTTP 404)' },
];
await mkdir(path.join(output, 'browser'), { recursive: true });
for (const expected of cases) {
  const response = await cdp(
    'eval',
    tab,
    `
    const { gatewayHttpFetch } = await import('/src/utils/gateway-origin.ts');
    const url = '/api/run-artifact?runId=' + encodeURIComponent(${JSON.stringify(fixture.runId)}) + '&path=' + encodeURIComponent(${JSON.stringify(expected.path)});
    const ranged = await gatewayHttpFetch(url, { cache: 'no-store', headers: { Range: 'bytes=-65536' } });
    const result = { status: ranged.status, range: ranged.headers.get('Content-Range'), body: await ranged.text() };
    if (${JSON.stringify(expected.name)} === 'empty') {
      const full = await gatewayHttpFetch(url, { cache: 'no-store' });
      result.full = { status: full.status, body: await full.text() };
    }
    return result;
  `,
  );
  assert.equal(response.status, expected.status, JSON.stringify(response));
  if (expected.name === 'empty') {
    assert.equal(response.range, 'bytes */0');
    assert.deepEqual(response.full, { status: 200, body: '' });
  }
  if (expected.name === 'populated') assert.equal(response.body, 'Recorded operation output\n');
  const hash =
    '#run/' +
    fixture.runId +
    '?artifactRun=' +
    encodeURIComponent(fixture.runId) +
    '&artifact=' +
    encodeURIComponent(expected.path);
  await cdp(
    'eval',
    tab,
    `location.hash = ${JSON.stringify(hash)}; return { hash: location.hash };`,
  );
  const view = await until(
    (value) =>
      value.path === expected.path &&
      (expected.error
        ? value.error.includes(expected.error)
        : value.text.includes(expected.text) && !value.error),
  );
  assert(!view.text.includes('No output recorded yet.'));
  if (expected.error) assert(!view.text.includes('Log is empty.'));
  await writeFile(
    path.join(output, 'browser', expected.name + '.json'),
    JSON.stringify({ response, view }, null, 2) + '\n',
  );
  await cdp('screenshot', tab, path.join(output, 'browser', expected.name + '.png'));
}
const result = {
  status: 'pass',
  runId: fixture.runId,
  cases: cases.map(({ name }) => name),
  source:
    'Authenticated production HTTP handler and connected run-detail viewer; no injected UI state',
};
await writeFile(path.join(output, 'browser', 'proof.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
