// Opt-in RPC proof of a gateway booting behind an earlier retirement claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Methods, type PRRulesListResult, type Run } from '@farmslot/protocol';

import { createNativeProofFixture } from '../runtime/native-proof-fixture.live-support.js';

test('deferred source startup keeps the gateway reachable and resumes reads after settlement', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/review-startup-proof-'));
  for (const dir of ['scripts', 'services/gateway', 'pool', 'projects'])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Isolated startup proof\n');
  fs.writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(root, 'services/gateway/package.json'), '{}');
  fs.writeFileSync(
    path.join(root, 'status.json'),
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      slots: [],
      summary: {
        total: 0,
        ready: 0,
        busy: 0,
        held: 0,
        manual: 0,
        disabled: 0,
        blocked: 0,
        warmCount: 0,
      },
    }),
  );
  process.env.FARMSLOT_HOME = path.join(root, 'auth');
  process.env.FARMSLOT_TEST_STATUS_FILE = path.join(root, 'status.json');
  const fixture = await createNativeProofFixture(t, root);
  const { createGatewayAuthRuntime } = await import('../security/auth.js');
  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'auth') });
  const { initServerGlobals, resetServerGlobalsForTests } = await import('../server.js');
  initServerGlobals();
  t.after(() => resetServerGlobalsForTests());
  const { noteReviewWorkspaceRetirement } = await import('../review-workspaces/storage-use.js');
  const { initPRRules, initPRRuleDispatch } = await import('../methods/pr-rules.js');
  const { PRMonitorStore } = await import('../pr-monitoring/store.js');
  const { PRMonitoringService } = await import('../pr-monitoring/service.js');
  const pr = { host: 'github.com', repo: 'example/fixture', number: 42 };
  const stamp = new Date().toISOString();
  // Setup-time restart snapshot: the earlier durable claim makes this replacement unadmitted.
  const retired: Pick<Run, 'id' | 'ticketOrPr' | 'reviewWorkspace'> = {
    id: 'startup-claim',
    ticketOrPr: 'example/fixture#42',
    reviewWorkspace: {
      workspaceId: 'workspace',
      machine: 'local',
      executionNodeId: 'local',
      checkoutPath: path.join(root, 'owned/source'),
      taskPath: path.join(root, 'owned/task'),
      artifactPath: path.join(root, 'owned/task/artifacts'),
      retirement: { id: 'prior-retirement', startedAt: stamp, pr },
    },
  };
  noteReviewWorkspaceRetirement(retired, true);
  fs.writeFileSync(
    path.join(root, '.pr-rules.json'),
    JSON.stringify({
      version: 1,
      teams: [],
      rules: [],
      intents: [
        {
          id: 'waiting-review',
          pr,
          headSha: 'a'.repeat(40),
          reviewProfile: 'standard',
          status: 'queued',
          contributions: [],
          createdAt: stamp,
          updatedAt: stamp,
        },
      ],
    }),
  );
  const monitors = new PRMonitoringService(
    await PRMonitorStore.load(path.join(root, 'monitors.json')),
    () => true,
    () => {},
  );
  const rules = await initPRRules(auth, () => {}, true, monitors);
  try {
    initPRRuleDispatch(auth, () => {}, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(fixture.client.call(Methods.PR_RULES_LIST, {}), /cleanup/);
    const runs = await fixture.client.call<{ runs: Run[] }>(Methods.RUN_LIST, {});
    assert.deepEqual(runs.runs, []);
    initPRRuleDispatch(auth, () => {}, false);
    rules.stop();
    noteReviewWorkspaceRetirement(
      {
        ...retired,
        reviewWorkspace: { ...retired.reviewWorkspace!, cleanedAt: new Date().toISOString() },
      },
      true,
    );
    await rules.store.reloadFromFile();
    const ready = await fixture.client.call<PRRulesListResult>(Methods.PR_RULES_LIST, {});
    assert(Array.isArray(ready.teams));
  } finally {
    initPRRuleDispatch(auth, () => {}, false);
    rules.stop();
    noteReviewWorkspaceRetirement(
      {
        ...retired,
        reviewWorkspace: { ...retired.reviewWorkspace!, cleanedAt: new Date().toISOString() },
      },
      true,
    );
    try {
      await rules.store.reloadFromFile();
    } finally {
      resetServerGlobalsForTests();
    }
  }
});
