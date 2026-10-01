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
  ['provider-preexisting', /Idempotent boot must not claim the preexisting unleased server/],
  ['cancel-failure', /early-cancel must settle to held/],
  ['cancel-ancillary', /cancel-ancillary must settle to held/],
  ['completion-failure', /complete-ancillary must settle to held/],
  ['failure-notification', /notify must settle to held/],
  ['provider-birth', /A stale sidecar must grant no provider ownership/],
  ['provider-group', /Provider shutdown must verify recorded kernel identity/],
  ['cleanup-gone', /an empty owned slot can be released/],
  ['cleanup-handoff', /Handoff cleanup remains deferred/],
  ['cleanup-pane', /Unverified live panes remain protected/],
  ['owned-provider', /Owned server must record its kernel identity/],
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
    const guardsOnly = [
      'cancel-failure',
      'cancel-ancillary',
      'completion-failure',
      'failure-notification',
      'provider-birth',
      'provider-group',
      'provider-preexisting',
    ].includes(name);
    if (
      name.startsWith('provider-') ||
      name === 'owned-provider' ||
      name.startsWith('cleanup-') ||
      ['cancel-failure', 'cancel-ancillary', 'completion-failure', 'failure-notification'].includes(
        name,
      )
    )
      args.push(guardsOnly ? '--guards-only' : '--providers-only');
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
