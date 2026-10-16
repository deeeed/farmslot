// Manual Send back proof: private gateway, disposable checkout and a real retained native worker.
// No shared gateway, slot, farm run, publication or credential is touched.
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CredentialStoreRuntime } from '@farmslot/credential-store';
import { isRecord } from '@farmslot/protocol';
import type {
  NativeSessionReadResult,
  ReadyGatePayload,
  Run,
  RunDecision,
  RunRecipeRunsForRunResult,
} from '@farmslot/protocol';

import { GatewayClient } from '../../../packages/cli/src/gateway-client.js';
import { matchesProcess } from '../../../packages/agent-runtime/src/native/storage.js';
import { RUNNER_OBSERVABILITY_SUPPORT_PATHS } from '../../../services/gateway/src/runners/runner-observability.js';
import { createGatewayAuthRuntime } from '../../../services/gateway/src/security/auth.js';
import { testGatewayIdentity } from '../../lib/test-gateway-identity-source.mts';
import { writeNativeFixtureTask } from '../lib/native-task.mjs';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = path.join(source, 'scripts/runner-validation/fixtures/visual-repair');
// Hosted task init compares real paths; macOS temp directories are symlinked.
const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), 'visual-repair-')));
const root = path.join(temporary, 'root');
const repo = path.join(root, 'checkout');
const origin = path.join(temporary, 'origin.git');
const nativeRoot = path.join(temporary, 'native');
const home = path.join(temporary, 'home');
const project = 'visual-repair-proof';
const slotId = `visual-repair-${Date.now()}`;
const runner = process.env.FARMSLOT_VISUAL_REPAIR_RUNNER ?? 'claude';
const out = path.resolve(process.env.FARMSLOT_VISUAL_REPAIR_OUT ?? 'temp/visual-repair-proof');
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const checks: string[] = [];
const cleanupErrors: unknown[] = [];
let failure: unknown;
let gateway: ChildProcess | undefined;
let client: GatewayClient | undefined;
let reviewer: GatewayClient | undefined;
let runId: string | undefined;
let env: NodeJS.ProcessEnv;
let logs = '';

// The native owner creates and steers the run; a person judges the evidence.
const call = <T,>(method: string, params: unknown): Promise<T> => client!.call<T>(method, params);
const judge = <T,>(method: string, params: unknown): Promise<T> =>
  reviewer!.call<T>(method, params);
const readRun = async () => (await call<{ run: Run }>('run.get', { runId })).run;
async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeout: number,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < deadline) {
    assert.ok(!gateway || gateway.exitCode === null, logs.slice(-4000));
    last = await read();
    if (isRecord(last) && 'steps' in last) {
      const run = last as unknown as Run;
      writeJson(path.join(out, 'progress.json'), {
        label,
        status: run.status,
        steps: run.steps.map((step) => `${step.name}:${step.status}:${step.detail ?? ''}`),
        decisions: run.decisions.map(
          (d) => `${d.type}:${d.title}:${d.resolvedAction ?? 'pending'}`,
        ),
        contexts: (run.agentContexts ?? []).map((c) => `${c.role}:${c.status}`),
        repairs: run.engineState?.publishGate?.visualRepairs ?? [],
      });
    }
    if (predicate(last)) return last;
    await pause(1000);
  }
  writeJson(path.join(out, `timeout-${label.replace(/\W+/gu, '-')}.json`), last);
  throw new Error(`Timed out: ${label}`);
}
async function port() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, pause(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}
const pendingGate = (run: Run): RunDecision | undefined =>
  [...run.decisions]
    .reverse()
    .find((decision) => !decision.resolvedAt && decision.payload?.kind === 'ready');
const gatePackage = (decision: RunDecision) => (decision.payload as ReadyGatePayload).prPackage!;
const failedRun = (run: Run) =>
  assert.ok(!['failed', 'cancelled'].includes(run.status), `${run.status}: ${run.error ?? ''}`);

try {
  mkdirSync(out, { recursive: true });
  mkdirSync(root);
  mkdirSync(repo);
  symlinkSync(path.join(source, 'packages'), path.join(root, 'packages'), 'dir');
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
  // Hosted task initialization resolves this checkout's CLI from the fixture root.
  symlinkSync(path.join(source, 'scripts/lib'), path.join(root, 'scripts/lib'), 'dir');
  for (const relative of RUNNER_OBSERVABILITY_SUPPORT_PATHS) {
    if (relative.startsWith('packages/') || relative.startsWith('scripts/lib/')) continue;
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(path.join(source, relative), target);
  }
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable Send back proof\n');
  writeJson(path.join(root, 'services/gateway/package.json'), {
    name: 'fixture',
    version: '0.0.0',
  });
  execFileSync('git', ['init', '-q', '-b', 'fixture-root'], { cwd: root });

  // A checkout whose branch ships a canvas that renders the square in an off-brand green.
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (message: string) =>
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      message,
    );
  execFileSync('git', ['init', '-q', '--bare', origin]);
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'README.md'), '# Proof canvas\n');
  mkdirSync(path.join(repo, 'app'));
  // The shared theme predates the branch. Its "green" is a dark off-brand green that
  // satisfies the criterion text; only the person knows the brand colour.
  writeFileSync(path.join(repo, 'app/theme.json'), '{ "blue": "#1e5adc", "green": "#1e6432" }\n');
  git('add', 'README.md', 'app');
  commit('chore: create proof canvas checkout');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  git('checkout', '-q', '-b', 'visual-repair-proof');
  writeFileSync(path.join(repo, 'app/state.json'), '{ "header": "blue", "square": "green" }\n');
  mkdirSync(path.join(repo, 'proof'));
  copyFileSync(path.join(fixture, 'recipe.json'), path.join(repo, 'proof/recipe.json'));
  git('add', 'app', 'proof');
  commit('feat: add the proof canvas');
  git('push', '-q', '-u', 'origin', 'visual-repair-proof');
  writeFileSync(path.join(repo, '.git/info/exclude'), 'tasks/\n.task/\n.omc/\nruntime/\n');

  // The project provider records stills and video rendered from the app state and theme.
  const projectDir = path.join(root, 'projects', project);
  mkdirSync(projectDir, { recursive: true });
  for (const file of ['provider.mjs', 'manifest.json'])
    copyFileSync(path.join(fixture, file), path.join(projectDir, file));
  // The provider's installation identity comes from its owning package.
  writeJson(path.join(projectDir, 'package.json'), {
    name: 'visual-repair-proof-provider',
    version: '0.0.0',
    private: true,
    type: 'module',
  });
  const markCommand = `node '${path.join(source, 'packages/agent-runtime/scripts/mark-checklist-step.cjs')}'`;
  writeJson(path.join(projectDir, 'project.json'), {
    name: project,
    runtime_dir: 'tasks',
    default_branch: 'main',
    hooks: {},
    paths: { runtimeDir: 'runtime', artifactDir: 'artifacts' },
    recipe: { adapter: 'proof-canvas', provider: { module: 'provider.mjs' } },
    review: { enabled: true, runner, max_retries: 3, mode: 'cold' },
    execution_templates: {
      sources: [{ id: 'proof:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
    },
    monitoring: {
      poll_interval_min: 1 / 60,
      stuck_timeout_min: 10,
      idle_timeout_min: 10,
      total_timeout_min: 60,
      max_nudges: 0,
    },
    vars: { mark_cmd: markCommand },
  });
  const ticket = `REPAIR-${Date.now()}`;
  // The orchestrator task root, mirrored from the checkout's hosted copy at completion.
  const taskFile = path.join(projectDir, 'tasks/dev', ticket, 'TASK.md');
  // The gateway copies the task into the checkout's hosted task directory (default `.task`).
  const taskDir = `.task/dev/${ticket}`;
  const checklist =
    '# Worker: dev\n\n- Task profile: dev\n\n## Checklist\n\n' +
    `- [ ] From the checkout root, record the canvas evidence once with \`RECIPE_TASK_DIR="$(cd ${taskDir} && pwd)" farmslot recipe run proof/recipe.json\`. Do not change the app or the recipe in this step. Visual judgment belongs to the independent reviewers: if the evidence looks wrong, note it under \`## Recipe ACs\` in TASK.md and continue without waiting for an operator.\n` +
    '- [ ] Finish according to TASK.md.\n';
  await writeNativeFixtureTask(taskFile, checklist, project, {
    markCommand,
    // The run has a human gate, so visual verdicts are deferred to evidence review.
    claimReviewGate: true,
    description:
      'Record the proof canvas evidence for independent review: the header bar should be blue and the square green. ' +
      'The branch already adds the canvas state (app/state.json) and its recipe (proof/recipe.json); describe both in the PR description. ' +
      'This first pass only records. Leave the app unchanged, note anything that looks wrong under `## Recipe ACs`, and mark complete once the recording passes. ' +
      'Reviewers decide each criterion and send back any fix as a separate repair round, where changing the app is allowed. Do not publish or contact services.',
  });
  const handoffFile = path.join(path.dirname(taskFile), 'inputs/handoff.json');
  const handoff = JSON.parse(readFileSync(handoffFile, 'utf8'));
  handoff.task = {
    ...handoff.task,
    acceptanceCriteria: ['The header bar is blue.', 'The square is green.'],
  };
  writeJson(handoffFile, handoff);
  mkdirSync(path.join(projectDir, 'shared/dev'), { recursive: true });
  writeFileSync(
    path.join(projectDir, 'shared/dev/proof.md'),
    `---\nplatforms: [cli]\n---\n\n${checklist}`,
  );
  const templates = path.join(projectDir, 'templates');
  mkdirSync(path.join(templates, 'prompts'), { recursive: true });
  mkdirSync(path.join(templates, 'worker'), { recursive: true });
  // Review-fix and Send back delivery share this production renderer and template.
  writeFileSync(
    path.join(templates, 'worker/review-fix.md'),
    [
      '# Worker: Review Fix Pass',
      '',
      '> Review found issues. Fix them, verify, update artifacts, commit and push. Never wait for input.',
      '',
      'Mark progress with `{{TASK_DIR}}/mark --checklist REVIEW-FIX.md --signal REVIEW-FIX-SIGNAL.json …`: `start`, each visible step number, then `complete --mark-last`, `no-change --reason "…"` or `blocked --reason "…"`.',
      '',
      '```',
      'TASK_DIR: {{TASK_DIR}}',
      'REPO: {{REPO}}',
      'TICKET: {{TICKET}}',
      '```',
      '',
      '## Issues Found by Review',
      '',
      '{{ISSUES}}',
      '',
      '## Checklist',
      '',
      '- [ ] Read every review feedback file and each issue.',
      '',
      '{{REVIEW_FEEDBACK_FILES}}',
      '',
      '- [ ] Fix the cause of each issue with the smallest change, and re-run any proof an issue asks for until it passes.',
      '- [ ] Update `{{TASK_DIR}}/artifacts/pr-description.md`, commit the fix to the current branch and push it to origin.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    path.join(templates, 'worker/review.static-code.md'),
    '# Static review\n\nRead the captured diff and the app files it touches. Follow the reviewer execution contract, write its result and feedback artifacts, and finish your own checklist through its mark wrapper. Do not publish or change source.\n\n## Steps\n- [ ] Review the captured source and evidence, then write the required artifacts\n',
  );
  writeFileSync(
    path.join(templates, 'prompts/worker-dispatch.md'),
    'Read {{TASK_FILE}} first. Follow {{TASK_DIR}}/CHECKLIST.md and use {{TASK_DIR}}/mark.\n',
  );
  writeJson(path.join(root, 'pool/local.json'), {
    machine: hostname(),
    host: 'localhost',
    ssh_user: userInfo().username,
    os: process.platform,
    project,
    platform: 'cli',
    slots: [{ id: slotId, enabled: true, mode: 'dispatch', repo, session: slotId }],
  });
  writeJson(path.join(root, '.farm-status.json'), {
    checked_at: new Date().toISOString(),
    slots: [
      {
        slot: slotId,
        project,
        machine: hostname(),
        platform: 'cli',
        lifecycle: 'ready',
        current_run_id: null,
        slot_epoch: 1,
      },
    ],
  });

  // The worker uses this checkout's CLI; the installed global binary is never used.
  const bin = path.join(temporary, 'bin');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'farmslot'),
    `#!/bin/sh\nexec node '${path.join(source, 'packages/cli/bin/farmslot.mjs')}' "$@"\n`,
  );
  chmodSync(path.join(bin, 'farmslot'), 0o755);

  const gatewayPort = await port();
  const serviceToken = testGatewayIdentity(home, `ws://127.0.0.1:${gatewayPort}`);
  const owner = new CredentialStoreRuntime({ FARMSLOT_HOME: home })
    .snapshot()
    .principals.find((principal) => principal.subject.displayName === 'test-automation');
  assert.ok(owner && owner.subject.type === 'service');
  // The person who judges evidence and sends it back.
  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
  const person = auth.writer.createPrincipal({ type: 'person', displayName: 'Proof reviewer' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const credential = auth.writer.issueCredential(person.id, 'Send back proof');
  const grant = auth.writer.exchangePersonCredential(credential.secret, {
    deviceName: 'Send back proof',
    deviceKind: 'cli',
  });
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    FARMSLOT_ROOT: root,
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
    FARMSLOT_HOME: home,
    FARMSLOT_GATEWAY_PROFILE: 'proof',
    FARMSLOT_RPC_TIMEOUT_MS: '120000',
    FARMSLOT_GATEWAY: `ws://127.0.0.1:${gatewayPort}`,
    FARMSLOT_GATEWAY_PASSWORD: '',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(gatewayPort),
    FARMSLOT_NATIVE_STATE_DIR: nativeRoot,
    FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: owner.id,
    FARMSLOT_DISABLE_ORCHESTRATION: '0',
    FARMSLOT_DEMO_POOL: '0',
    TMUX: '',
    TMUX_TMPDIR: path.join(temporary, 'tmux'),
    TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
  };
  delete env.FARMSLOT_DISABLE_RUN_ENGINE_START;
  mkdirSync(env.TMUX_TMPDIR!, { recursive: true });
  writeJson(path.join(out, 'fixture.json'), { temporary, root, repo, slotId, project, ticket });
  gateway = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
    cwd: source,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [gateway.stdout, gateway.stderr])
    stream?.on('data', (data) => {
      logs += String(data);
      appendFileSync(path.join(out, 'gateway-live.log'), String(data));
    });
  const healthDeadline = Date.now() + 60_000;
  for (;;) {
    assert.equal(gateway.exitCode, null, logs.slice(-4000));
    try {
      if ((await fetch(`http://127.0.0.1:${gatewayPort}/health`)).ok) break;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    assert.ok(Date.now() < healthDeadline, 'private gateway did not become healthy');
    await pause(100);
  }
  client = new GatewayClient({
    url: `ws://127.0.0.1:${gatewayPort}/ws`,
    timeout: 120_000,
    credential: { token: serviceToken },
  });
  reviewer = new GatewayClient({
    url: `ws://127.0.0.1:${gatewayPort}/ws`,
    timeout: 120_000,
    credential: { token: grant.accessToken },
  });

  // Startup recovery scans active runs once; create the proof run after that scan.
  await pause(15_000);
  // A cold native host compiled from source can exceed the client's launch wait.
  // Warm it once, so the worker dispatch measures delivery rather than compilation.
  const warmDeadline = Date.now() + 120_000;
  for (;;) {
    try {
      await call('native.session.list', {});
      if (existsSync(path.join(nativeRoot, 'ready.json'))) break;
    } catch (error) {
      if (Date.now() > warmDeadline) throw error;
    }
    assert.ok(Date.now() < warmDeadline, 'native host did not become ready');
    await pause(2000);
  }
  checks.push('native host ready before dispatch');
  const created = await call<{ run: Run }>('run.createNative', {
    project,
    flowType: 'dev',
    ticketOrPr: ticket,
    slotId,
    allowedSlots: [slotId],
    branch: 'visual-repair-proof',
    taskFile,
    runner,
    mode: 'interactive',
    // Reviewed success advances through the review pipeline to the publication gate.
    devInteractiveProfile: 'reviewed',
    skipPrepare: true,
    safetyTier: 'full-auto',
  });
  runId = created.run.id;
  writeJson(path.join(out, 'created.json'), created);
  console.log(`Send back proof run ${runId}`);

  // 1. The worker records the original evidence and the run reaches its publication gate.
  const gated = await waitFor(
    readRun,
    (run) => {
      failedRun(run);
      // The fixture gives the worker no operator question; a wait would only time out.
      assert.equal(run.waitingForOperator, undefined, run.waitingForOperator?.reason);
      return Boolean(pendingGate(run)?.payload && gatePackage(pendingGate(run)!));
    },
    'publication gate',
    30 * 60_000,
  );
  const gate = pendingGate(gated)!;
  writeJson(path.join(out, '1-gate.json'), gated);
  checks.push('a real native worker recorded two visual criteria and reached the publication gate');

  // 2. A person rejects AC-2 from the same evidence read the clients use.
  // Like the clients, bind the read to the displayed decision's frozen package.
  const evidence = await call<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
    runId,
    decisionId: gate.id,
    evidenceSnapshotHash: gatePackage(gate).packageHash,
    includeRecordedEvidence: true,
  });
  const recorded = evidence.recordedEvidence!;
  assert.ok(
    recorded.visualReviewContext && recorded.input?.claims,
    JSON.stringify(recorded.errors),
  );
  const original = recorded.input.claims;
  const issue = await judge<{ run: Run }>('run.reviewVisualClaim', {
    runId,
    decisionId: gate.id,
    claimId: 'AC-2',
    recipeRunId: original.recipeRunId,
    snapshotIdentity: recorded.visualReviewContext.snapshotIdentity,
    verdict: 'rejected',
    reason: 'The square is a dark off-brand green. Use the brand green #14a03c.',
  });
  writeJson(path.join(out, '2-issue.json'), issue.run);
  const offered = await waitFor(
    readRun,
    (run) => Boolean(pendingGate(run)?.actions.some((action) => action.id === 'send-feedback')),
    'Send back offered',
    120_000,
  );
  const sendGate = pendingGate(offered)!;
  checks.push('the person Issue refreshed the gate and Send back is offered');

  // 3. Client-authored repair content and a missing gate are refused without a charge.
  await assert.rejects(
    call('run.resolveDecision', {
      runId,
      decisionId: sendGate.id,
      actionId: 'send-feedback',
      selectionData: { feedback: 'Use this text instead' },
    }),
    /Send no selection data/u,
  );
  const unchanged = await readRun();
  assert.equal(unchanged.engineState?.publishGate?.visualRepairs, undefined);
  checks.push('client-supplied repair content is refused before admission and charges nothing');

  // 4. Send back reserves one fix round and delivers through the retained loop.
  const loopBefore = unchanged.engineState!.publishGate!.reviews!.at(-1)!;
  const sent = await call<{ run: Run }>('run.resolveDecision', {
    runId,
    decisionId: sendGate.id,
    actionId: 'send-feedback',
  });
  const reserved = sent.run.engineState!.publishGate!.visualRepairs!;
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0]!.reservedRetryCount, (loopBefore.retryCount ?? 0) + 1);
  writeJson(path.join(out, '4-reserved.json'), sent.run);
  await assert.rejects(
    call('run.resolveDecision', { runId, decisionId: sendGate.id, actionId: 'send-feedback' }),
    /already resolved/u,
  );
  checks.push('Send back persists one reservation; a duplicate resolve is refused');

  // 5. The retained worker repairs only AC-2; the gate returns with retained AC-1.
  const returned = await waitFor(
    readRun,
    (run) => {
      failedRun(run);
      const next = pendingGate(run);
      return Boolean(
        next &&
        next.id !== sendGate.id &&
        run.engineState?.publishGate?.visualRepairs?.[0]?.status === 'completed',
      );
    },
    'repaired gate',
    40 * 60_000,
  );
  writeJson(path.join(out, '5-returned.json'), returned);
  const repair = returned.engineState!.publishGate!.visualRepairs![0]!;
  const loopAfter = returned.engineState!.publishGate!.reviews!.find(
    (review) => review.id === repair.reviewId,
  )!;
  assert.equal(loopAfter.retryCount, repair.reservedRetryCount, 'one charge, no second increment');
  const nextGate = pendingGate(returned)!;
  const repaired = await call<RunRecipeRunsForRunResult>('run.recipeRunsForRun', {
    runId,
    decisionId: nextGate.id,
    evidenceSnapshotHash: gatePackage(nextGate).packageHash,
    includeRecordedEvidence: true,
  });
  const input = repaired.recordedEvidence!.input!;
  assert.ok(input.repair, 'the gate selected the engine repair package');
  writeJson(path.join(out, '5-repair-selection.json'), input.repair);
  writeJson(path.join(out, '5-applicability.json'), repair.applicability ?? []);
  writeJson(
    path.join(out, '5-readiness.json'),
    (nextGate.payload as ReadyGatePayload).gateReadiness,
  );
  checks.push('the retained worker re-proved AC-2 in a separate recipe and the gate returned');
  console.log(JSON.stringify({ checks }, null, 2));
} catch (error) {
  failure = error;
} finally {
  if (runId && client) {
    try {
      const run = await readRun();
      writeJson(path.join(out, 'final-run.json'), run);
      if (!['done', 'cancelled', 'failed'].includes(run.status))
        await call('run.cancel', { runId, reason: 'Send back proof cleanup' });
      const context = run.agentContexts?.find((item) => item.nativeSession);
      const binding = context?.nativeSession;
      if (context && binding)
        writeJson(
          path.join(out, 'closed-worker.json'),
          await call<NativeSessionReadResult>('native.session.read', {
            sessionId: binding.sessionId,
            executionNodeId: binding.executionNodeId,
            worker: {
              runId,
              contextId: context.id,
              generation: binding.generation,
              leaseId: binding.leaseId,
            },
          }),
        );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  await stop(gateway);
  const hostFile = path.join(nativeRoot, 'host.json');
  if (existsSync(hostFile)) {
    try {
      const host = JSON.parse(readFileSync(hostFile, 'utf8'));
      if (matchesProcess(host.pid, nativeRoot)) {
        process.kill(host.pid, 'SIGTERM');
        const deadline = Date.now() + 5000;
        while (matchesProcess(host.pid, nativeRoot) && Date.now() < deadline) await pause(50);
        assert.equal(matchesProcess(host.pid, nativeRoot), false, 'owned native host stops');
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  writeFileSync(path.join(out, 'gateway.log'), logs);
  writeJson(path.join(out, 'result.json'), {
    pass: !failure && !cleanupErrors.length,
    runId,
    checks,
    error: failure instanceof Error ? failure.stack : failure,
    cleanupErrors: cleanupErrors.map(String),
    ...(failure || cleanupErrors.length ? { retainedFixture: temporary } : {}),
  });
  if (!failure && !cleanupErrors.length) rmSync(temporary, { recursive: true, force: true });
}
if (failure || cleanupErrors.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...cleanupErrors],
    `Send back proof failed; evidence ${out}`,
  );
console.log(`Send back native proof PASS: ${out}`);
