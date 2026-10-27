import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { NativeSessionInfo } from '@farmslot/protocol';
import type { NativeSessionClient as Client } from '../../packages/agent-runtime/src/native/client.js';

// Manual, 60-poll process benchmark. No model, product run or production host is used.
const runtime = resolve(
  process.argv[2] ?? fileURLToPath(new URL('../../packages/agent-runtime', import.meta.url)),
);
const output = process.argv[3];
const { NativeSessionClient }: typeof import('../../packages/agent-runtime/src/native/client.js') =
  await import(pathToFileURL(join(runtime, 'dist/native/client.js')).href);
const { alive }: typeof import('../../packages/agent-runtime/src/native/storage.js') = await import(
  pathToFileURL(join(runtime, 'dist/native/storage.js')).href
);
const { socketDirectory }: typeof import('../../packages/agent-runtime/src/native/ipc.js') =
  await import(pathToFileURL(join(runtime, 'dist/native/ipc.js')).href);
const root = realpathSync(process.argv[4] ?? mkdtempSync(join(tmpdir(), 'native-poll-')));
assert(dirname(root) === realpathSync(tmpdir()) && basename(root).startsWith('native-poll-'));
const log = join(root, 'ps.log');
const bin = join(root, 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(
  join(bin, 'ps'),
  '#!/bin/sh\nprintf "%s|%s\\n" "$PPID" "$*" >> "$NATIVE_POLL_LOG"\nexec /bin/ps "$@"\n',
);
chmodSync(join(bin, 'ps'), 0o700);
const previousPath = process.env.PATH;
const previousLog = process.env.NATIVE_POLL_LOG;
process.env.PATH = `${bin}:${previousPath ?? ''}`;
process.env.NATIVE_POLL_LOG = log;
const abort = new AbortController();
const stop = () => abort.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

interface Host {
  root: string;
  client: Client;
  child: ChildProcess;
  supervisor?: number;
  supervisorIdentity?: string;
  worker?: number;
}
const hosts: Host[] = [];
const birth = (pid: number) =>
  execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
const pidFile = (file: string): number | undefined => {
  if (!existsSync(file)) return undefined;
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return typeof value === 'object' &&
    value !== null &&
    'pid' in value &&
    typeof value.pid === 'number'
    ? value.pid
    : undefined;
};
const counts = () => {
  const parents = new Set(
    hosts.flatMap((h) => [h.supervisor, h.worker]).filter((pid) => pid !== undefined),
  );
  const rows = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return rows.filter((line) => parents.has(Number(line.split('|')[0])) && /(?:^|\|)-p /.test(line));
};
interface BenchmarkResult {
  runtime: string;
  nodeVersion: string;
  sourceSha256: Record<string, string>;
  hosts: number;
  pollsPerHost: number;
  elapsedMs: number;
  startupPerPidPsCalls: number;
  steadyPerPidPsCalls: number;
  perHost: Array<{ supervisor?: number; worker?: number; calls: number }>;
  qualification: string;
}
let result: BenchmarkResult | undefined;
const errors: unknown[] = [];

try {
  for (let index = 0; index < 2; index++) {
    const state = join(root, `host-${index}`);
    for (const file of ['worker.json', join('lock', 'owner.json')]) {
      const pid = pidFile(join(state, file));
      assert(!pid || !alive(pid), 'Retained benchmark process is still active');
    }
    assert(!existsSync(join(state, 'ready.json')), 'Retained benchmark host is still ready');
    mkdirSync(join(state, 'sessions'), { recursive: true, mode: 0o700 });
    chmodSync(state, 0o700);
    const marker = `native-poll-child-${index}`;
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', marker], {
      detached: true,
      stdio: 'ignore',
    });
    assert(child.pid);
    const host: Host = { root: state, client: new NativeSessionClient(state), child };
    hosts.push(host);
    const started = birth(child.pid);
    for (const kind of ['birth', 'argv', 'prior-argv']) {
      const info: NativeSessionInfo = {
        id: kind,
        generation: `${index}-${kind}`,
        hostPid: process.pid,
        processPid: child.pid,
        processIdentity: kind === 'prior-argv' ? 'retired-marker' : marker,
        processStopped: false,
        runner: 'fixture',
        nativeSessionId: `${index}-${kind}`,
        ownerPrincipalId: 'benchmark',
        executionNodeId: 'local',
        accountContextId: 'benchmark',
        cwd: root,
        executable: process.execPath,
        version: process.version,
        mode: 'default',
        accountMode: 'native',
        state: 'failed',
        capabilities: {
          modes: ['default'],
          streaming: false,
          tools: false,
          approvals: false,
          questions: false,
          interrupt: false,
          resume: false,
        },
      };
      writeFileSync(
        join(state, 'sessions', `${kind}.journal`),
        JSON.stringify({
          info,
          context: {},
          ...(kind === 'birth'
            ? {
                processes: [
                  { pid: child.pid, parent: process.pid, group: child.pid, identity: started },
                ],
              }
            : {}),
        }) + '\n',
        { mode: 0o600 },
      );
    }
    assert.equal((await host.client.list('benchmark')).length, 3);
    host.supervisor = pidFile(join(state, 'lock', 'owner.json'));
    host.worker = pidFile(join(state, 'worker.json'));
    assert(host.supervisor && host.worker);
    host.supervisorIdentity = birth(host.supervisor);
  }
  const initial = counts().length;
  const started = performance.now();
  for (let poll = 0; poll < 60; poll++) {
    await delay(Math.max(0, started + poll * 1000 - performance.now()), undefined, {
      signal: abort.signal,
    });
    for (const host of hosts) assert.equal((await host.client.list('benchmark')).length, 3);
  }
  await delay(Math.max(0, started + 60_000 - performance.now()), undefined, {
    signal: abort.signal,
  });
  const calls = counts().slice(initial);
  result = {
    runtime,
    nodeVersion: process.version,
    sourceSha256: Object.fromEntries(
      ['storage.ts', 'manager.ts', 'client.ts', 'supervisor.ts'].map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(join(runtime, 'src/native', file)))
          .digest('hex'),
      ]),
    ),
    hosts: 2,
    pollsPerHost: 60,
    elapsedMs: performance.now() - started,
    startupPerPidPsCalls: initial,
    steadyPerPidPsCalls: calls.length,
    perHost: hosts.map((h) => ({
      supervisor: h.supervisor,
      worker: h.worker,
      calls: calls.filter(
        (line) => line.startsWith(`${h.supervisor}|`) || line.startsWith(`${h.worker}|`),
      ).length,
    })),
    qualification:
      'Two isolated real supervisors via native list IPC; only per-PID ps calls counted. Shared process-table census remains unchanged. No production-host rate claim.',
  };
} catch (error) {
  errors.push(error);
} finally {
  for (const host of hosts) {
    try {
      if (host.child.exitCode === null && host.child.signalCode === null) {
        const exited = once(host.child, 'exit');
        host.child.kill('SIGTERM');
        await exited;
      }
      const supervisor = host.supervisor ?? pidFile(join(host.root, 'lock', 'owner.json'));
      if (supervisor && alive(supervisor)) {
        const command = execFileSync('/bin/ps', ['-p', String(supervisor), '-o', 'command='], {
          encoding: 'utf8',
        });
        assert(command.split(/\s+/).includes(host.root), 'Refuse to signal a foreign supervisor');
        const identity = host.supervisorIdentity ?? birth(supervisor);
        assert.equal(birth(supervisor), identity);
        process.kill(supervisor, 'SIGTERM');
        const deadline = Date.now() + 10_000;
        const settled = () => !alive(supervisor) && (!host.worker || !alive(host.worker));
        while (!settled() && Date.now() < deadline) await delay(25);
        assert(settled(), 'Owned supervisor cleanup did not settle');
      }
      assert(!host.worker || !alive(host.worker), 'Owned worker cleanup did not settle');
      rmSync(socketDirectory(host.root), { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (previousLog === undefined) delete process.env.NATIVE_POLL_LOG;
  else process.env.NATIVE_POLL_LOG = previousLog;
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
if (errors.length) throw new AggregateError(errors, `Native benchmark failed; inspect ${root}`);
assert(result);
rmSync(root, { recursive: true, force: true });
const receipt = { ...result, ownedRoot: root, cleanupComplete: true };
if (output) writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
