import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output =
  process.env.FARMSLOT_COHERENCE_OUT ?? path.join(root, 'temp/native-coherence-controls');
mkdirSync(output, { recursive: true });
const controls = [
  ['provider-expiry', /Already warm provider cleanup is deferred/],
  ['provider-claims', /Deferred exclusive claim remains held/],
  ['provider-cleanup', /Shared providers stop once in dependency order/],
  ['task-path-gateway', /Upgrade.*CLI|Missing expected exception/],
  ['task-path-cli', /CLI resolves the caller task path/],
  ['crash', /0 !== 50|0\s+!==\s+50/],
  ['resume', /is not paused \(status=blocked\)/],
  ['queue', /Busy queue is disabled by the control/],
  ['adopt', /External adoption is disabled by the control/],
  ['attestation', /Native stop confirmation was not recorded/],
  ['teardown-cancel', /cancel reports skipped foreign slot teardown/],
  ['teardown-force', /force-complete reports skipped foreign slot teardown/],
  ['runtime', /pre-written task runtime must be initialized/],
  ['adapters', /custom adapter variant must execute successfully/],
];
const results = [];
// Each child owns a separate gateway, native host, pool, repo and tmux names.
// Two lanes bound resource use without sharing fixture state.
const pending = [...controls];
async function lane() {
  while (pending.length) {
    const [name, failure] = pending.shift();
    const driver =
      name === 'adapters' ? 'recipe-adapter-coherence.mjs' : 'native-run-coherence.mjs';
    const args = [
      '--import',
      'tsx',
      `scripts/runner-validation/gateway/${driver}`,
      '--negative-control',
      ...(name === 'adapters' ? [] : [name]),
    ];
    if (name === 'attestation') args.push('--legacy');
    if (name.startsWith('provider-')) args.push('--providers-only');
    let log;
    try {
      await execute(process.execPath, args, {
        cwd: root,
        env: process.env,
        maxBuffer: 8 * 1024 * 1024,
      });
      throw new Error(`Control ${name} unexpectedly passed`);
    } catch (error) {
      assert.ok(
        typeof error.code === 'number' && error.code !== 0,
        `Control ${name} must exit unsuccessfully`,
      );
      log = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    }
    writeFileSync(path.join(output, `${name}.log`), log);
    assert.ok(log.includes(`Applied control: ${name}`), `Control ${name} must load its mutation`);
    assert.match(log, failure, `Control ${name} must fail its intended claim`);
    results.push({ name, rejected: true });
    console.log(`Rejected regression: ${name}`);
  }
}
const outcomes = await Promise.allSettled([lane(), lane()]);
for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
writeFileSync(
  path.join(output, 'controls.json'),
  `${JSON.stringify({ passed: true, results }, null, 2)}\n`,
);
