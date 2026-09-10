import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { GatewayClient } from '../packages/cli/src/gateway-client.js';
import { loadCheckoutEnv } from '../packages/cli/src/onboarding/env-file.js';
import {
  parseGitHubPullUrl,
  type FleetStatus,
  type PRReviewRequestResult,
  type PRTeamSaveResult,
  type PRRulesListResult,
  type Run,
} from '../packages/protocol/src/index.js';

loadCheckoutEnv(fileURLToPath(new URL('../', import.meta.url)));
const parsed = parseGitHubPullUrl(process.env.INTAKE_PR_URL);
const project = process.env.INTAKE_PROJECT;
const slotId = process.env.INTAKE_SLOT;
const login = process.env.INTAKE_GITHUB_LOGIN;
assert(
  parsed && project && slotId && login,
  'Supply PR URL, project, selected free slot and GitHub account',
);
const connection = await new GatewayClient({
  url: process.env.GW_URL ?? 'ws://127.0.0.1:7777',
  timeout: 120_000,
}).connect();
let receipt: PRReviewRequestResult | undefined;
try {
  const { fleet } = await connection.call<{ fleet: FleetStatus }>('fleet.status', {});
  const slot = fleet.slots.find((slot) => slot.slot === slotId);
  assert(
    slot &&
      slot.enabled &&
      slot.project === project &&
      slot.lifecycle === 'ready' &&
      slot.agent !== 'working' &&
      !slot.currentRunId,
    'Use an explicitly selected free enabled slot',
  );
  const saved = process.env.INTAKE_TEAM_ID
    ? (await connection.call<PRRulesListResult>('prRules.list', {})).teams.find(
        (team) => team.id === process.env.INTAKE_TEAM_ID,
      )
    : undefined;
  if (process.env.INTAKE_TEAM_ID) {
    assert(saved, 'Existing team must be accessible');
    assert.equal(saved.config.account.login, login);
    assert.equal(saved.config.execution?.slotPolicy.kind, 'exact');
    assert(
      saved.config.execution?.slotPolicy.kind === 'exact' &&
        saved.config.execution.slotPolicy.slotId === slotId,
    );
  }
  const { team } = saved
    ? { team: saved }
    : await connection.call<PRTeamSaveResult>('prRules.teamSave', {
        config: {
          name: `Integrated review validation ${randomUUID()}`,
          account: { host: 'github.com', login },
          sources: [{ kind: 'repository', repo: parsed.repo }],
          predicate: { kind: 'compare', field: 'state', operator: 'equals', value: 'open' },
          repositories: [
            {
              repo: parsed.repo,
              project,
              reviewProfile: 'integrated-validation',
              excludedLabels: [],
            },
          ],
          execution: {
            slotPolicy: { kind: 'exact', slotId },
            models: [{ runner: 'codex', model: 'gpt-6-astra', effort: 'high' }],
          },
          githubTeams: [],
          notificationPrincipalIds: [],
        },
      });
  receipt = await connection.call<PRReviewRequestResult>('prReview.submit', {
    request: {
      teamId: team.id,
      pr: { host: 'github.com', repo: parsed.repo, number: parsed.number },
      idempotencyKey: randomUUID(),
      autoStart: true,
      review: {
        sessionIntent: process.env.INTAKE_PRIOR_RUN_ID ? 'resume' : 'reset',
        scope: process.env.INTAKE_PRIOR_RUN_ID ? 'incremental' : 'full',
        validationDepth: 'static-code',
        busySession: 'wait',
      },
      source: { client: 'integrated-execution-validation', requester: 'local-artifact-review' },
    },
  });
  console.log(
    JSON.stringify({
      phase: 'submitted',
      submissionId: receipt.submission.id,
      teamId: team.id,
      slotId,
      coldSlot: !slot.dispatchable,
    }),
  );
  const deadline = Date.now() + 40 * 60_000;
  let previous = '';
  let completed = false;
  while (Date.now() < deadline) {
    receipt = await connection.call<PRReviewRequestResult>('prReview.get', {
      id: receipt.submission.id,
    });
    if (receipt.submission.error) throw new Error(receipt.submission.error);
    const runId = receipt.intent?.runId;
    let run: Run | undefined;
    if (runId) ({ run } = await connection.call<{ run: Run }>('run.get', { runId }));
    const progress = JSON.stringify({
      phase: receipt.intent?.status,
      submissionId: receipt.submission.id,
      runId,
      runStatus: run?.status,
      step: run?.steps.find((step) => step.status === 'running')?.name,
      reason: receipt.intent?.waitingReason,
    });
    if (progress !== previous) {
      console.log(progress);
      previous = progress;
    }
    if (run) {
      assert.equal(
        run.completionPolicy,
        'artifact-only',
        'Integrated validation must retain findings locally',
      );
      if (run.slotId) assert.equal(run.slotId, slotId);
      assert.equal(run.metrics.runner, 'codex');
      assert.equal(run.metrics.model, 'gpt-6-astra');
      assert.equal(run.effort, 'high');
      if (['completed', 'failed'].includes(receipt.intent?.status ?? '')) {
        assert.equal(
          receipt.intent?.status,
          'completed',
          receipt.intent?.waitingReason ?? 'Review must complete',
        );
        assert(receipt.intent.reviewedSha, 'Actual reviewed SHA must be recorded');
        assert.equal(receipt.intent.reviewedSha, run.reviewResult?.reviewSnapshot?.headSha);
        assert(run.reviewResult?.reviewMd.trim(), 'Actual review report must persist');
        if (process.env.INTAKE_PRIOR_RUN_ID) {
          assert.equal(run.repeatReviewContext?.priorRunId, process.env.INTAKE_PRIOR_RUN_ID);
          assert.equal(run.repeatReviewContext?.session?.continuity, 'resumed');
          assert(
            run.repeatReviewContext?.unresolvedFindings.length,
            'Prior findings must reach the reviewer',
          );
        }
        console.log(
          JSON.stringify({
            passed: true,
            runId,
            reviewedSha: receipt.intent.reviewedSha,
            slotId,
            coldSlotPrepared: !slot.dispatchable,
            artifactOnly: true,
          }),
        );
        completed = true;
        break;
      }
      if (['blocked', 'failed', 'cancelled'].includes(run.status))
        throw new Error(
          `Review run ${run.id} reached ${run.status}; inspect its decision before retrying`,
        );
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (!completed)
    throw new Error(
      'Integrated review remains active after the observation deadline; inspect its existing run before continuing',
    );
} finally {
  // Keep running work and evidence intact. Cancel only an unstarted validation request on failure.
  if (receipt && !receipt.intent?.runId && !receipt.submission.cancelledAt) {
    await connection.call('prReview.cancel', {
      id: receipt.submission.id,
      revision: receipt.submission.revision,
    });
  }
  connection.close();
}
