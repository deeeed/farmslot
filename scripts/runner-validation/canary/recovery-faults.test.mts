import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { requireRecoveryFaultSupport } from './recovery-prerequisites.mjs';

const faults = fileURLToPath(new URL('./recovery-faults.mjs', import.meta.url));
const tsx = import.meta.resolve('tsx');

test('recovery faults survive the real TypeScript loader chain in either import order', async (t) => {
  let refusal: string | undefined;
  try {
    requireRecoveryFaultSupport();
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^Recovery matrix requires Node /);
    refusal = error.message;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'recovery-loader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await mkdir(path.join(root, 'holds'));
  await writeFile(path.join(root, 'holds/recovery-fixture'), 'isolated');
  const reviewer = path.join(root, 'services/gateway/src/review/native-review-agent.ts');
  const rpc = path.join(root, 'services/gateway/src/fleet/node-rpc.ts');
  const commonjs = path.join(root, 'ordinary.cjs');
  await writeFile(commonjs, 'module.exports = { untouched: true };');
  await mkdir(path.dirname(reviewer), { recursive: true });
  await mkdir(path.dirname(rpc), { recursive: true });
  await writeFile(
    reviewer,
    `export function timing(run: { project: string; recoveryAttempts?: { stepName: string }[] }, configuredInactivityMinutes?: number) {
      const inactivityTimeoutMs = (configuredInactivityMinutes ?? 10) * 60_000;
      return inactivityTimeoutMs;
    }`,
  );
  await writeFile(
    rpc,
    `const DEFAULT_STREAMING_TIMEOUT_MS = 30000;
    class NodeRpcTimeoutError extends Error {
      constructor(machine: string, timeout: number, suffix: string) { super(machine + ':' + timeout + suffix); }
    }
    export function request(node: any, method: string, params: unknown, opts?: { timeout: number }) {
      const id = 'fixture';
      const suffix = '';
      const effectiveTimeout = opts?.timeout ?? DEFAULT_STREAMING_TIMEOUT_MS;
      const error = new NodeRpcTimeoutError(node.machine, effectiveTimeout, suffix);
      node.ws.send(JSON.stringify({ type: 'req', id, method, params }), (error) => {
        if (error) throw error;
      });
      return { effectiveTimeout, error };
    }`,
  );
  const probe = `
    import assert from 'node:assert/strict';
    import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const { timing } = await import(${JSON.stringify(pathToFileURL(reviewer).href)});
    assert.equal(timing({ project: 'ordinary' }), 600000);
    assert.equal(timing({ project: 'ordinary' }, 5), 300000);
    assert.equal(timing({ project: 'recovery-silent-reviewer' }, 0.5), 500);
    assert.equal(timing({ project: 'recovery-silent-reviewer', recoveryAttempts: [{ stepName: 'review' }] }, 0.5), 30000);
    const { request } = await import(${JSON.stringify(pathToFileURL(rpc).href)});
    const arm = ${JSON.stringify(path.join(root, 'holds/node-timeout'))};
    let sent = 0;
    const node = { machine: 'fixture', ws: { send: () => sent++ } };
    writeFileSync(arm, 'armed');
    assert.equal(request(node, 'exec', { command: 'ordinary' }).effectiveTimeout, 30000);
    assert.equal(sent, 1);
    request(node, 'exec', { command: 'recovery-node-timeout-1 rev-parse HEAD' });
    assert.equal(sent, 1);
    assert.equal(existsSync(arm), false);
    assert.equal(JSON.parse(readFileSync(arm + '.request.json')).method, 'exec');
    assert.match(JSON.parse(readFileSync(arm + '.timeout.json')).message, /fixture:20/);
    assert.equal(request(node, 'exec', { command: 'ordinary' }, { timeout: 50 }).effectiveTimeout, 50);
    assert.equal(sent, 2);
    // The gateway also imports CommonJS while the synchronous hook is active.
    assert.deepEqual((await import(${JSON.stringify(pathToFileURL(commonjs).href)})).default, { untouched: true });
    const checkpoints = [
      [${JSON.stringify(reviewer)}, 'Reviewer watchdog'],
      [${JSON.stringify(rpc)}, 'Transport timeout'],
    ];
    for (const [index, [original, message]] of checkpoints.entries()) {
      const broken = path.join(${JSON.stringify(root)}, 'missing-' + index, path.relative(${JSON.stringify(root)}, original));
      mkdirSync(path.dirname(broken), { recursive: true });
      // Valid TypeScript with different whitespace must fail checkpoint matching.
      writeFileSync(broken, readFileSync(original, 'utf8').replaceAll(' = ', '  = ').replaceAll(', ', ',  '));
      await assert.rejects(import(pathToFileURL(broken).href), new RegExp(message + ' checkpoint must apply'));
    }
  `;
  for (const faultFirst of [true, false]) {
    await t.test(
      faultFirst
        ? 'fault preload before tsx, as in the isolated gateway'
        : 'tsx before fault preload',
      () => {
        const result = spawnSync(
          process.execPath,
          ['--import', faultFirst ? tsx : faults, '--input-type=module', '-e', probe],
          {
            encoding: 'utf8',
            timeout: 2000,
            env: {
              ...process.env,
              NODE_OPTIONS: `--import ${JSON.stringify(faultFirst ? faults : tsx)}`,
              FARMSLOT_ROOT: root,
            },
          },
        );
        assert.equal(result.error, undefined);
        if (refusal) {
          assert.equal(result.status, 1, result.stderr);
          assert.ok(result.stderr.includes(refusal), result.stderr);
          assert.equal(result.stdout, '');
          assert.doesNotMatch(result.stderr, /ERR_INVALID_RETURN_PROPERTY_VALUE|AssertionError/);
        } else {
          assert.equal(result.status, 0, result.stderr);
        }
      },
    );
  }
});
