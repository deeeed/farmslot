// Restart proof on an isolated gateway + node built from this checkout: a cancel's slot cleanup
// interrupted by a gateway restart is finished by reconcile with no manual call. The run is
// cancelled for real; while the gateway is down, the slot row is put back into the fence that
// cancel raises before it finishes (busy/releasing, the previous gateway's instance and the
// cancel's run-cleanup token with its intent). After the restart, reconcile must settle it:
// `replay` on the cancelled run's replay hold, `release` on a ready slot.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FleetStatus, Run } from '../../../packages/protocol/src/index.js';
import { cleanupOnExit, poll, startReaper } from '../lib/isolated-stack.mjs';
import { startRemoteNodeStack } from '../lib/remote-node-stack.mjs';

import {
  fakeClaude,
  fakePi,
  PIPE_PROJECT,
  pipeRunParams,
  projectPacks,
  SEED,
  slotCli,
} from './fixtures.mjs';

const root = process.cwd();
const evidence = path.resolve(process.argv[2] ?? 'temp/interrupted-cancel');
await mkdir(evidence, { recursive: true });
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
    JSON.stringify({ ...receipt, cleanupErrors: errors }, null, 2),
  );
  console.log(errors.length ? `CLEANUP errors ${errors.join('; ')}` : 'CLEANUP clean');
});

function findStatusFile(dir: string): string | undefined {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === '.farm-status.json') return full;
    if (statSync(full).isDirectory() && !['node_modules', '.git', 'slots'].includes(name)) {
      const found = findStatusFile(full);
      if (found) return found;
    }
  }
  return undefined;
}

try {
  const slot = `${PIPE_PROJECT}-1`;
  const stack = await startRemoteNodeStack({
    root,
    evidence,
    machine: 'proof-node',
    slots: [slot],
    projects: (holds) => projectPacks(holds).filter((pack) => pack.name === PIPE_PROJECT),
    seeds: { [PIPE_PROJECT]: SEED },
    slotFiles: slotCli(root),
    cliSnapshots: path.join(evidence, '..', 'cli-snapshots'),
    binFiles: (holds) => ({ pi: fakePi(holds), claude: fakeClaude(holds) }),
    ownerTag: 'proof-interrupted-cancel',
    reaper,
    onCleanup: (stop) => {
      stopStack = stop;
    },
    log,
  });
  const get = async (runId: string) => (await stack.call<{ run: Run }>('run.get', { runId })).run;
  const row = async () => {
    const { fleet } = await stack.call<{ fleet: FleetStatus }>('fleet.status', {});
    const found = fleet.slots.find((candidate) => candidate.slot === slot);
    return {
      lifecycle: found?.lifecycle,
      phase: found?.phase ?? null,
      currentRunId: found?.currentRunId ?? null,
    };
  };

  const { run } = await stack.call<{ run: Run }>('run.create', pipeRunParams(slot));
  await poll(
    'dispatch done',
    async () => {
      const current = await get(run.id);
      if (['failed', 'cancelled', 'blocked'].includes(current.status))
        throw new Error(`run ended before dispatch: ${current.status} ${current.error ?? ''}`);
      return current.steps.find((step) => step.name === 'dispatch')?.status === 'done'
        ? current
        : undefined;
    },
    300_000,
  );
  await stack.call('run.cancel', {
    runId: run.id,
    reason: 'proof: cancel, then interrupt its cleanup',
  });
  await poll(
    'cancelled',
    async () => ((await get(run.id)).status === 'cancelled' ? true : undefined),
    120_000,
  );
  const afterCancel = await poll(
    'cancel settled the slot',
    async () => {
      const current = await row();
      return current.phase === 'releasing' ? undefined : current;
    },
    120_000,
  );
  await log('cancel settled', afterCancel);
  const statusFile = findStatusFile(stack.fixture);
  if (!statusFile) throw new Error('no .farm-status.json under the fixture');
  await log('status file', { statusFile });

  const cases: Array<Record<string, unknown>> = [];
  for (const intent of ['replay', 'release'] as const) {
    const token = `run-cleanup:${intent}:${randomUUID()}`;
    const { downMs } = await stack.restartGateway({
      whileDown: async () => {
        // The fence cancel raises before it finishes, left by the gateway that just stopped.
        const status = JSON.parse(readFileSync(statusFile, 'utf8')) as {
          slots: Array<Record<string, unknown>>;
        };
        const entry = status.slots.find((candidate) => candidate.slot === slot);
        if (!entry) throw new Error(`no row for ${slot}`);
        Object.assign(entry, {
          lifecycle: 'busy',
          phase: 'releasing',
          current_run_id: run.id,
          cleanup_run_id: null,
          releasing_since: new Date().toISOString(),
          release_gateway_instance: `gateway-before-restart-${intent}`,
          cleanup_release_token: token,
          held_reason: null,
        });
        writeFileSync(statusFile, JSON.stringify(status, null, 2));
      },
    });
    const interrupted = await row();
    const settled = await poll(
      `reconcile finishes the ${intent} cancel`,
      async () => {
        const current = await row();
        return current.phase === 'releasing' ? undefined : current;
      },
      180_000,
    );
    const ok =
      intent === 'replay'
        ? settled.lifecycle === 'held' &&
          settled.phase === 'occupied' &&
          settled.currentRunId === run.id
        : settled.lifecycle === 'ready' && settled.currentRunId === null;
    cases.push({ intent, downMs, afterRestart: interrupted, settled, ok });
    await log(`case ${intent}`, { interrupted, settled, ok });
  }
  receipt = {
    status: cases.every((entry) => entry.ok) ? 'pass' : 'fail',
    head: process.env.PROOF_HEAD,
    runId: run.id,
    afterCancel,
    cases,
  };
  console.log(`${receipt.status.toString().toUpperCase()} interrupted cancel ${run.id}`);
  if (receipt.status !== 'pass') process.exitCode = 1;
} catch (error) {
  receipt = { status: 'fail', error: error instanceof Error ? error.message : String(error) };
  console.log(`FAIL ${receipt.error}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
