// Smoke on an isolated gateway + node built from this checkout: a native Claude worker on the
// node crashes, its journal loses the recorded process tree (the legacy case), and the operator
// resumes with an explicit stop confirmation. The gateway routes native.worker.confirmStopped to
// the node only when the node's declared supportsWorkerStopAttestation survived sanitisation.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Run } from '../../../packages/protocol/src/index.js';
import { alive, matchesProcess } from '../../../packages/agent-runtime/src/native/storage.ts';
import { claudeRunParams, PIPE_PROJECT, projectPacks, SEED, slotCli } from '../canary/fixtures.mjs';
import { cleanupOnExit, poll, startReaper } from '../lib/isolated-stack.mjs';
import { startRemoteNodeStack } from '../lib/remote-node-stack.mjs';

const root = process.cwd();
const evidence = path.resolve(process.argv[2] ?? 'temp/node-stop-attestation');
await mkdir(evidence, { recursive: true });
const log = async (event: string, detail?: Record<string, unknown>) => {
  await appendFile(path.join(evidence, 'smoke.jsonl'), JSON.stringify({ event, ...detail }) + '\n');
  console.log(event, detail ? JSON.stringify(detail) : '');
};
// Native stream-json peer: the first launch crashes on its first turn, later launches answer.
const fakeNativeClaude = (holds: string) => `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
if (process.argv.includes('--version')) { console.log('2.1.269'); process.exit(0); }
if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'api_key' })); process.exit(0); }
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const conversation = process.argv.includes('--resume') ? arg('--resume') : arg('--session-id');
const send = (m) => process.stdout.write(JSON.stringify({ ...m, session_id: conversation }) + '\\n');
const crashed = ${JSON.stringify(path.join(holds, 'crashed-once'))};
fs.appendFileSync(${JSON.stringify(path.join(holds, 'launches'))}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'control_request' && m.request?.subtype === 'initialize') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } });
    send({ type: 'system', subtype: 'init' });
  }
  if (m.type !== 'user') return;
  send({ type: 'user', message: m.message });
  if (!fs.existsSync(crashed)) {
    fs.writeFileSync(crashed, String(process.pid));
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300);
    return;
  }
  setTimeout(() => send({ type: 'result', subtype: 'success', is_error: false }), 100);
});
process.on('SIGTERM', () => process.exit(143));
`;

const reaper = startReaper();
let stopStack: (() => Promise<string[]>) | undefined;
let receipt: Record<string, unknown> = { status: 'fail' };
const cleanup = cleanupOnExit(async () => {
  const errors = (await stopStack?.()) ?? [];
  if (!errors.length) reaper.done();
  await writeFile(
    path.join(evidence, 'receipt.json'),
    JSON.stringify({ ...receipt, cleanupErrors: errors }, null, 2),
  );
  console.log(errors.length ? `CLEANUP errors ${errors.join('; ')}` : 'CLEANUP clean');
});

try {
  const machine = 'attest-node';
  const slotId = `${PIPE_PROJECT}-1`;
  const stack = await startRemoteNodeStack({
    root,
    evidence,
    machine,
    slots: [slotId],
    projects: (holds) => projectPacks(holds).filter((pack) => pack.name === PIPE_PROJECT),
    seeds: { [PIPE_PROJECT]: SEED },
    slotFiles: slotCli(root),
    cliSnapshots: path.join(evidence, '..', 'cli-snapshots'),
    binFiles: (holds) => ({ claude: fakeNativeClaude(holds) }),
    ownerTag: 'smoke-stop-attest',
    reaper,
    onCleanup: (stop) => {
      stopStack = stop;
    },
    log,
  });
  const nodeNative = path.join(stack.fixture, 'node-home', 'native-sessions');
  const { run: created } = await stack.call<{ run: Run }>('run.create', {
    ...claudeRunParams(slotId),
    transport: 'native',
  });
  const runId = created.id;
  await log('run created', { runId });
  const get = async () => (await stack.call<{ run: Run }>('run.get', { runId })).run;
  let run = await poll(
    'native crash recovery decision',
    async () => {
      const current = await get();
      await writeFile(path.join(evidence, 'run-latest.json'), JSON.stringify(current, null, 2));
      assert.notEqual(current.status, 'failed', current.error);
      return current.status === 'blocked' &&
        current.decisions.some(
          (d) => !d.resolvedAt && d.actions.some((a) => a.id === 'resume-native-worker'),
        )
        ? current
        : undefined;
    },
    180000,
  );
  const context = run.agentContexts?.find((item) => item.nativeSession?.acceptedAt);
  const binding = context?.nativeSession;
  assert.ok(context && binding, 'an accepted native worker binding');
  assert.equal(binding.executionNodeId, machine, 'the worker lives on the remote node');
  const target = () => ({
    sessionId: binding.sessionId,
    executionNodeId: binding.executionNodeId,
    worker: {
      runId,
      contextId: context.id,
      generation: binding.generation,
      leaseId: binding.leaseId,
    },
  });
  type Read = { session: { processStopped?: boolean; processStopReason?: string; state: string } };
  const read = () => stack.call<Read>('native.session.read', target());

  // The legacy case: the node's host restarts without the recorded process tree.
  const find = (dir: string, name: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? find(path.join(dir, entry.name), name)
            : entry.name === name
              ? [path.join(dir, entry.name)]
              : [],
        )
      : [];
  await log('crashed', { runId, sessionId: binding.sessionId, crash: (await read()).session });
  // Restart the node; while it is down, stop the worker's host and drop its recorded process tree.
  await stack.restartNode(async () => {
    // The node-side host that owns the worker: its sessions sit next to its host.json.
    const owners = find(nodeNative, 'host.json').filter((file) =>
      existsSync(path.join(path.dirname(file), 'sessions', `${binding.sessionId}.journal`)),
    );
    assert.equal(owners.length, 1, 'exactly one node host owns the worker session');
    const hostDir = path.dirname(owners[0]);
    const { pid } = JSON.parse(readFileSync(owners[0], 'utf8'));
    assert.ok(matchesProcess(pid, hostDir), 'the recorded host PID is still the fixture host');
    process.kill(pid, 'SIGTERM');
    await poll('worker host stops', async () => (alive(pid) ? undefined : true), 30000);
    await log('worker host stopped', { pid, hostDir: path.relative(stack.fixture, hostDir) });
    const [journal] = find(nodeNative, `${binding.sessionId}.journal`);
    assert.ok(journal, 'node journal for the worker session');
    const entries = readFileSync(journal, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const entry = JSON.parse(line);
        delete entry.processes;
        delete entry.processesAdded;
        if (entry.info) {
          entry.info.state = 'failed';
          entry.info.processStopped = false;
          delete entry.info.processStopReason;
        }
        return entry;
      });
    writeFileSync(journal, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  });
  await log('node restarted');
  // The restarted node starts its host on demand; until then a read reports it unavailable.
  await poll(
    'worker readable after node restart',
    async () =>
      read().then(
        () => true,
        (error: unknown) => {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'NATIVE_SOURCE_UNAVAILABLE'
          )
            return undefined;
          throw error;
        },
      ),
    60000,
  );
  const before = (await read()).session;
  assert.equal(before.processStopped, false, 'legacy cleanup is unconfirmed before attestation');
  await log('legacy state', { before });

  let resumeError: string | undefined;
  try {
    await stack.call('run.resume', { runId, confirmStopped: true });
  } catch (error) {
    resumeError = error instanceof Error ? error.message : String(error);
  }
  await log('run.resume confirmStopped', { resumeError });
  // The attestation is a journal event on the node; the resumed worker then gets a new generation.
  const [journal] = find(nodeNative, `${binding.sessionId}.journal`);
  const attested = readFileSync(journal, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => JSON.stringify(entry).includes('process-missing-attested'));
  const generation = (current: Run) =>
    current.agentContexts?.find((item) => item.id === context.id)?.nativeSession?.generation;
  if (!resumeError)
    run = await poll(
      'resumed worker monitoring on a new generation',
      async () => {
        const current = await get();
        const next = generation(current);
        return current.status === 'monitoring' && next && next !== binding.generation
          ? current
          : undefined;
      },
      60000,
    );
  else run = await get();
  await writeFile(path.join(evidence, 'run-final.json'), JSON.stringify(run, null, 2));
  receipt = {
    status: !resumeError && attested.length > 0 && run.status === 'monitoring' ? 'pass' : 'fail',
    runId,
    executionNodeId: binding.executionNodeId,
    sessionId: binding.sessionId,
    before: { processStopped: before.processStopped, state: before.state },
    resumeError,
    attested,
    generationBefore: binding.generation,
    generationAfter: generation(run),
    runStatus: run.status,
  };
  await log(receipt.status === 'pass' ? 'PASS attested stop recorded' : 'FAIL', receipt);
  if (receipt.status !== 'pass') process.exitCode = 1;
} catch (error) {
  receipt = { ...receipt, error: error instanceof Error ? error.message : String(error) };
  throw error;
} finally {
  await cleanup();
}
