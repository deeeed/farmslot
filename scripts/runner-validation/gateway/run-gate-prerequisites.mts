// Manual production-RPC proof. Persisted recovery inputs are seeded before startup.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { centerOfRect } from 'agent-device';

import { NativeSessionClient } from '@farmslot/agent-runtime/native';
import { matchesProcess } from '@farmslot/agent-runtime/native/storage';
import {
  FLOW_STEPS,
  isRecord,
  type NativeWorkerSessionBinding,
  type ReadyGatePayload,
  type ReadyGatePrPackage,
  type Run,
} from '@farmslot/protocol';

import { computeReadyGatePackageHash } from '../../../services/gateway/src/run-completion/ready-gate-package.js';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), 'run-gate-proof-'));
const root = path.join(temporary, 'root');
const out = path.resolve(
  process.env.FARMSLOT_GATE_PROOF_OUT ?? 'temp/run-gate-proof',
  randomUUID(),
);
const project = 'run-gate-proof';
const runId = randomUUID();
const slotId = `gate-${runId}`;
const familyId = randomUUID();
const taskDir = path.join(root, 'checkout/tasks/current');
const retained = path.join(root, 'projects', project, 'tasks/retained');
const criteria = Array.from({ length: 11 }, (_, index) => `Registered requirement ${index + 1}`);
let gateway: ChildProcess | undefined;
let ui: ChildProcess | undefined;
let metro: ChildProcess | undefined;
let env: NodeJS.ProcessEnv;
let route: string | undefined;
const checks: string[] = [];
const native = new NativeSessionClient(path.join(temporary, 'native'));
let worker: NativeWorkerSessionBinding | undefined;
const requiredRunId = randomUUID();
const releaseFile = path.join(temporary, 'release-fix');
const logs: string[] = [];
const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
function helper(...args: string[]): unknown {
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
}
const readRun = () => (helper('gateway', 'run.get', JSON.stringify({ runId })) as { run: Run }).run;
async function waitFor(read: () => Promise<boolean> | boolean, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await read()) return;
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), pause(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

try {
  mkdirSync(out, { recursive: true });
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  execFileSync('git', [
    'clone',
    '--quiet',
    '--shared',
    '--sparse',
    source,
    path.join(root, 'checkout'),
  ]);
  writeFileSync(path.join(root, 'CLAUDE.md'), '# Disposable gate proof\n');
  writeFileSync(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
  writeJson(path.join(root, 'services/gateway/package.json'), {
    name: 'fixture',
    version: '0.0.0',
  });
  writeJson(path.join(root, 'projects', project, 'project.json'), {
    name: project,
    runtime_dir: 'tasks',
    task_dir_name: 'tasks',
    hooks: {},
  });
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
        repo: path.dirname(path.dirname(taskDir)),
        session: slotId,
        enabled: true,
        mode: 'dispatch',
      },
    ],
  });
  writeJson(path.join(root, 'pool/status-local.json'), {
    slots: [{ slot: slotId, lifecycle: 'held', phase: 'occupied', current_run_id: runId }],
  });
  for (const directory of [taskDir, retained]) {
    writeJson(path.join(directory, 'inputs/handoff.json'), {
      task: { acceptanceCriteria: criteria },
    });
    writeFileSync(path.join(directory, 'TASK.md'), '# Gate proof\n');
  }
  // The display copy appears complete. Production enforcement must read the dispatched task.
  writeJson(path.join(retained, 'artifacts/acceptance-status.json'), {
    schemaVersion: 1,
    criteria: criteria.map((text, index) => ({
      id: `AC-${index + 1}`,
      text,
      verdict: 'proven',
      proofMode: 'state',
      evidence: ['artifacts/output.json'],
      recipeNodes: [],
      updatedAt: new Date().toISOString(),
    })),
  });
  writeJson(path.join(retained, 'artifacts/output.json'), { complete: true });
  const payload: ReadyGatePayload = {
    kind: 'ready',
    prNumber: null,
    repo: null,
    workerReport: 'Recovered package',
    branch: 'feature/gate-proof',
    diffStat: { files: 0, additions: 0, deletions: 0 },
  };
  const now = new Date().toISOString();
  const run: Run = {
    id: runId,
    familyId,
    parentRunId: null,
    familyRootTicketOrPr: 'GATE-PROOF',
    lane: 'production',
    variant: null,
    flowType: 'dev',
    mode: 'interactive',
    status: 'human-gating',
    project,
    ticketOrPr: 'GATE-PROOF',
    slotId,
    branch: payload.branch,
    taskFile: path.join(retained, 'TASK.md'),
    createdAt: now,
    updatedAt: now,
    metrics: {
      runner: 'codex',
      model: null,
      nudgeCount: 0,
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    steps: [
      { name: 'dispatch', status: 'done' },
      { name: 'human-gate', status: 'running' },
    ],
    agentContexts: [
      {
        id: 'primary',
        role: 'primary',
        runId,
        slotId,
        label: 'Worker',
        status: 'complete',
        taskFile: 'tasks/current/TASK.md',
        runner: 'codex',
      },
    ],
    decisions: [
      {
        id: 'gate-proof',
        type: 'engine_human_gate',
        title: 'Gate proof',
        description: 'Review recovered inputs',
        createdAt: now,
        payload,
        actions: [
          { id: 'ready', label: 'Mark Ready', style: 'primary' },
          { id: 'hold', label: 'Hold', style: 'secondary' },
        ],
      },
    ],
  };
  writeJson(path.join(root, '.runs', `${runId}.json`), run);
  const port = await freePort();
  const uiPort = await freePort();
  mkdirSync(path.join(temporary, 'tmux'));
  env = {
    ...process.env,
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(temporary, 'home'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_RUNS_DIR: path.join(root, '.runs'),
    FARMSLOT_CAPABILITY_STORE_FILE: path.join(root, '.runs/capabilities.json'),
    FARMSLOT_GATEWAY: `ws://127.0.0.1:${port}`,
    FARMSLOT_GATEWAY_TOKEN: randomUUID(),
    FARMSLOT_NATIVE_STATE_DIR: native.root,
    FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'legacy-env',
    FARMSLOT_GATEWAY_PASSWORD: '',
    FARMSLOT_UI_URL: `http://127.0.0.1:${uiPort}`,
    FARMSLOT_CDP_PORT: process.env.FARMSLOT_CDP_PORT ?? '19223',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(port),
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    FARMSLOT_DEMO_POOL: '0',
    NODE_TEST_CONTEXT: '1',
    TMUX: '',
    TMUX_TMPDIR: path.join(temporary, 'tmux'),
    TSX_TSCONFIG_PATH: path.join(source, 'services/gateway/tsconfig.json'),
  };
  if (process.argv.includes('--required-evidence')) {
    const primaryDir = path.join(root, 'checkout/tasks/required');
    const retainedDir = path.join(root, 'projects', project, 'tasks/required');
    const proofDir = path.join(retainedDir, 'artifacts/proof');
    const claim = 'The retained observation says gate-control-ready.';
    for (const directory of [primaryDir, retainedDir]) {
      writeJson(path.join(directory, 'inputs/handoff.json'), {
        task: { acceptanceCriteria: [claim] },
      });
      writeFileSync(path.join(directory, 'TASK.md'), '# Retained required-evidence control\n');
    }
    const recipeFile = path.join(temporary, 'required.recipe.json');
    const manifestFile = path.join(temporary, 'actions.json');
    writeJson(recipeFile, {
      $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
      title: 'Required state evidence',
      description: 'Read an actual retained observation and assert it.',
      proofTargets: [{ id: 'AC-1', claim, proofMode: 'state' }],
      workflow: {
        entry: 'observe',
        nodes: {
          observe: {
            action: 'command',
            cmd: 'printf gate-control-ready',
            intent: 'Read retained state',
            next: 'assert',
          },
          assert: {
            action: 'assert_output',
            source: 'observe',
            contains: 'gate-control-ready',
            proves: ['AC-1'],
            intent: 'Verify the observed value',
            next: 'done',
          },
          done: { action: 'end', status: 'pass' },
        },
      },
    });
    writeJson(manifestFile, {
      $schema: 'https://farmslot.io/schemas/action-manifest-v1.schema.json',
      actions: {
        command: {
          description: 'Read state.',
          schema: {
            type: 'object',
            properties: { cmd: { type: 'string' } },
            required: ['cmd'],
            additionalProperties: false,
          },
          examples: [{ action: 'command', cmd: 'true', intent: 'Read state', next: 'done' }],
        },
        assert_output: {
          description: 'Assert a retained observation.',
          schema: {
            type: 'object',
            properties: { source: { type: 'string' }, contains: { type: 'string' } },
            required: ['source', 'contains'],
            additionalProperties: false,
          },
          examples: [
            {
              action: 'assert_output',
              source: 'observe',
              contains: 'ready',
              intent: 'Check state',
              next: 'done',
            },
          ],
        },
        end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
      },
    });
    const recipeOutput = execFileSync(
      process.execPath,
      [
        path.join(source, 'packages/cli/bin/farmslot.mjs'),
        '--json',
        'recipe',
        'run',
        recipeFile,
        '--project-root',
        path.join(root, 'checkout'),
        '--action-manifest',
        manifestFile,
        '--artifacts-dir',
        proofDir,
        '--source-trust',
        'trusted',
        '--source-kind',
        'operator',
      ],
      {
        cwd: source,
        env: { ...env, TSX_TSCONFIG_PATH: path.join(source, 'packages/cli/tsconfig.json') },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    writeFileSync(path.join(out, 'required-recipe.json'), recipeOutput);
    const ledger = JSON.parse(readFileSync(path.join(proofDir, 'acceptance-status.json'), 'utf8'));
    assert.equal(ledger.criteria[0].verdict, 'proven');
    const require = createRequire(import.meta.url);
    const { setDerivedClaims } = require('@farmslot/agent-runtime/scripts/acceptance-ledger.cjs');
    setDerivedClaims(primaryDir, ledger);
    const { readRecordedEvidencePackage } = await import('@farmslot/adapter-sdk');
    const retainedInput = await readRecordedEvidencePackage(proofDir);
    assert.ok(retainedInput.checks.every((check) => check.status === 'pass'));
    const evidenceManifest = Object.entries(retainedInput.input.artifactDigests).map(
      ([file, sha256]) => ({ path: `artifacts/proof/${file}`, purpose: 'recipe-evidence', sha256 }),
    );
    const prepared: ReadyGatePrPackage = {
      id: 'required-package',
      artifactPath: 'artifacts/pr-package.json',
      branch: 'feature/gate-proof',
      headSha: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: path.join(root, 'checkout'),
        encoding: 'utf8',
      }).trim(),
      diffStat: { files: 0, additions: 0, deletions: 0 },
      draftTitle: 'Required proof',
      draftBody: 'Retained control',
      evidenceManifest,
      selectedEvidenceKeys: [],
      reviewArtifactIds: [],
      gatePolicy: {
        owner: 'human',
        publishAuthority: 'human',
        reason: 'Required-evidence recovery control',
      },
      reviewPolicy: { minimumReviews: 0, requestedBy: 'dispatch' as const },
      publicationTarget: 'ready',
      publicationStatus: 'not_published' as const,
      createdAt: now,
      packageHash: '',
    };
    prepared.packageHash = computeReadyGatePackageHash(prepared);
    if (process.argv.includes('--negative-control=closure')) {
      const file = path.join(proofDir, 'recipe-invocation.json');
      const invocation = JSON.parse(readFileSync(file, 'utf8'));
      writeJson(file, { ...invocation, params: { substituted: true } });
    }
    writeJson(path.join(retainedDir, prepared.artifactPath), prepared);
    const session = await native.ensureWorker(
      'legacy-env',
      {
        sessionId: randomUUID(),
        runner: 'claude',
        cwd: path.join(root, 'checkout'),
        model: 'sonnet',
      },
      { leaseId: randomUUID(), safetyTier: 'full-auto', environment: { set: {}, unset: [] } },
    );
    worker = {
      sessionId: session.id,
      executionNodeId: session.executionNodeId,
      ownerPrincipalId: session.ownerPrincipalId,
      generation: session.generation,
      leaseId: session.workerLeaseId!,
      commandId: randomUUID(),
      acceptedAt: now,
    };
    const target = {
      sessionId: worker.sessionId,
      generation: worker.generation!,
      leaseId: worker.leaseId,
    };
    await native.sendWorker(
      'legacy-env',
      target,
      worker.commandId,
      'Reply READY. Do not use tools or change files.',
    );
    await waitFor(
      async () =>
        (await native.readWorker('legacy-env', worker!.sessionId, worker!.leaseId)).session
          .state === 'idle',
      'real native task turn completes',
    );
    const commandId = randomUUID();
    const hold = `while [ ! -f '${releaseFile}' ]; do sleep 0.1; done`;
    await native.sendWorker(
      'legacy-env',
      target,
      commandId,
      `Use Bash once with timeout 300000 to run this exact command and wait for it to finish: ${hold}. Then reply DONE. Do not read or change any other file.`,
    );
    await waitFor(async () => {
      const snapshot = await native.readWorker('legacy-env', worker!.sessionId, worker!.leaseId);
      return (
        snapshot.session.state === 'running' &&
        snapshot.commands.some(
          (command) => command.commandId === commandId && command.accepted && !command.outcome,
        )
      );
    }, 'exact real native fix command accepted');
    const required: Run = {
      ...run,
      id: requiredRunId,
      familyId: randomUUID(),
      nativeOwnerPrincipalId: 'legacy-env',
      transport: 'native',
      ticketOrPr: 'GATE-REQUIRED',
      taskFile: path.join(retainedDir, 'TASK.md'),
      engineState: {
        generation: 1,
        publishGate: {
          packageId: prepared.id,
          packageHash: prepared.packageHash,
          packageArtifactPath: prepared.artifactPath,
        },
      },
      steps: FLOW_STEPS.dev.map((name, index) => ({
        name,
        status:
          name === 'human-gate'
            ? 'running'
            : index < FLOW_STEPS.dev.indexOf('human-gate')
              ? 'done'
              : 'pending',
      })),
      agentContexts: [
        {
          id: 'primary',
          role: 'primary',
          runId: requiredRunId,
          slotId,
          label: 'Worker',
          status: 'complete',
          taskFile: 'tasks/required/TASK.md',
          runner: 'claude',
          nativeSession: worker,
        },
        {
          id: 'review-fix',
          role: 'review-fix',
          runId: requiredRunId,
          slotId,
          label: 'Review fix',
          status: 'working',
          taskFile: 'tasks/required/TASK.md',
          runner: 'claude',
          nativeCommandId: commandId,
          nativeSessionOwner: {
            contextId: 'primary',
            sessionId: worker.sessionId,
            leaseId: worker.leaseId,
          },
        },
      ],
      decisions: [
        { ...run.decisions[0], id: 'required-gate', payload: { ...payload, prPackage: prepared } },
      ],
    };
    writeJson(path.join(root, '.runs', `${requiredRunId}.json`), required);
    cpSync(proofDir, path.join(out, 'required-evidence'), { recursive: true });
  }
  const control = process.argv.find((arg) => arg.startsWith('--negative-control='))?.split('=')[1];
  if (control && control !== 'closure') {
    const controls: Record<string, { file: string; pattern: string; replacement: string }> = {
      authority: {
        file: 'services/gateway/src/run-engine/gate-prerequisites.ts',
        pattern: 'const taskDir = path\\.posix\\.dirname\\(taskFile\\)',
        replacement: 'const taskDir = path.posix.dirname(run.taskFile)',
      },
      progress: {
        file: 'services/gateway/src/runners/run-progress.ts',
        pattern: String.raw`if \(progress\.kind === ['"]unproven['"]\) return ['"]reconciling['"]`,
        replacement: 'if (progress.kind === "unproven") return "blocked"',
      },
      restart: {
        file: 'services/gateway/src/methods/run.ts',
        pattern: String.raw`!\[['"]blocked['"],\s*['"]human-gating['"]\]\.includes\(afterResolve\.status\)`,
        replacement: '![' + '"blocked"' + '].includes(afterResolve.status)',
      },
      'stopped-native': {
        file: 'services/gateway/src/runners/run-progress.ts',
        pattern: String.raw`state === ['"]idle['"] \|\| nativeWorkerLiveStatus\(snapshot\) === ['"]idle['"]`,
        replacement: 'state === "idle"',
      },
      resolve: {
        file: 'services/gateway/src/methods/run.ts',
        pattern:
          'await \\(dependencies\\.assertGatePrerequisites \\?\\? assertRunGateReady\\)\\([\\s\\S]*?params\\.actionId,?\\s*\\);',
        replacement: 'void gatePayload;',
      },
    };
    const mutation = controls[control];
    assert.ok(mutation, 'unknown negative control');
    const loader = path.join(temporary, 'control.mjs');
    const marker = path.join(temporary, 'control-applied');
    writeFileSync(
      loader,
      `import assert from 'node:assert/strict';
      import {writeFileSync} from 'node:fs'; import {registerHooks} from 'node:module';
      const mutation = ${JSON.stringify(mutation)};
      registerHooks({load(url, context, nextLoad) {
        const result = nextLoad(url, context);
        if (!url.endsWith('/' + mutation.file)) return result;
        const before = String(result.source);
        const after = before.replace(new RegExp(mutation.pattern), mutation.replacement);
        assert.notEqual(before, after, 'negative control must change its target');
        writeFileSync(${JSON.stringify(marker)}, mutation.file);
        return {...result, source: after};
      }});`,
    );
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import ${loader}`;
  }
  gateway = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
    cwd: source,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gateway.stdout?.on('data', (data) => logs.push(String(data)));
  gateway.stderr?.on('data', (data) => logs.push(String(data)));
  await waitFor(async () => {
    assert.equal(gateway!.exitCode, null, 'gateway must remain alive');
    try {
      return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return false;
    }
  }, 'isolated gateway');
  const observed = readRun();
  const decision = observed.decisions.find((entry) => entry.id === 'gate-proof')!;
  assert.equal(decision.payload?.kind, 'ready');
  const readiness = (decision.payload as ReadyGatePayload).gateReadiness!;
  assert.ok(readiness.reasons.some((reason) => reason.code === 'acceptance-incomplete'));
  assert.equal(readiness.state, 'not-ready');
  assert.equal(observed.status, 'reconciling', 'unconfirmed worker cannot be labelled blocked');
  assert.ok(!decision.actions.some((action) => action.id === 'ready'));
  checks.push(
    'current 0/11 task overrides complete retained display ledger; unknown worker retains reconciling',
  );
  let refusal = '';
  try {
    helper(
      'gateway',
      'run.resolveDecision',
      JSON.stringify({ runId, decisionId: decision.id, actionId: 'ready' }),
    );
  } catch (error) {
    const failed = error as { stderr?: Buffer };
    refusal = failed.stderr?.toString() ?? String(error);
  }
  assert.match(refusal, /RUN_GATE_NOT_READY/);
  assert.equal(
    readRun().decisions.find((entry) => entry.id === decision.id)?.resolvedAt,
    undefined,
  );
  checks.push('direct RPC refusal is typed and leaves the decision pending');
  const simulator = process.env.FARMSLOT_GATE_PROOF_SIMULATOR;
  if (simulator) {
    const metroPort = await freePort();
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
          EXPO_PUBLIC_GATEWAY_URL: env.FARMSLOT_GATEWAY!,
          FARMSLOT_REMOTE_GATEWAY_URL: '',
          FARMSLOT_REMOTE_GATEWAY_TOKEN: '',
          EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE: '1',
        },
      },
    );
    metro.stdout?.on('data', (data) => logs.push(String(data)));
    metro.stderr?.on('data', (data) => logs.push(String(data)));
    const origin = `http://localhost:${metroPort}`;
    await waitFor(
      async () => {
        assert.equal(metro!.exitCode, null, 'isolated Metro must remain alive');
        try {
          return (await fetch(`${origin}/status`)).ok;
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          return false;
        }
      },
      'isolated Companion Metro',
      90_000,
    );
    interface NativeUiNode {
      AXLabel?: string;
      frame: { x: number; y: number; width: number; height: number };
    }
    const nativeTree = (): NativeUiNode[] =>
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
    const acceptOpenLink = () => {
      const nodes = nativeTree();
      if (nodes.some((node) => node.AXLabel?.startsWith('Open in'))) {
        const button = nodes.find((node) => node.AXLabel === 'Open');
        assert.ok(button, 'native link confirmation must offer Open');
        press(button);
      }
    };
    execFileSync('xcrun', ['simctl', 'launch', simulator, 'net.siteed.farmslot.development']);
    execFileSync('xcrun', [
      'simctl',
      'openurl',
      simulator,
      `farmslot-development://expo-development-client/?url=${encodeURIComponent(origin)}`,
    ]);
    await acceptOpenLink();
    await waitFor(
      async () => {
        const targets = await (await fetch(`${origin}/json/list`)).json();
        return Array.isArray(targets) && targets.length > 0;
      },
      'connected native Companion CDP',
      120_000,
    );
    const bridge = async (command: string, payload: Record<string, unknown>) => {
      const response = await fetch(`${origin}/farmslot-recipe/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, payload, nodeId: 'gate-native-proof', timeout_ms: 30_000 }),
      });
      const result = await response.json();
      assert.ok(isRecord(result), 'Native bridge must return an object');
      assert.equal(result.ok, true, JSON.stringify(result));
      return result;
    };
    assert.equal((await bridge('status', {})).platform, 'ios');
    await bridge('hud', {
      title: 'Gate prerequisites',
      intent: 'Show the gateway refusal and truthful Reconciling state.',
      status: 'running',
    });
    execFileSync('xcrun', ['simctl', 'openurl', simulator, `farmslot-development:///run/${runId}`]);
    await acceptOpenLink();
    let snapshot: NativeUiNode[] = [];
    await waitFor(() => {
      snapshot = nativeTree();
      const dismiss = snapshot.find((node) => node.AXLabel === 'Got it');
      if (dismiss) {
        press(dismiss);
        return false;
      }
      writeJson(path.join(out, 'companion-tree.json'), snapshot);
      execFileSync('xcrun', [
        'simctl',
        'io',
        simulator,
        'screenshot',
        path.join(out, 'companion-gate.png'),
      ]);
      return snapshot.some((node) => node.AXLabel?.includes('Reconciling'));
    }, 'native run renders gateway state');
    checks.push(
      'connected iOS Companion renders Reconciling from the disposable gateway, with the evidence HUD',
    );
    const gateTab = snapshot.find((node) => node.AXLabel === 'Run Detail: Gate tab');
    assert.ok(gateTab, 'native run detail must offer its Gate tab');
    press(gateTab);
    await bridge('hud', {
      intent: 'Show the gateway prerequisite refusal in the native Gate tab.',
      status: 'running',
    });
    await waitFor(() => {
      const report = nativeTree().find((node) => node.AXLabel === 'Open Prerequisites incomplete');
      if (!report) return false;
      press(report);
      return true;
    }, 'native prerequisite report opened');

    await waitFor(() => {
      const tree = nativeTree();
      writeJson(path.join(out, 'companion-gate-tree.json'), tree);
      execFileSync('xcrun', [
        'simctl',
        'io',
        simulator,
        'screenshot',
        path.join(out, 'companion-gate-reasons.png'),
      ]);
      return tree.some((node) => node.AXLabel?.includes('registered acceptance criteria'));
    }, 'native gate renders prerequisite reasons');
    checks.push('native Gate tab shows the gateway prerequisite refusal through real navigation');
  }
  if (process.argv.includes('--ui')) {
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
    ui.stdout?.on('data', (data) => logs.push(String(data)));
    ui.stderr?.on('data', (data) => logs.push(String(data)));
    await waitFor(async () => {
      try {
        return (await fetch(env.FARMSLOT_UI_URL!)).ok;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return false;
      }
    }, 'Command Center');
    route = `run/${runId}`;
    helper('goto', route, '--new');
    helper('login', route);
    if (
      helper(
        'eval',
        route,
        `return Boolean(document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('button.primary'));`,
      )
    )
      helper('click', route, 'whats-new-modal >>> button.primary');
    await waitFor(
      () =>
        Boolean(
          helper(
            'eval',
            route!,
            `
      const walk = (root) => [...root.querySelectorAll('*')].flatMap(el => [el.textContent, ...(el.shadowRoot ? walk(el.shadowRoot) : [])]);
      return walk(document).some(text => text?.includes('Prerequisites incomplete'));
    `,
          ),
        ),
      'gateway reasons rendered',
    );
    const rendering = helper(
      'eval',
      route,
      `
      const walk = (root) => [...root.querySelectorAll('*')].flatMap(el => [el.textContent, ...(el.shadowRoot ? walk(el.shadowRoot) : [])]);
      const text = walk(document).join(' ');
      return { incomplete: text.includes('Prerequisites incomplete'), registration: text.includes('registered acceptance criteria'), reconciling: text.includes('Reconciling') };
    `,
    ) as { incomplete: boolean; registration: boolean; reconciling: boolean };
    assert.deepEqual(rendering, { incomplete: true, registration: true, reconciling: true });
    helper('screenshot', route, path.join(out, 'command-center.png'));
    checks.push('real browser renders prerequisite reasons and Reconciling from gateway RPCs');
  }
  if (worker) {
    const readRequired = () =>
      (helper('gateway', 'run.get', JSON.stringify({ runId: requiredRunId })) as { run: Run }).run;
    const fixing = readRequired();
    assert.equal(fixing.status, 'fixing', 'an exact accepted active native command is fixing');
    assert.equal(
      (fixing.decisions[0].payload as ReadyGatePayload).gateReadiness?.state,
      'collecting',
    );
    checks.push('real accepted active native fix command stays Fixing and removes advancement');
    writeFileSync(releaseFile, 'finish');
    if (control === 'closure') {
      await waitFor(() => readRequired().status !== 'fixing', 'tampered closure settles');
      assert.equal(
        (readRequired().decisions[0].payload as ReadyGatePayload).gateReadiness?.state,
        'ready',
        'negative control: substituted frozen closure must fail this Ready assertion',
      );
    }
    await waitFor(
      () => readRequired().status === 'human-gating',
      'required evidence ready after actual turn completes',
    );
    const ready = readRequired();
    assert.equal((ready.decisions[0].payload as ReadyGatePayload).gateReadiness?.state, 'ready');
    assert.ok(ready.decisions[0].actions.some((action) => action.id === 'ready'));
    checks.push(
      'real recipe required claim plus frozen closure and idle native worker restore Ready',
    );
    writeJson(path.join(out, 'required-ready.json'), ready);
    await native.closeWorker('legacy-env', {
      sessionId: worker.sessionId,
      generation: worker.generation!,
      leaseId: worker.leaseId,
    });
    const stopped = helper(
      'gateway',
      'native.session.read',
      JSON.stringify({
        sessionId: worker.sessionId,
        executionNodeId: worker.executionNodeId,
        worker: {
          runId: requiredRunId,
          contextId: 'primary',
          generation: worker.generation,
          leaseId: worker.leaseId,
        },
      }),
    ) as { session: { state: string; processStopped: boolean } };
    assert.equal(stopped.session.state, 'closed');
    assert.equal(stopped.session.processStopped, true);
    assert.equal(
      readRequired().status,
      'human-gating',
      'confirmed stopped native worker is idle at a ready gate',
    );
    checks.push(
      'confirmed stopped native worker remains idle at its ready gate through real SDK/RPC state',
    );

    // A gateway restart drops its in-memory engine resolver. The retained ready
    // gate must still resolve through the real RPC and resume its gate step.
    await stop(gateway);
    gateway = spawn(process.execPath, ['--import', 'tsx', 'services/gateway/src/index.ts'], {
      cwd: source,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    gateway.stdout?.on('data', (data) => logs.push(String(data)));
    gateway.stderr?.on('data', (data) => logs.push(String(data)));
    await waitFor(async () => {
      try {
        return (await fetch(env.FARMSLOT_GATEWAY!.replace('ws:', 'http:') + '/health')).ok;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return false;
      }
    }, 'restarted gateway');
    assert.equal(readRequired().status, 'human-gating');
    helper(
      'gateway',
      'run.resolveDecision',
      JSON.stringify({ runId: requiredRunId, decisionId: 'required-gate', actionId: 'hold' }),
    );
    await waitFor(
      () =>
        readRequired().status === 'human-gating' &&
        readRequired().decisions.some(
          (decision) =>
            decision.id !== 'required-gate' &&
            !decision.resolvedAt &&
            decision.payload?.kind === 'ready',
        ),
      'lost engine resolver resumes into the gate',
    );
    checks.push(
      'human-gating survives gateway restart and Hold resumes into a new gate through RPC',
    );
    writeJson(path.join(out, 'required-restarted.json'), readRequired());
  }
  const hashes = Object.fromEntries(
    [
      'services/gateway/src/run-engine/gate-prerequisites.ts',
      'services/gateway/src/runners/run-progress.ts',
      'services/gateway/src/methods/run.ts',
      'apps/companion/src/lib/decision-presentation.ts',
      'apps/companion/src/components/RunPipeline.tsx',
      'scripts/runner-validation/gateway/run-gate-prerequisites.mts',
    ].map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(path.join(source, file)))
        .digest('hex'),
    ]),
  );
  writeJson(path.join(out, 'receipt.json'), {
    runId,
    checks,
    hashes,
    limits: [
      worker
        ? 'Recovered gate package seeded before startup; actual public recipe execution and real native accepted command. Companion native UI requires FARMSLOT_GATE_PROOF_SIMULATOR.'
        : 'Persisted task/recovery fixture; run --required-evidence for the real recipe/fix/restart control.',
      'Command Center screenshots are operator UI evidence and HUD-exempt.',
    ],
  });
  writeFileSync(path.join(out, 'gateway.log'), logs.join(''));
  console.log(JSON.stringify({ pass: true, runId, checks }));
} finally {
  try {
    if (route) helper('close', route);
  } finally {
    try {
      if (worker) {
        writeFileSync(releaseFile, 'finish');
        await native.closeWorker('legacy-env', {
          sessionId: worker.sessionId,
          generation: worker.generation!,
          leaseId: worker.leaseId,
        });
      }
    } finally {
      const cleanup = await Promise.allSettled([stop(metro), stop(ui), stop(gateway)]);
      const failed = cleanup.find((result) => result.status === 'rejected');
      const hostFile = path.join(native.root, 'host.json');
      if (existsSync(hostFile)) {
        const host = JSON.parse(readFileSync(hostFile, 'utf8'));
        if (matchesProcess(host.pid, native.root)) process.kill(host.pid, 'SIGTERM');
      }
      if (failed?.status === 'rejected') {
        writeFileSync(path.join(out, 'gateway.log'), logs.join(''));
        throw failed.reason;
      }
    }
    writeFileSync(path.join(out, 'gateway.log'), logs.join(''));
    rmSync(temporary, { recursive: true, force: true });
  }
}
