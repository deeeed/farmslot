import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, rename, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const [port, route, heartbeat, release] = process.argv.slice(2);
assert(port && route && heartbeat && release);
const cdp = fileURLToPath(new URL('../../../apps/command-center/scripts/cdp.mjs', import.meta.url));
async function evaluate(code) {
  const result = await exec(process.execPath, [cdp, 'eval', route, code], {
    env: { ...process.env, FARMSLOT_CDP_PORT: port },
    timeout: 15_000,
  });
  return JSON.parse(result.stdout);
}
assert.equal(await evaluate("return Number(document.querySelector('#count').textContent);"), 0);
await evaluate("document.querySelector('#increment').click(); return true;");
const startedAt = new Date().toISOString();
let observations = 0;
for (;;) {
  const counter = await evaluate("return Number(document.querySelector('#count').textContent);");
  assert.equal(counter, 1, 'The runtime must retain its observed state');
  await writeFile(
    heartbeat + '.tmp',
    JSON.stringify({
      pid: process.pid,
      startedAt,
      observedAt: new Date().toISOString(),
      observations: ++observations,
      counter,
    }),
  );
  await rename(heartbeat + '.tmp', heartbeat);
  try {
    await access(release);
    break;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await delay(1000);
}
console.log(JSON.stringify({ passed: true, startedAt, observations, counter: 1 }));
