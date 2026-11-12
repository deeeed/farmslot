// Real task production takes more than five seconds; run outside the default suite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_DEV_INTERACTIVE_PROFILE,
  type WorkerTerminalContractDocument,
} from '@farmslot/protocol';
import { invalidateProjectVarsCache } from '@farmslot/slot-config';

import { makeRun } from '../methods/run/test-fixtures.js';
import { farmslotRoot } from '../projects/repo-root.js';

import { writeTaskFixture } from './writer.test-support.js';

process.env.FARMSLOT_DEMO_POOL = '1';

test('blind task freezes its replay base into the initial local check', async (t) => {
  const project = `writer-ci-base-${process.pid}-farm`;
  const pack = path.join(farmslotRoot(), 'projects', project);
  const taskPaths: string[] = [];
  t.after(async () => {
    invalidateProjectVarsCache(project);
    for (const file of taskPaths) await rm(path.dirname(file), { recursive: true, force: true });
    await rm(pack, { recursive: true, force: true });
  });
  await cp(path.join(farmslotRoot(), 'projects/farmslot-farm'), pack, { recursive: true });
  const configFile = path.join(pack, 'project.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  config.name = project;
  config.execution_templates ??= { sources: [] };
  config.ci = { ...config.ci, local_check: 'printf "%s" "$FARMSLOT_CI_BASE_REF"' };
  await writeFile(configFile, JSON.stringify(config));
  for (const blind of [true, false]) {
    const run = makeRun({
      id: `ci-base-${blind}`,
      project,
      slotId: 'demo-ff-1',
      flowType: 'dev',
      ticketData: {
        source: 'manual',
        title: 'CI base proof',
        description: 'Check the frozen base.',
        acceptanceCriteria: [],
        affectedArea: '',
        stepsToReproduce: [],
        screenshots: [],
        labels: [],
      },
    });
    run.devInteractiveProfile = DEFAULT_DEV_INTERACTIVE_PROFILE;
    run.engineState = {
      interactiveDev: { checklist: ['Changed-file CI [DETERMINISTIC: ci.local_check]'] },
      ...(blind
        ? {
            evalExperiment: {
              experimentId: 'e',
              experimentKey: 'k',
              experimentManifestPath: '/private/experiment.json',
              packagePath: '/private/result.json',
              candidateStrategyFingerprint: 'f',
              trialId: 't',
              blind: {
                version: 1,
                baseSha: 'a'.repeat(40),
                problemDigest: 'problem',
                referenceCommits: ['b'.repeat(40)],
                referencePatchId: 'reference',
                forbiddenInputs: [],
              },
            },
          }
        : {}),
    };
    const taskPath = await writeTaskFixture(run, { skipCollisionCheck: true });
    taskPaths.push(taskPath);
    const contract: WorkerTerminalContractDocument = JSON.parse(
      await readFile(
        path.join(path.dirname(taskPath), 'inputs/worker-terminal-contract.json'),
        'utf8',
      ),
    );
    const check = contract.deterministicChecks?.find(
      (entry) => entry.reference === 'ci.local_check',
    );
    assert.ok(check);
    assert.equal(
      check.command,
      blind
        ? `export FARMSLOT_CI_BASE_REF='${'a'.repeat(40)}'\n${config.ci.local_check}`
        : config.ci.local_check,
    );
    const output = execFileSync('bash', ['-c', check.command], {
      env: { ...process.env, FARMSLOT_CI_BASE_REF: 'inherited' },
      encoding: 'utf8',
    });
    assert.equal(output, blind ? 'a'.repeat(40) : 'inherited');
  }
});
