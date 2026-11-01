import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { RECIPE_ACTION_MANIFEST_SCHEMA_URL } from '@farmslot/protocol';
import { createRecipeRunner, createStandardCoreAdapters } from '@farmslot/recipe-runner';

/** Real recipe output shared by the regression and the manual RPC proof. */
export async function createArtifactOnlyTrial(
  taskDir: string,
  project = 'generic-project',
  proofMode: 'state' | 'review' | 'visual' = 'state',
) {
  const { createRun, getRun, updateRun } = await import('../runs/store.js');
  const { captureRunOutput } = await import('../run-completion/output.js');
  const { resolveWorkerTerminalContract } = await import('../tasks/worker-terminal-contract.js');
  const directory = path.join(taskDir, 'artifacts/recipe-runs/proof');
  // A visual claim has to rest on something a recording can show, or plan refuses it (#1706).
  // Its read is a UI read here; the other proof modes keep the shell read.
  const visual = proofMode === 'visual';
  const runner = createRecipeRunner({
    actionManifest: {
      $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
      actions: {
        command: {
          description: 'Read the value.',
          schema: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            additionalProperties: false,
          },
          examples: [{ action: 'command', cmd: 'printf observed', intent: 'Read.', next: 'check' }],
        },
        'ui.read_text': {
          description: 'Read the value on screen.',
          execution_capabilities: [],
          schema: { type: 'object', properties: {}, additionalProperties: false },
          examples: [{ action: 'ui.read_text', intent: 'Read.', next: 'check' }],
        },
        assert_output: {
          description: 'Check the value.',
          schema: {
            type: 'object',
            properties: { source: { type: 'string' }, contains: { type: 'string' } },
            additionalProperties: false,
          },
          examples: [
            {
              action: 'assert_output',
              source: 'read',
              contains: 'observed',
              intent: 'Check.',
              next: 'done',
            },
          ],
        },
        end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
      },
    },
    adapters: [
      ...createStandardCoreAdapters({ actions: ['command', 'assert_output'] }),
      // A stand-in for a UI read, supplied by the operator like the rest of this fixture.
      {
        action: 'ui.read_text',
        capabilities: [],
        source: { kind: 'operator', trust: 'trusted', name: 'artifact-only fixture' },
        execute: async () => ({ output: { stdout: 'observed' } }),
      },
    ],
    hud: false,
    defaultSource: { kind: 'operator', trust: 'trusted' },
  });
  const criterion = { id: 'AC-1', text: 'The value is observed.', proofMode };
  const execution = await runner.run({
    projectRoot: taskDir,
    artifactsDir: directory,
    // No device here: the visual claim is recorded nowhere, which is the case under test.
    ...(visual
      ? { recordVideo: false, recordingReason: 'The fixture has no device to record.' }
      : {}),
    recipeDocument: {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Comparison proof',
      description: 'Capture a passing trial without publishing it.',
      proofTargets: [{ id: criterion.id, claim: criterion.text, proofMode: criterion.proofMode }],
      workflow: {
        entry: 'read',
        nodes: {
          read: visual
            ? { action: 'ui.read_text', intent: 'Read.', next: 'check' }
            : { action: 'command', cmd: 'printf observed', intent: 'Read.', next: 'check' },
          check: {
            action: 'assert_output',
            source: 'read',
            contains: 'observed',
            ...(proofMode === 'review' ? {} : { proves: [criterion.id] }),
            intent: 'Check.',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    },
  });
  assert.equal(execution.status, 'pass');
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  await writeFile(
    path.join(taskDir, 'artifacts/latest-valid-recipe-run.json'),
    JSON.stringify({ version: 1, relativeArtifactRoot: 'recipe-runs/proof' }),
  );
  await writeFile(path.join(taskDir, 'artifacts/report.md'), '# Finished comparison trial\n');
  const run = createRun({ flowType: 'dev', project, ticketOrPr: 'TRIAL-1' });
  updateRun(run.id, {
    lane: 'comparison',
    variant: 'candidate',
    completionPolicy: 'artifact-only',
    status: 'completing',
    taskFile: path.join(taskDir, 'TASK.md'),
    ticketData: {
      source: 'manual',
      title: 'Comparison trial',
      description: 'Recorded fixture proof.',
      affectedArea: '',
      acceptanceCriteria: [criterion.text],
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
  });
  const current = getRun(run.id)!;
  await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# Comparison trial\n');
  await writeFile(
    path.join(taskDir, 'inputs/handoff.json'),
    JSON.stringify({
      attemptId: run.id,
      project,
      flow: current.flowType,
      task: { acceptanceCriteria: [criterion.text] },
    }),
  );
  const contract = resolveWorkerTerminalContract(undefined, current.flowType, {
    mode: current.mode,
  });
  await writeFile(
    path.join(taskDir, 'inputs/worker-terminal-contract.json'),
    JSON.stringify({
      ...contract,
      recordedEvidenceContractVersion: current.recordedEvidenceContractVersion,
    }),
  );
  await writeFile(
    path.join(taskDir, 'artifacts/acceptance-status.json'),
    JSON.stringify(execution.claims),
  );
  await captureRunOutput(run.id, false, true);
  return { run: getRun(run.id)!, directory };
}
