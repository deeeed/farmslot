// Live proof: one gateway, two real node processes with the same machine id and credential.
// The second is refused while the first answers (the registered pid stays put, no flapping);
// it takes over once the first is stopped (SIGSTOP: silent) and the first takes it back after
// the second is killed (SIGKILL). Isolated stack built from this checkout; no model call.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { cleanupOnExit, poll, startReaper } from '../lib/isolated-stack.mjs';
import { startRemoteNodeStack } from '../lib/remote-node-stack.mjs';
import {
  fakeClaude,
  fakePi,
  PIPE_PROJECT,
  projectPacks,
  SEED,
  slotCli,
} from '../canary/fixtures.mjs';

const root = process.cwd();
const evidence = path.resolve(process.argv[2] ?? 'temp/node-single-connection');
await mkdir(evidence, { recursive: true });
const steps: Array<Record<string, unknown>> = [];
const log = async (event: string, detail?: Record<string, unknown>) => {
  await appendFile(path.join(evidence, 'proof.jsonl'), JSON.stringify({ event, ...detail }) + '\n');
  console.log(event, detail ? JSON.stringify(detail) : '');
};
const reaper = startReaper();
let stopStack: (() => Promise<string[]>) | undefined;
let receipt: Record<string, unknown> = { status: 'fail' };
const cleanup = cleanupOnExit(async () => {
  const errors = (await stopStack?.()) ?? [];
  if (!errors.length) reaper.done();
  await writeFile(
    path.join(evidence, 'receipt.json'),
    JSON.stringify({ ...receipt, steps, cleanupErrors: errors }, null, 2),
  );
  console.log(errors.length ? `CLEANUP errors ${errors.join('; ')}` : 'CLEANUP clean');
});

const machine = 'single-node';
try {
  const slot = `${PIPE_PROJECT}-1`;
  const stack = await startRemoteNodeStack({
    root,
    evidence,
    machine,
    slots: [slot],
    projects: (holds) => projectPacks(holds).filter((pack) => pack.name === PIPE_PROJECT),
    seeds: { [PIPE_PROJECT]: SEED },
    slotFiles: slotCli(root),
    cliSnapshots: path.join(evidence, '..', 'cli-snapshots'),
    binFiles: (holds) => ({ pi: fakePi(holds), claude: fakeClaude(holds) }),
    ownerTag: 'node-single-connection',
    reaper,
    onCleanup: (stop) => {
      stopStack = stop;
    },
    log,
  });
  type Listed = {
    machine: string;
    pid: number;
    lastRefusedDuplicate?: { pid: number; at: string };
  };
  const registered = async () =>
    (await stack.call<{ nodes: Listed[] }>('nodes.list')).nodes.find(
      (node) => node.machine === machine,
    );
  const step = async (name: string, detail: Record<string, unknown>) => {
    steps.push({ name, at: new Date().toISOString(), ...detail });
    await log(name, detail);
  };
  const first = (await registered())?.pid;
  if (!first) throw new Error('the stack node did not register');
  await step('first node registered', { pid: first });

  // A second process with the same identity is refused while the first answers.
  const second = stack.startExtraNode('node-duplicate');
  const secondLog = path.join(evidence, 'node-duplicate.log');
  const refusal = await poll(
    'the duplicate to be refused',
    async () => {
      const text = await readFile(secondLog, 'utf8').catch(() => '');
      return text.split('\n').find((line) => line.includes('NODE_ALREADY_CONNECTED'));
    },
    90_000,
  );
  const afterRefusal = await registered();
  if (afterRefusal?.pid !== first) throw new Error(`registered pid moved to ${afterRefusal?.pid}`);
  if (afterRefusal.lastRefusedDuplicate?.pid !== second.pid)
    throw new Error(`lastRefusedDuplicate is ${JSON.stringify(afterRefusal.lastRefusedDuplicate)}`);
  await step('duplicate refused', {
    duplicatePid: second.pid,
    refusal,
    lastRefusedDuplicate: afterRefusal.lastRefusedDuplicate,
  });

  // No flapping: the registered pid stays the first one through a later retry of the duplicate.
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    samples.push((await registered())?.pid ?? 0);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (samples.some((pid) => pid !== first))
    throw new Error(`registered pid flapped: ${samples.join(',')}`);
  const refusals = (await readFile(secondLog, 'utf8')).split('NODE_ALREADY_CONNECTED').length - 1;
  await step('no flapping over 40 s', {
    samples: [...new Set(samples)],
    duplicateRefusals: refusals,
  });

  // A silent first node (SIGSTOP) is replaced by the duplicate on its next retry.
  process.kill(first, 'SIGSTOP');
  await step('first node stopped (SIGSTOP)', { pid: first });
  await poll(
    'the duplicate to take over',
    async () => ((await registered())?.pid === second.pid ? true : undefined),
    90_000,
  );
  await step('duplicate took over from the silent node', { pid: second.pid });

  // The first node resumes: now it is the duplicate, and it is refused.
  process.kill(first, 'SIGCONT');
  const firstLog = path.join(evidence, 'node-1.log');
  const before = (await readFile(firstLog, 'utf8')).split('NODE_ALREADY_CONNECTED').length - 1;
  await poll(
    'the resumed first node to be refused',
    async () =>
      (await readFile(firstLog, 'utf8')).split('NODE_ALREADY_CONNECTED').length - 1 > before
        ? true
        : undefined,
    90_000,
  );
  if ((await registered())?.pid !== second.pid)
    throw new Error('the resumed node took the machine back');
  await step('resumed first node refused', { pid: first, registered: second.pid });

  // The current node is killed (SIGKILL): its socket closes and the first node takes over.
  second.kill('SIGKILL');
  await step('duplicate killed (SIGKILL)', { pid: second.pid });
  await poll(
    'the first node to take over again',
    async () => ((await registered())?.pid === first ? true : undefined),
    90_000,
  );
  await step('first node took over after the kill', { pid: first });

  receipt = { status: 'pass', head: process.env.PROOF_HEAD, machine, first, duplicate: second.pid };
  console.log('PASS node single connection');
} catch (error) {
  receipt = { status: 'fail', error: error instanceof Error ? error.message : String(error) };
  console.log(`FAIL ${receipt.error}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
