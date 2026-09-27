import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getOrchestratorTaskRoot,
  resolveProjectTaskDirName,
  resolveTaskRelDir,
} from '../../../services/gateway/src/core/config.js';
import { resolveWorkerTerminalContract } from '../../../services/gateway/src/tasks/worker-terminal-contract.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = process.env.FARMSLOT_QUALITY_PROOF_DIR;
const runId = process.env.FARMSLOT_QUALITY_PROOF_RUN_ID;
const contextId = process.env.FARMSLOT_QUALITY_PROOF_CONTEXT_ID;
assert.ok(directory && runId && contextId, 'Set FARMSLOT_QUALITY_PROOF_DIR, RUN_ID and CONTEXT_ID');
assert.ok(process.argv.includes('--snapshot') || process.argv.includes('--verify'));

function rpc(method: string, params: Record<string, unknown>) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(root, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        method,
        JSON.stringify(params),
      ],
      { cwd: root, encoding: 'utf8', timeout: 40_000, maxBuffer: 8 * 1024 * 1024 },
    ),
  );
}

const { run } = rpc('run.get', { runId });
const project = JSON.parse(
  readFileSync(path.join(root, 'projects', run.project, 'project.json'), 'utf8'),
);
const taskRelative = resolveTaskRelDir(run.taskFile, getOrchestratorTaskRoot(run.project, project));
assert.ok(taskRelative);
const context = run.agentContexts.find((entry: { id: string }) => entry.id === contextId);
assert.equal(context?.slotId, run.slotId);
assert.equal(
  context?.signalFile,
  path.posix.join(resolveProjectTaskDirName(project), taskRelative, 'SIGNAL.json'),
);
const contractPath = path.posix.join(
  path.posix.dirname(context.signalFile),
  'inputs/worker-terminal-contract.json',
);
const contract = JSON.parse(rpc('fs.read', { slotId: run.slotId, path: contractPath }).content);
const localContract = JSON.parse(
  readFileSync(
    path.join(path.dirname(run.taskFile), 'inputs/worker-terminal-contract.json'),
    'utf8',
  ),
);
assert.deepEqual(contract, localContract, 'Slot and authoritative task contracts must agree');
const signalText = rpc('fs.read', { slotId: run.slotId, path: context.signalFile }).content;
const proofPath = path.join(directory, 'proof.json');

if (process.argv.includes('--snapshot')) {
  assert.ok(['monitoring', 'blocked'].includes(run.status));
  assert.ok(
    contract.whenPresent.some(
      (rule: { requireRecipeQuality?: boolean }) => rule.requireRecipeQuality,
    ),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    proofPath,
    JSON.stringify(
      {
        runId,
        contextId,
        slotId: run.slotId,
        contractPath,
        before: contract,
        signalBefore: signalText,
      },
      null,
      2,
    ),
    { mode: 0o600, flag: 'wx' },
  );
  console.log('Snapshot saved. No task or signal files changed.');
} else {
  const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
  assert.equal(proof.runId, runId);
  assert.equal(proof.contextId, contextId);
  assert.equal(proof.slotId, run.slotId);
  assert.equal(proof.contractPath, contractPath);
  const withoutQuality = (value: typeof contract) => ({
    ...value,
    whenPresent: value.whenPresent.map((rule: Record<string, unknown>) => {
      const copy = { ...rule };
      delete copy.requireRecipeQuality;
      return copy;
    }),
  });
  assert.ok(
    proof.before.whenPresent.some(
      (rule: { requireRecipeQuality?: boolean }) => rule.requireRecipeQuality,
    ),
  );
  assert.ok(
    contract.whenPresent.every(
      (rule: { requireRecipeQuality?: boolean }) => !rule.requireRecipeQuality,
    ),
  );
  assert.deepEqual(withoutQuality(contract), withoutQuality(proof.before));
  const expected = resolveWorkerTerminalContract(project.worker_terminal, run.flowType, {
    mode: contract.mode,
    now: contract.resolvedAt,
  });
  assert.ok(expected.whenPresent.every((rule) => !rule.requireRecipeQuality));
  assert.deepEqual(withoutQuality(contract), withoutQuality(expected));
  const signal = JSON.parse(signalText);
  const previous = JSON.parse(proof.signalBefore);
  assert.ok(typeof previous.attemptId === 'string' && previous.attemptId.length > 0);
  assert.equal(signal.attemptId, previous.attemptId);
  assert.ok(['complete', 'done'].includes(signal.status));
  assert.notDeepEqual(signal, previous);
  assert.equal(run.steps.find((step: { name: string }) => step.name === 'monitor')?.status, 'done');
  console.log(
    JSON.stringify({
      runId,
      workerStatus: signal.status,
      monitor: 'done',
      retainedAttempt: signal.attemptId,
      qualityFileRequired: false,
    }),
  );
}
