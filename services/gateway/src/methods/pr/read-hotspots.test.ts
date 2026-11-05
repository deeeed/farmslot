import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { promisify } from 'node:util';

import { makeRun } from '../run/test-fixtures.js';

const root = mkdtempSync(path.join(tmpdir(), 'pr-read-hotspots-'));
after(() => rmSync(root, { recursive: true, force: true }));
process.env.FARMSLOT_ROOT = root;
process.env.FARMSLOT_DIR = root;
process.env.FARMSLOT_HOME = path.join(root, 'home');
mkdirSync(path.join(root, 'scripts'), { recursive: true });
mkdirSync(path.join(root, 'services/gateway'), { recursive: true });
writeFileSync(path.join(root, 'CLAUDE.md'), '# Fixture');
writeFileSync(path.join(root, 'scripts/dev.sh'), '');
writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
for (let i = 0; i < 6; i++) {
  const dir = path.join(root, 'projects', `example-${i}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'project.json'),
    JSON.stringify({
      name: `example-${i}`,
      ci: i < 3 ? { repo: `example/repo-${i}` } : undefined,
    }),
  );
}
const runs = Array.from({ length: 60 }, (_, i) =>
  makeRun({
    id: `run-${i}`,
    project: `example-${i % 6}`,
    prNumber: i + 1,
    slotId: `slot-${i % 6}`,
    status: 'monitoring',
  }),
);
const phases = { configs: 0, remotes: 0, fleet: 0 };
let configLoads = 0;
let loadingConfigs = 0;
let configStarted = 0;
let remoteReads = 0;
// Fleet collection and LLM setup are unrelated to the real project-config loader under test.
mock.module('../../llm/config.js', { namedExports: { invalidateLLMConfig() {} } });
mock.module('../../llm/auth-store.js', {
  namedExports: {
    getFarmslotStorePath: () => path.join(root, 'auth.json'),
    getOpenClawStorePath: () => path.join(root, 'other-auth.json'),
  },
});
mock.module('../../intelligence/triage/pilot-observation.js', {
  namedExports: { TriagePilotObservation: class {} },
});
mock.module('../../fleet/node-health.js', {
  namedExports: { enrichSlotHostLoad() {}, getAllMachineHealth: () => [] },
});
mock.module('../../fleet/resource-manager.js', {
  namedExports: { getActiveResources: () => [], getCachedSlotResources: () => [] },
});
mock.module('../../runs/store.js', {
  namedExports: {
    getAllRuns: () => runs,
    getRun: () => undefined,
    getRunWithArchived: async () => undefined,
  },
});
const state = await import('../../fleet/state.js');
const loadProjects = async (strict?: boolean) => {
  if (loadingConfigs++ === 0) configStarted = performance.now();
  configLoads++;
  try {
    return await state.loadProjectConfigs(strict);
  } finally {
    if (--loadingConfigs === 0) phases.configs += performance.now() - configStarted;
  }
};
mock.module('../../fleet/state.js', {
  namedExports: {
    ...state,
    loadProjectConfigs: loadProjects,
    loadProjectConfig: async (name: string, strict?: boolean) =>
      (await loadProjects(strict)).find((p) => p.name === name),
    loadFleetStatus: async () => {
      const start = performance.now();
      const fleet = { slots: [] };
      phases.fleet += performance.now() - start;
      return fleet;
    },
    loadPoolConfigs: async () => [
      {
        host: 'localhost',
        machine: 'local',
        slots: Array.from({ length: 6 }, (_, i) => ({
          id: `slot-${i}`,
          repo: `/example/repo-${i}`,
        })),
      },
    ],
  },
});
const remoteExec = Object.assign(() => assert.fail('Use promisified execFile'), {
  [promisify.custom]: async (file: string, args: string[], opts: { cwd: string }) => {
    const start = performance.now();
    assert.equal(file, 'git');
    assert.deepEqual(args, ['remote', 'get-url', 'origin']);
    remoteReads++;
    const result = { stdout: `https://github.com${opts.cwd}.git\n`, stderr: '' };
    phases.remotes += performance.now() - start;
    return result;
  },
});
mock.module('node:child_process', { namedExports: { ...childProcess, execFile: remoteExec } });
mock.module('../pr-rules.js', { namedExports: { listActiveReviewPRs: () => [] } });
mock.module('../pr-watch.js', { namedExports: { listActiveMonitoredPRs: () => [] } });
const { restoreRetainedPRRawObservations } = await import('./raw-cache.js');
restoreRetainedPRRawObservations(
  runs.map((run, i) => ({
    repo: `example/repo-${i % 6}`,
    pr: run.prNumber,
    raw: {
      checksStdout: '',
      checksAvailable: true,
      prStateStdout: `OPEN\tMERGEABLE\tCLEAN\tAPPROVED\tfeature\t\t\t\t\tPR ${i + 1}`,
      commentsStdout: '',
      reviewCommentsStdout: '',
      latestCommitStdout: '',
      reviewMetaStdout: '',
      fetchedAt: Date.now(),
    },
  })),
);
const { projectRetainedPRList } = await import('../pr.js');

test(
  'retained projection loads projects once and each slot remote once',
  { timeout: 4500 },
  async () => {
    const start = performance.now();
    const result = await projectRetainedPRList([]);
    const total = performance.now() - start;
    console.log(JSON.stringify({ totalMs: total, phasesMs: phases, configLoads, remoteReads }));
    assert.deepEqual(result.failed, []);
    assert.equal(result.prs.length, 60);
    assert.deepEqual(
      result.prs.map((row) => `${row.repo}#${row.pr}`).sort(),
      runs.map((run, i) => `example/repo-${i % 6}#${run.prNumber}`).sort(),
    );
    assert.equal(configLoads, 1);
    assert.equal(remoteReads, 3);
  },
);
