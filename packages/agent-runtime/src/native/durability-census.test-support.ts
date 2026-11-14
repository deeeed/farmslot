import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { NativeSessionClient } from './client.js';
import { setup, until } from './durability.test-support.js';
import { type HostIdentity, socketDirectory } from './ipc.js';
import { alive, readJson } from './storage.js';

type SupervisorCensusMode = 'startup' | 'periodic' | 'persistent';

export function registerSupervisorCensusFailure(variant: SupervisorCensusMode) {
  const mode = variant;
  test(`supervisor ${mode} census failure stops its host and preserves cleanup truth`, async () => {
    const fixture = setup();
    const client = new NativeSessionClient(fixture.root);
    const config = join(fixture.cwd, 'census-fault.json');
    const previousOptions = process.env.NODE_OPTIONS;
    const previousFault = process.env.FARMSLOT_NATIVE_CENSUS_FAULT;
    const preload = new URL(
      '../../../../scripts/runner-validation/fixtures/native-census-fault.mjs',
      import.meta.url,
    ).href;
    process.env.NODE_OPTIONS = `${previousOptions ?? ''} --import=${preload}`.trim();
    process.env.FARMSLOT_NATIVE_CENSUS_FAULT = config;
    writeFileSync(config, JSON.stringify({ root: fixture.root, armed: mode === 'startup' }), {
      mode: 0o600,
    });
    writeFileSync(
      join(fixture.cwd, 'codex'),
      readFileSync(join(fixture.cwd, 'codex'), 'utf8').replace('},600);', '},60000);'),
    );
    let descendant: number | undefined;
    let descendantStart: string | undefined;
    try {
      if (mode === 'startup') {
        await assert.rejects(
          client.create('owner', { runner: 'codex', cwd: fixture.cwd }),
          /Native host unavailable/,
        );
        const host = readJson<HostIdentity>(join(fixture.root, 'host.json'));
        const worker = readJson<{ pid: number }>(join(fixture.root, 'worker.json'));
        assert.equal(alive(host.pid), false);
        assert.equal(alive(worker.pid), false);
        assert.equal(
          readJson<{ state: string }>(join(fixture.root, 'cleanup.json')).state,
          'complete',
        );
        const retry = await client.create('owner', { runner: 'codex', cwd: fixture.cwd });
        await client.close('owner', retry.id);
      } else {
        const session = await client.create('owner', { runner: 'codex', cwd: fixture.cwd });
        const host = readJson<HostIdentity>(join(fixture.root, 'host.json'));
        await client.send('owner', session.id, 'census', 'crash');
        await until(() => existsSync(join(fixture.cwd, 'descendant')));
        descendant = Number(readFileSync(join(fixture.cwd, 'descendant'), 'utf8'));
        descendantStart = execFileSync('ps', ['-p', String(descendant), '-o', 'lstart='], {
          encoding: 'utf8',
        }).trim();
        writeFileSync(
          config,
          JSON.stringify({ root: fixture.root, armed: false, observePid: descendant }),
        );
        await until(() => existsSync(`${config}.observed`));
        writeFileSync(
          config,
          JSON.stringify({ root: fixture.root, armed: true, persistent: mode === 'persistent' }),
        );
        await until(
          () => existsSync(`${config}.fired`) && !alive(host.pid) && !alive(session.hostPid),
        );
        await until(() => !alive(session.processPid!));
        const cleanup = readJson<{
          state: string;
          error?: string;
          observedProcesses?: Array<{ pid: number }>;
        }>(join(fixture.root, 'cleanup.json'));
        assert.equal(
          cleanup.state,
          mode === 'persistent' ? 'unknown' : 'complete',
          JSON.stringify(cleanup),
        );
        assert.match(cleanup.error ?? '', /census timeout/);
        assert.equal(existsSync(join(fixture.cwd, 'effects')), false);
        if (mode === 'persistent') {
          assert.ok(cleanup.observedProcesses?.some((entry) => entry.pid === descendant));
          await assert.rejects(client.list('owner'), /Native host unavailable/);
        } else {
          assert.equal(alive(descendant), false);
          const recovered = await client.read('owner', session.id);
          assert.equal(recovered.session.state, 'failed');
          assert.equal(recovered.session.processStopped, true);
        }
      }
    } finally {
      rmSync(config, { force: true });
      const hostFile = join(fixture.root, 'host.json');
      if (existsSync(hostFile)) {
        const host = readJson<HostIdentity>(hostFile);
        if (alive(host.pid)) {
          process.kill(host.pid, 'SIGTERM');
          await until(() => !alive(host.pid));
        }
      }
      if (descendant && alive(descendant)) {
        const ownedDescendant = descendant;
        const current = execFileSync('ps', ['-p', String(ownedDescendant), '-o', 'lstart='], {
          encoding: 'utf8',
        }).trim();
        assert.equal(current, descendantStart, 'Fixture descendant PID was reused');
        process.kill(ownedDescendant, 'SIGKILL');
        await until(() => !alive(ownedDescendant));
      }
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousOptions;
      if (previousFault === undefined) delete process.env.FARMSLOT_NATIVE_CENSUS_FAULT;
      else process.env.FARMSLOT_NATIVE_CENSUS_FAULT = previousFault;
      rmSync(socketDirectory(fixture.root), { recursive: true, force: true });
      fixture.restore();
    }
  });
}
