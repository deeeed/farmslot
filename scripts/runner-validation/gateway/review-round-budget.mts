import { testGatewayIdentity } from '../../lib/test-gateway-identity-source.mjs';
// Manual production-RPC/native reviewer proof. All recovery inputs precede startup.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { centerOfRect } from 'agent-device';

import { NativeSessionClient } from '@farmslot/agent-runtime/native';
import { matchesProcess } from '@farmslot/agent-runtime/native/storage';
import type {
  ReadyGatePrPackage,
  NativeSessionReadResult,
  ReadyGatePayload,
  ReviewSelection,
  Run,
} from '@farmslot/protocol';

import { computeReadyGatePackageHash } from '../../../services/gateway/src/run-completion/ready-gate-package.js';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const phase = process.argv[2];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const payload: ReadyGatePayload = {
  kind: 'ready',
  prNumber: null,
  repo: null,
  branch: 'budget-change',
  workerReport: 'Review round control',
  diffStat: { files: 1, additions: 1, deletions: 0 },
};
const selection: ReviewSelection = {
  runner: 'claude',
  model: 'sonnet',
  effort: null,
  mode: 'cold',
};

if (phase === 'serve') {
  const fixture = process.argv[3];
  const runId = process.argv[4];
  const gatePayload = JSON.parse(
    readFileSync(path.join(fixture, 'gate-payload.json'), 'utf8'),
  ) as ReadyGatePayload;
  await import('../../../services/gateway/src/index.js');
  const { getRun } = await import('../../../services/gateway/src/runs/store.js');
  const { broadcastEvent } = await import('../../../services/gateway/src/server.js');
  const { createEngineDecision, setEngineDecisionRuntime } =
    await import('../../../services/gateway/src/run-engine/engine-decisions.js');
  const { executePublishGateReviewPlan } =
    await import('../../../services/gateway/src/run-engine/ready-gate.js');
  const startupDeadline = Date.now() + 15_000;
  while (!getRun(runId)) {
    if (Date.now() >= startupDeadline) throw new Error('Persisted proof run did not load');
    await pause(50);
  }
  setEngineDecisionRuntime({ broadcast: broadcastEvent, stepToStatus: {} });
  const awaiting = createEngineDecision(
    runId,
    'human_gate',
    'Request the fifth review.',
    [
      { id: 'request-review', label: 'Review', style: 'secondary' },
      { id: 'hold', label: 'Hold', style: 'secondary' },
    ],
    gatePayload,
  );
  assert.equal(await awaiting, 'request-review');
  const requested = getRun(runId)!.decisions.find(
    (decision) => decision.resolvedAction === 'request-review',
  );
  assert.deepEqual(requested?.selectionData?.reviewRequest, selection);
  const result = await executePublishGateReviewPlan(
    runId,
    getRun(runId)!.slotId!,
    [selection],
    'dispatch',
  );
  writeJson(path.join(fixture, 'review-plan-result.json'), {
    result,
    reviews: getRun(runId)!.engineState?.publishGate?.reviews,
  });
  assert.equal(result.reviewIds.length, 1);
  assert.equal(result.rejection, undefined);
  assert.equal(getRun(runId)!.reviewRoundAdmissions!.length, 5);
  writeJson(path.join(fixture, 'fifth.json'), getRun(runId));
  void createEngineDecision(
    runId,
    'human_gate',
    'Five rounds spent.',
    [
      { id: 'request-review', label: 'Review', style: 'secondary' },
      { id: 'hold', label: 'Hold', style: 'secondary' },
    ],
    gatePayload,
    { canReplay: () => false },
  );
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), 'review-round-proof-'));
  const root = path.join(temporary, 'root');
  const repo = path.join(root, 'checkout');
  const project = 'review-round-proof';
  const runId = randomUUID();
  const raceRunId = randomUUID();
  const raceSlotId = `budget-${raceRunId}`;
  const raceRepo = path.join(root, 'waiting-checkout');
  const slotId = `budget-${runId}`;
  const out = path.resolve(
    process.env.FARMSLOT_REVIEW_BUDGET_OUT ?? 'temp/review-round-proof',
    randomUUID(),
  );
  const logs: string[] = [];
  let primaryFailure: unknown;
  let gateway: ChildProcess | undefined;
  let ui: ChildProcess | undefined;
  let metro: ChildProcess | undefined;
  let waitingRequest: ChildProcess | undefined;
  let route: string | undefined;
  let env: NodeJS.ProcessEnv;
  const helper = (...args: string[]): unknown => {
    const output = execFileSync(
      process.execPath,
      [path.join(source, 'apps/command-center/scripts/cdp.mjs'), ...args],
      {
        cwd: source,
        env,
        encoding: 'utf8',
        timeout: 35_000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return output.trim() ? JSON.parse(output) : null;
  };
  const rpc = (method: string, params: unknown) =>
    helper('gateway', method, JSON.stringify(params));
  const readRun = () => (rpc('run.get', { runId }) as { run: Run }).run;
  const browserBudget = () =>
    helper(
      'eval',
      route!,
      "const walk = root => [...root.querySelectorAll('*')].flatMap(el => [el, ...(el.shadowRoot ? walk(el.shadowRoot) : [])]); const nodes = walk(document); return {label: nodes.find(el => el.getAttribute('data-testid') === 'rdy-review-round-budget')?.textContent.trim() ?? null, disabled: nodes.find(el => el.getAttribute('data-testid') === 'rdy-request-review')?.disabled ?? null};",
    ) as { label: string | null; disabled: boolean | null };
  async function waitFor(read: () => Promise<boolean> | boolean, label: string, timeout = 120_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (gateway && gateway.exitCode !== null)
        throw new Error(
          `Private gateway exited (${gateway.exitCode}): ${logs.join('').slice(-4000)}`,
        );
      if (await read()) return;
      await pause(100);
    }
    throw new Error(`Timed out: ${label}`);
  }
  async function port() {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const value = server.address();
    assert.ok(value && typeof value !== 'string');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    return value.port;
  }
  async function stop(child?: ChildProcess) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), pause(3_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
  try {
    mkdirSync(out, { recursive: true });
    mkdirSync(repo, { recursive: true });
    symlinkSync(path.join(source, 'packages'), path.join(root, 'packages'), 'dir');
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable review round proof\n');
    writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
    writeJson(path.join(root, 'services/gateway/package.json'), {
      name: 'fixture',
      version: '0.0.0',
    });
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    writeFileSync(path.join(repo, 'example.js'), 'export const answer = 42;\n');
    git('add', 'example.js');
    git('commit', '-S', '-m', 'test: create review budget baseline');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    git('checkout', '-b', 'budget-change');
    writeFileSync(
      path.join(repo, 'example.js'),
      'export const answer = 42;\nexport const doubled = answer * 2;\n',
    );
    git('add', 'example.js');
    git('commit', '-S', '-m', 'test: add review budget control');
    execFileSync('git', ['clone', '--quiet', '--local', repo, raceRepo]);
    const taskDir = path.join(repo, 'tasks/control');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(repo, '.git/info/exclude'), 'tasks/\n');
    writeFileSync(path.join(taskDir, 'TASK.md'), '# Review budget control\n');
    writeJson(path.join(taskDir, 'inputs/handoff.json'), { task: { acceptanceCriteria: [] } });
    const retained = path.join(root, 'projects', project, 'tasks/control');
    mkdirSync(retained, { recursive: true });
    writeFileSync(path.join(retained, 'TASK.md'), '# Review budget control\n');
    writeJson(path.join(retained, 'inputs/handoff.json'), { task: { acceptanceCriteria: [] } });
    writeJson(path.join(root, 'projects', project, 'project.json'), {
      name: project,
      runtime_dir: 'tasks',
      task_dir_name: 'tasks',
      default_branch: 'origin/main',
      hooks: {},
      vars: {
        mark_cmd: `node '${path.join(source, 'packages/agent-runtime/scripts/mark-checklist-step.cjs').replaceAll("'", "'\\''")}'`,
      },
      review: {
        enabled: true,
        runner: 'claude',
        model: 'sonnet',
        max_retries: 0,
        review_timeout_min: 2,
      },
    });
    const template = path.join(root, 'projects', project, 'templates/worker/review.static-code.md');
    mkdirSync(path.dirname(template), { recursive: true });
    writeFileSync(
      template,
      '# Static review\n\nRead the captured diff and example.js. Follow the reviewer execution contract, write its result and feedback artifacts, and finish your own checklist through its mark wrapper. Do not publish or change source.\n\n## Steps\n- [ ] Review the captured source and write the required artifacts\n',
    );
    writeJson(path.join(root, 'pool/local.json'), {
      schema_version: 2,
      machine: hostname(),
      host: 'localhost',
      ssh_user: userInfo().username,
      os: process.platform,
      project,
      platform: 'cli',
      slots: [
        {
          id: slotId,
          project,
          platform: 'cli',
          repo,
          session: slotId,
          enabled: true,
          mode: 'dispatch',
        },
        {
          id: raceSlotId,
          project,
          platform: 'cli',
          repo: raceRepo,
          session: raceSlotId,
          enabled: true,
          mode: 'dispatch',
        },
      ],
    });
    writeJson(path.join(root, '.farm-status.json'), {
      checked_at: new Date().toISOString(),
      slots: [
        {
          slot: slotId,
          machine: hostname(),
          project,
          platform: 'cli',
          lifecycle: 'busy',
          phase: 'review-gate',
          current_run_id: runId,
        },
        {
          slot: raceSlotId,
          machine: hostname(),
          project,
          platform: 'cli',
          lifecycle: 'busy',
          phase: 'review-gate',
          current_run_id: raceRunId,
        },
      ],
    });
    const now = new Date().toISOString();
    const prepared: ReadyGatePrPackage = {
      id: 'review-budget-package',
      artifactPath: 'artifacts/pr-package.json',
      branch: 'budget-change',
      headSha: git('rev-parse', 'HEAD'),
      diffStat: payload.diffStat,
      draftTitle: 'Review budget control',
      draftBody: 'Signed local diff control',
      evidenceManifest: [],
      selectedEvidenceKeys: [],
      reviewArtifactIds: [],
      gatePolicy: { owner: 'human', publishAuthority: 'human', reason: 'Review budget control' },
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' },
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      createdAt: now,
      packageHash: '',
    };
    prepared.packageHash = computeReadyGatePackageHash(prepared);
    writeJson(path.join(retained, prepared.artifactPath), prepared);
    writeJson(path.join(out, 'gate-payload.json'), { ...payload, prPackage: prepared });
    const run: Run = {
      id: runId,
      familyId: randomUUID(),
      lane: 'validation',
      flowType: 'dev',
      mode: 'interactive',
      status: 'human-gating',
      project,
      ticketOrPr: 'MANUAL-REVIEW-BUDGET',
      links: [{ label: 'PR', url: 'https://github.com/example/review-budget/pull/42' }],
      slotId,
      branch: 'budget-change',
      taskFile: path.join(retained, 'TASK.md'),
      createdAt: now,
      updatedAt: now,
      transport: 'native',
      nativeOwnerPrincipalId: 'test-automation',
      metrics: {
        runner: 'claude',
        model: 'sonnet',
        nudgeCount: 0,
        runnerSessionId: null,
        runnerSessionPath: null,
      },
      steps: [
        { name: 'dispatch', status: 'done' },
        { name: 'human-gate', status: 'running' },
      ],
      decisions: [],
      agentContexts: [],
      reviewRoundAdmissions: ['prior-one', 'prior-two', 'prior-three', 'prior-four'],
      engineState: { generation: 0 },
    };
    writeJson(path.join(root, '.runs', `${runId}.json`), run);
    const raceDecision = {
      id: 'waiting-review-request',
      type: 'engine_human_gate',
      title: 'Waiting review',
      description: '',
      actions: [{ id: 'request-review', label: 'Review', style: 'secondary' }],
      createdAt: now,
      payload,
    };
    writeJson(path.join(root, '.runs', `${raceRunId}.json`), {
      ...run,
      id: raceRunId,
      slotId: raceSlotId,
      decisions: [raceDecision],
    });
    const issueIds = [randomUUID(), randomUUID()];
    for (const [index, id] of issueIds.entries())
      writeJson(path.join(root, '.runs', `${id}.json`), {
        ...run,
        id,
        slotId: null,
        ticketOrPr: 'example/issue-scope#42',
        links: [],
        decisions: [{ ...raceDecision, id: `issue-gate-${index}` }],
        reviewRoundAdmissions: index ? [] : ['issue-one', 'issue-two', 'issue-three'],
      });
    const gatewayPort = await port();
    const uiPort = await port();
    const proofToken = testGatewayIdentity(
      path.join(temporary, 'home'),
      `ws://127.0.0.1:${gatewayPort}`,
    );
    env = {
      ...process.env,
      FARMSLOT_ROOT: root,
      FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
      FARMSLOT_POOL_DIR: path.join(root, 'pool'),
      FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
      FARMSLOT_HOME: path.join(temporary, 'home'),
      FARMSLOT_NATIVE_STATE_DIR: path.join(temporary, 'native'),
      FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'test-automation',
      FARMSLOT_GATEWAY_PROFILE: 'proof',
      FARMSLOT_GATEWAY_PASSWORD: '',
      FARMSLOT_GATEWAY: `ws://127.0.0.1:${gatewayPort}`,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(gatewayPort),
      FARMSLOT_UI_URL: `http://127.0.0.1:${uiPort}`,
      FARMSLOT_CDP_PORT: process.env.FARMSLOT_CDP_PORT,
      FARMSLOT_DISABLE_ORCHESTRATION: '1',
      FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
      FARMSLOT_DEMO_POOL: '0',
      NODE_TEST_CONTEXT: '1',
      TMUX: '',
      TMUX_TMPDIR: path.join(temporary, 'tmux'),
      TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
    };
    mkdirSync(env.TMUX_TMPDIR!, { recursive: true });
    const control = process.argv
      .find((arg) => arg.startsWith('--negative-control='))
      ?.split('=')[1];
    assert.ok(
      !control || ['rpc', 'consumption', 'scope'].includes(control),
      'unknown negative control',
    );
    const loader = path.join(temporary, 'schedule.mjs');
    const waitingMarker = path.join(out, 'request-waiting');
    const releaseMarker = path.join(out, 'request-release');
    const delaySource = `
if (params.runId === ${JSON.stringify(raceRunId)}) {
  const {existsSync, writeFileSync} = await import('node:fs');
  writeFileSync(${JSON.stringify(waitingMarker)}, 'validated');
  const deadline = Date.now() + 30000;
  while (!existsSync(${JSON.stringify(releaseMarker)})) {
    if (Date.now() >= deadline) throw new Error('Review budget schedule timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}`;
    writeFileSync(
      loader,
      `import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs'; import {registerHooks} from 'node:module';
const control = ${JSON.stringify(control ?? null)};
registerHooks({load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  const before = String(result.source);
  let after = before;
  if (control === 'scope' && url.endsWith('/services/gateway/src/review/review-round-budget.ts')) {
    after = before.replace(/requirePRContext:\\s*true/g, 'requirePRContext: false');
    assert.notEqual(after, before, 'scope control must change its target');
  } else if (url.endsWith('/services/gateway/src/methods/run.ts')) {
    if (control === 'rpc') after = after.replace(/await assertReviewRoundAvailable\\(getRun\\(params\\.runId\\)!?\\);/, 'void params.runId;');
    if (control === 'rpc' || control === 'consumption') after = after.replace(/assertReviewBudgetAtConsumption\\?\\.\\(\\);/, 'void params.runId;');
    if (control && control !== 'scope') assert.notEqual(after, before, 'RPC control must change its target');
    const delayed = after.replace(/(const currentDescription = await assertReadyPublishResolveIsFresh\\(existing, decision, params\\);)/, '$1' + ${JSON.stringify(delaySource)});
    assert.notEqual(delayed, after, 'schedule must delay the real awaited probe boundary');
    after = delayed;
  } else return result;
  if (control) writeFileSync(${JSON.stringify(path.join(out, 'negative-control-applied.json'))}, JSON.stringify({control}));
  return {...result, source: after};
}});`,
    );
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import ${loader}`;
    gateway = spawn(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(import.meta.url), 'serve', out, runId],
      { cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    for (const stream of [gateway.stdout, gateway.stderr])
      stream?.on('data', (data) => logs.push(String(data)));
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).ok;
      } catch (error) {
        if (error instanceof TypeError) return false;
        throw error;
      }
    }, 'private gateway');
    await waitFor(
      () => readRun().decisions.some((decision) => !decision.resolvedAt),
      'four-round gate',
    );
    const initial = readRun();
    const firstGate = initial.decisions.find((decision) => !decision.resolvedAt)!;
    assert.equal(firstGate.payload?.kind, 'ready');
    assert.equal((firstGate.payload as ReadyGatePayload).reviewRoundBudget?.used, 4);
    const issueBudgets = issueIds.map((id) => {
      const observed = (rpc('run.get', { runId: id }) as { run: Run }).run;
      return (observed.decisions[0].payload as ReadyGatePayload).reviewRoundBudget!.used;
    });
    assert.deepEqual(issueBudgets, [3, 0], 'separate issue runs keep canonical budgets');
    writeJson(path.join(out, 'issue-scope.json'), { issueIds, issueBudgets });
    if (process.argv.includes('--ui')) {
      assert.ok(env.FARMSLOT_CDP_PORT, 'FARMSLOT_CDP_PORT must select the owned browser');
      ui = spawn(
        process.execPath,
        [
          path.join(source, 'node_modules/vite/bin/vite.js'),
          '--host',
          '127.0.0.1',
          '--port',
          String(uiPort),
        ],
        {
          cwd: path.join(source, 'apps/command-center/ui'),
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      await waitFor(async () => {
        try {
          return (await fetch(env.FARMSLOT_UI_URL!)).ok;
        } catch (error) {
          if (error instanceof TypeError) return false;
          throw error;
        }
      }, 'Command Center');
      route = `run/${runId}`;
      helper('goto', route, '--new');
      helper('login', route);
      if (
        helper(
          'eval',
          route,
          "Boolean(document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('button.primary'))",
        )
      )
        helper('click', route, 'whats-new-modal >>> button.primary');
      await waitFor(
        () => browserBudget().label === 'Review rounds 4/5' && browserBudget().disabled === false,
        'four-round browser review remains enabled',
      );
      writeJson(path.join(out, 'browser-four-round.json'), browserBudget());
    }
    let waitingOutput = '';
    let waitingError = '';
    waitingRequest = spawn(
      process.execPath,
      [
        path.join(source, 'apps/command-center/scripts/cdp.mjs'),
        'gateway',
        'run.resolveDecision',
        JSON.stringify({
          runId: raceRunId,
          decisionId: raceDecision.id,
          actionId: 'request-review',
          selectionData: { reviewRequest: selection },
        }),
      ],
      { cwd: source, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    waitingRequest.stdout?.on('data', (data) => (waitingOutput += String(data)));
    waitingRequest.stderr?.on('data', (data) => (waitingError += String(data)));
    const waitingExit = once(waitingRequest, 'exit');
    await waitFor(() => existsSync(waitingMarker), 'request passed its early budget check');
    rpc('run.resolveDecision', {
      runId,
      decisionId: firstGate.id,
      actionId: 'request-review',
      selectionData: { reviewRequest: selection },
    });
    await waitFor(
      () => readRun().reviewRoundAdmissions?.length === 5,
      'sibling spends fifth during awaited validation',
    );
    writeFileSync(releaseMarker, 'continue');
    const [waitingCode] = await waitingExit;
    assert.notEqual(
      waitingCode,
      0,
      'the delayed request must refuse before consuming its decision',
    );
    assert.match(waitingError, /REVIEW_ROUND_LIMIT_REACHED/);
    const waitingRun = (rpc('run.get', { runId: raceRunId }) as { run: Run }).run;
    assert.equal(waitingRun.decisions[0].resolvedAt, undefined);
    assert.equal(waitingRun.decisions[0].selectionData, undefined);
    writeJson(path.join(out, 'concurrent-request.json'), {
      waitingCode,
      waitingOutput,
      waitingError,
      waitingRun,
    });
    await waitFor(() => {
      const context = readRun().agentContexts?.find((entry) => entry.role === 'review');
      const binding = context?.nativeSession;
      if (!context || !binding?.acceptedAt) return false;
      const observed = rpc('native.session.read', {
        sessionId: binding.sessionId,
        executionNodeId: binding.executionNodeId,
        worker: {
          runId,
          contextId: context.id,
          generation: binding.generation,
          leaseId: binding.leaseId,
        },
      }) as NativeSessionReadResult;
      assert.equal(
        observed.commands.find((command) => command.commandId === binding.commandId)?.accepted,
        true,
      );
      writeJson(path.join(out, 'fifth-native-accepted.json'), { context, observed });
      return true;
    }, 'fifth native command accepted');
    await waitFor(
      () => existsSync(path.join(out, 'fifth.json')),
      'real native fifth reviewer',
      180_000,
    );
    await waitFor(
      () =>
        readRun().decisions.some(
          (decision) => !decision.resolvedAt && decision.id !== firstGate.id,
        ),
      'five-round gate',
    );
    const after = readRun();
    const gate = after.decisions.find((decision) => !decision.resolvedAt)!;
    assert.equal((gate.payload as ReadyGatePayload).reviewRoundBudget?.label, 'Review rounds 5/5');
    assert.throws(
      () =>
        rpc('run.resolveDecision', {
          runId,
          decisionId: gate.id,
          actionId: 'request-review',
          selectionData: { reviewRequest: selection },
        }),
      /REVIEW_ROUND_LIMIT_REACHED/,
    );
    assert.equal(
      readRun().decisions.find((decision) => decision.id === gate.id)!.resolvedAt,
      undefined,
    );
    writeJson(path.join(out, 'sixth-refused.json'), readRun());
    await stop(gateway);
    gateway = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
      cwd: source,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [gateway.stdout, gateway.stderr])
      stream?.on('data', (data) => logs.push(String(data)));
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).ok;
      } catch (error) {
        if (error instanceof TypeError) return false;
        throw error;
      }
    }, 'restarted gateway');
    assert.equal(
      (readRun().decisions.find((decision) => decision.id === gate.id)!.payload as ReadyGatePayload)
        .reviewRoundBudget?.used,
      5,
    );
    assert.throws(
      () =>
        rpc('run.resolveDecision', {
          runId,
          decisionId: gate.id,
          actionId: 'request-review',
          selectionData: { reviewRequest: selection },
        }),
      /REVIEW_ROUND_LIMIT_REACHED/,
    );
    if (route) {
      await waitFor(() => browserBudget().label === 'Review rounds 5/5', 'browser round count');
      assert.equal(browserBudget().disabled, true, 'browser review action is disabled');
      writeJson(path.join(out, 'browser-budget.json'), browserBudget());
      helper('screenshot', route, path.join(out, 'round-budget.png'));
    }
    const simulator = process.env.FARMSLOT_REVIEW_BUDGET_SIMULATOR;
    if (simulator) {
      const metroPort = await port();
      const origin = `http://localhost:${metroPort}`;
      const { seedIOSGatewayProfile } =
        await import('../../../apps/companion/scripts/agentic/seed-ios-gateway-profile.mjs');
      seedIOSGatewayProfile({
        simulator,
        bundleId: 'net.siteed.farmslot.development',
        seenVersion: undefined,
        profile: {
          id: 'review-budget-proof',
          name: 'Review budget proof',
          url: env.FARMSLOT_GATEWAY,
          kind: 'custom',
          authMode: 'token',
          presetSecret: proofToken,
        },
      });
      metro = spawn(
        process.execPath,
        [
          '--dns-result-order=ipv4first',
          path.join(source, 'node_modules/expo/bin/cli'),
          'start',
          '--dev-client',
          '--localhost',
          '--port',
          String(metroPort),
        ],
        {
          cwd: path.join(source, 'apps/companion'),
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...env,
            CI: '1',
            EXPO_OFFLINE: '1',
            EXPO_NO_DOTENV: '1',
            APP_VARIANT: 'development',
            METRO_PORT: String(metroPort),
            FARMSLOT_LOCAL_RUNTIME_CONFIG: '1',
            EXPO_PUBLIC_GATEWAY_URL: env.FARMSLOT_GATEWAY,
            FARMSLOT_REMOTE_GATEWAY_URL: '',
            FARMSLOT_REMOTE_GATEWAY_TOKEN: '',
            EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE: '1',
          },
        },
      );
      for (const stream of [metro.stdout, metro.stderr])
        stream?.on('data', (data) => logs.push(String(data)));
      await waitFor(async () => {
        assert.equal(metro!.exitCode, null);
        try {
          return (await fetch(`${origin}/status`)).ok;
        } catch (error) {
          if (error instanceof TypeError) return false;
          throw error;
        }
      }, 'Companion Metro');
      interface NativeUiNode {
        AXLabel?: string;
        AXUniqueId?: string;
        enabled?: boolean;
        frame: { x: number; y: number; width: number; height: number };
      }
      const tree = (): NativeUiNode[] =>
        JSON.parse(
          execFileSync('idb', ['ui', 'describe-all', '--udid', simulator, '--json'], {
            encoding: 'utf8',
            timeout: 15_000,
            maxBuffer: 8 * 1024 * 1024,
          }),
        );
      const press = (node: NativeUiNode) => {
        const point = centerOfRect(node.frame);
        execFileSync('idb', ['ui', 'tap', String(point.x), String(point.y), '--udid', simulator], {
          timeout: 15_000,
        });
      };
      const acceptLink = () => {
        const nodes = tree();
        if (!nodes.some((node) => node.AXLabel?.startsWith('Open in'))) return;
        const open = nodes.find((node) => node.AXLabel === 'Open');
        assert.ok(open);
        press(open);
      };
      execFileSync('xcrun', ['simctl', 'launch', simulator, 'net.siteed.farmslot.development']);
      execFileSync('xcrun', [
        'simctl',
        'openurl',
        simulator,
        `farmslot-development://expo-development-client/?url=${encodeURIComponent(origin)}`,
      ]);
      acceptLink();
      await waitFor(async () => {
        const targets = await (await fetch(`${origin}/json/list`)).json();
        return Array.isArray(targets) && targets.length > 0;
      }, 'connected Companion');
      const bridge = async (command: string, value: Record<string, unknown>) => {
        const response = await fetch(`${origin}/farmslot-recipe/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command,
            payload: value,
            nodeId: 'review-budget-native',
            timeout_ms: 30_000,
          }),
        });
        const result = (await response.json()) as { ok: boolean; platform?: string };
        assert.equal(result.ok, true, JSON.stringify(result));
        return result;
      };
      assert.equal((await bridge('status', {})).platform, 'ios');
      await bridge('hud', {
        title: 'Review round budget',
        intent: 'Show the spent five-round budget and disabled review action.',
        status: 'running',
      });
      execFileSync('xcrun', [
        'simctl',
        'openurl',
        simulator,
        `farmslot-development:///run/${runId}`,
      ]);
      acceptLink();
      await waitFor(() => {
        const nodes = tree();
        const dismiss = nodes.find((node) => node.AXLabel === 'Got it');
        if (dismiss) {
          press(dismiss);
          return false;
        }
        const tab = nodes.find((node) => node.AXLabel === 'Run Detail: Gate tab');
        if (!tab) return false;
        press(tab);
        return true;
      }, 'native Gate tab');
      execFileSync('xcrun', [
        'simctl',
        'openurl',
        simulator,
        `farmslot-development:///decision/${gate.id}?runId=${runId}`,
      ]);
      acceptLink();
      await waitFor(() => {
        const nodes = tree();
        if (!nodes.some((node) => node.AXLabel?.includes('Review rounds 5/5'))) return false;
        assert.equal(
          nodes.find((node) => node.AXUniqueId === 'companion-gate-review-submit')?.enabled,
          false,
          'native review action is disabled',
        );
        writeJson(path.join(out, 'companion-budget-tree.json'), nodes);
        execFileSync('xcrun', [
          'simctl',
          'io',
          simulator,
          'screenshot',
          path.join(out, 'companion-budget.png'),
        ]);
        return true;
      }, 'Companion round count');
      await bridge('hud', { status: 'pass' });
    }
    const hashes = Object.fromEntries(
      [
        'services/gateway/src/review/review-round-budget.ts',
        'services/gateway/src/review/session-mode.ts',
        'services/gateway/src/review/native-review-agent.ts',
        'services/gateway/src/methods/run.ts',
        'services/gateway/src/run-engine/engine-decisions.ts',
        'apps/command-center/ui/src/components/workspace/ready-workspace-shell-renderers.ts',
        'apps/companion/src/features/decision-workspace/DecisionWorkspaceScreen.tsx',
        'scripts/runner-validation/gateway/review-round-budget.mts',
      ].map((file) => [
        file,
        createHash('sha256')
          .update(readFileSync(path.join(source, file)))
          .digest('hex'),
      ]),
    );
    writeJson(path.join(out, 'receipt.json'), {
      runId,
      hashes,
      checks: [
        'four recovery receipts seeded before startup',
        'normalized issue runs retain separate pre-PR budgets',
        'concurrent fifth during awaited validation preserves the waiting gate',
        'public RPC starts actual native fifth reviewer',
        'sixth refusal preserves pending decision',
        'gateway restart retains five-round budget',
      ],
      limits: [
        'Private local gateway and immutable source fixture; browser screenshots are operator UI and HUD-exempt.',
      ],
      browser: Boolean(route),
      nativeUi: Boolean(simulator),
    });
    if (process.argv.includes('--cleanup-disconnect')) env.FARMSLOT_CDP_PORT = String(await port());
    console.log(JSON.stringify({ pass: true, runId, raceRunId, out }));
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const failures: unknown[] = [];
    let nativeHostStopped = true;
    const cleanup = async (action: () => unknown) => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    await cleanup(() => {
      if (route) helper('close', route);
    });
    const stopped = await Promise.allSettled([
      stop(waitingRequest),
      stop(metro),
      stop(ui),
      stop(gateway),
    ]);
    failures.push(
      ...stopped.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
    );
    await cleanup(async () => {
      const native = new NativeSessionClient(path.join(temporary, 'native'));
      const hostFile = path.join(native.root, 'host.json');
      if (existsSync(hostFile)) {
        const host = JSON.parse(readFileSync(hostFile, 'utf8'));
        if (matchesProcess(host.pid, native.root)) {
          process.kill(host.pid, 'SIGTERM');
          const deadline = Date.now() + 5_000;
          while (matchesProcess(host.pid, native.root) && Date.now() < deadline) await pause(20);
          nativeHostStopped = !matchesProcess(host.pid, native.root);
          assert.equal(nativeHostStopped, true, 'owned native proof host stops during teardown');
        }
      }
    });
    await cleanup(() => writeJson(path.join(out, 'logs.json'), logs));
    await cleanup(() => rmSync(temporary, { recursive: true, force: true }));
    await cleanup(() =>
      writeJson(path.join(out, 'cleanup.json'), {
        fixtureRemoved: !existsSync(temporary),
        nativeHostStopped,
        processesStopped: [gateway, ui, metro].every(
          (child) => !child || child.exitCode !== null || child.signalCode !== null,
        ),
        failures: failures.length,
      }),
    );
    if (failures.length)
      throw new AggregateError(
        primaryFailure ? [primaryFailure, ...failures] : failures,
        'Review proof cleanup failed',
        { cause: primaryFailure },
      );
  }
}
