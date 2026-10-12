// Manual production-RPC proof. Persisted recovery inputs are seeded before startup.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ReadyGatePayload, Run } from '@farmslot/protocol';

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
let env: NodeJS.ProcessEnv;
let route: string | undefined;
const checks: string[] = [];
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
async function waitFor(read: () => Promise<boolean> | boolean, label: string) {
  const deadline = Date.now() + 30_000;
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
    prNumber: null,
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
  const control = process.argv.find((arg) => arg.startsWith('--negative-control='))?.split('=')[1];
  if (control) {
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
            route,
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
  const hashes = Object.fromEntries(
    [
      'services/gateway/src/run-engine/gate-prerequisites.ts',
      'services/gateway/src/runners/run-progress.ts',
      'services/gateway/src/methods/run.ts',
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
      'Persisted task/recovery fixture; no live fix turn or required-evidence positive control.',
      'Command Center screenshots are operator UI evidence and HUD-exempt.',
    ],
  });
  writeFileSync(path.join(out, 'gateway.log'), logs.join(''));
  console.log(JSON.stringify({ pass: true, runId, checks }));
} finally {
  try {
    if (route) helper('close', route);
  } finally {
    await stop(ui);
    await stop(gateway);
    writeFileSync(path.join(out, 'gateway.log'), logs.join(''));
    rmSync(temporary, { recursive: true, force: true });
  }
}
