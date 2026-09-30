import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT, shSingleQuote, sleepMs } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { installHooks } from '../lib/install.mjs';
import { ensureShellSession, killSession, sendShellScript, tmux } from '../lib/tmux.mjs';

export const SCENARIO_ID = 'warm-publication-review';

export async function runScenario({ runnerAdapter, outDir }) {
  assert.equal(runnerAdapter.RUNNER_ID, 'claude', 'Warm publication proof requires Claude');
  fs.mkdirSync(path.join(ROOT, 'temp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(ROOT, 'temp', 'warm-publication-proof-'));
  const repo = path.join(fixture, 'repo');
  const project = path.join(fixture, 'projects/warm-proof');
  const session = `warm-publication-proof-${process.pid}`;
  const write = (file, contents) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  for (const marker of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json'])
    write(path.join(fixture, marker), '');
  // Local node support and mark commands use the actual checkout's scripts.
  fs.rmSync(path.join(fixture, 'scripts'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(fixture, 'scripts'));
  fs.symlinkSync(path.join(ROOT, 'packages'), path.join(fixture, 'packages'));
  write(
    path.join(project, 'project.json'),
    JSON.stringify({
      name: 'warm-proof',
      task_dir: 'tasks',
      runtime_dir: '.agent',
      default_branch: 'refs/heads/main',
      ci: { repo: 'example/warm-proof' },
    }),
  );
  write(
    path.join(project, 'templates/prompts/worker-dispatch.md'),
    'Read {{TASK_FILE}} and execute its checklist. Do not edit source.',
  );
  write(
    path.join(project, 'templates/worker/self-review.static-code.md'),
    `# Static reviewer smoke

- [ ] 1. Read message.txt and confirm it contains hello.
- [ ] 2. Write artifacts/review-feedback.md with Verdict: pass, artifacts/review-result.rev-claude.json with {"schemaVersion":1,"verdict":"pass","issues":[]}, and artifacts/learnings.md with a short observation. Complete the reviewer-specific mark contract.

Remain idle after completing the checklist so the gateway can verify the native session binding.
`,
  );
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-b', 'main');
  write(path.join(repo, '.git/info/exclude'), 'tasks/\n.agent/\n.observability\n.omc/\n.omx/\n');
  write(path.join(repo, 'message.txt'), 'base\n');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'test: base fixture',
  );
  git('checkout', '-b', 'proof-change');
  write(path.join(repo, 'message.txt'), 'hello\n');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'test: change fixture',
  );
  write(path.join(repo, 'tasks/review/TASK.md'), '# Worker task\n\nInspect message.txt.\n');
  write(
    path.join(repo, 'tasks/review/CHECKLIST.md'),
    '# Worker checklist\n\n- [ ] 1. Inspect message.txt.\n',
  );
  write(
    path.join(repo, 'tasks/review/mark'),
    `#!/bin/bash
exec node '${ROOT}/packages/agent-runtime/scripts/mark-checklist-step.cjs' '${repo}/tasks/review' "$@"
`,
  );
  fs.chmodSync(path.join(repo, 'tasks/review/mark'), 0o700);
  write(
    path.join(repo, 'tasks/review/artifacts/pr-description.md'),
    '# Verify message\n\nThe fixture changes message.txt to hello.\n',
  );
  write(
    path.join(fixture, 'pool/local.json'),
    JSON.stringify({
      schema_version: 2,
      machine: os.hostname(),
      project: 'warm-proof',
      platform: 'macos',
      os: process.platform,
      host: 'localhost',
      ssh_user: os.userInfo().username,
      claude_path: runnerAdapter.binaryPath(),
      slots: [{ id: 'warm-proof-slot', enabled: true, repo, session, resources: {} }],
    }),
  );
  const env = {
    ...process.env,
    FARMSLOT_ROOT: fixture,
    FARMSLOT_POOL_DIR: path.join(fixture, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(fixture, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(fixture, '.runs'),
    FARMSLOT_HOME: path.join(fixture, 'home'),
    NODE_TEST_CONTEXT: '1',
    FARMSLOT_WARM_PROOF_GATEWAY: '1',
    FARMSLOT_DISABLE_ORCHESTRATION: '1',
    FARMSLOT_GATEWAY_AUTH_MODE: 'none',
    FARMSLOT_GATEWAY_TOKEN: '',
    FARMSLOT_GATEWAY_PASSWORD: '',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: process.env.FARMSLOT_WARM_PROOF_PORT ?? '7813',
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    TSX_TSCONFIG_PATH: path.join(ROOT, 'services/gateway/tsconfig.json'),
  };
  execFileSync('git', ['init', '-b', 'main'], { cwd: fixture, stdio: 'pipe' });
  execFileSync('git', ['add', 'CLAUDE.md', 'services/gateway/package.json'], {
    cwd: fixture,
    stdio: 'pipe',
  });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'test: initialize fixture gateway',
    ],
    { cwd: fixture, stdio: 'pipe' },
  );
  try {
    ensureShellSession(session, repo);
    installHooks('claude', repo, '.agent', 'warm-proof-slot');
    const bootstrapPane = tmux([
      'new-window',
      '-d',
      '-t',
      session,
      '-n',
      'rev-claude',
      '-P',
      '-F',
      '#{pane_id}',
      '-c',
      repo,
      'bash',
      '--noprofile',
      '--norc',
    ]);
    sleepMs(500);
    sendShellScript(bootstrapPane, repo, [
      `DISABLE_OMC=1 DISABLE_OMX=1 ${shSingleQuote(runnerAdapter.binaryPath())} --dangerously-skip-permissions --model opus --settings ${shSingleQuote(path.join(repo, '.agent/.observability/claude-settings.json'))} 'Reply exactly READY and remain available for another task.'`,
    ]);
    const bootstrapState = path.join(
      repo,
      '.agent/.observability/panes',
      `${encodeURIComponent(bootstrapPane)}.json`,
    );
    const bootstrapDeadline = Date.now() + 90_000;
    let bootstrapCompleted = false;
    while (Date.now() < bootstrapDeadline) {
      if (fs.existsSync(bootstrapState)) {
        const state = JSON.parse(fs.readFileSync(bootstrapState));
        if (
          state.hook_event_name === 'Stop' &&
          state.transcript_path &&
          fs.existsSync(state.transcript_path)
        ) {
          bootstrapCompleted = true;
          break;
        }
      }
      sleepMs(500);
    }
    assert.ok(
      bootstrapCompleted,
      'Bootstrap runner must finish a real turn before publication review',
    );
    const driver = path.join(ROOT, 'scripts/runner-validation/gateway/warm-publication-review.mts');
    const execute = (phase, extraEnv = {}) => {
      const logFile = path.join(fixture, `${phase}.log`);
      const logFd = fs.openSync(logFile, 'w', 0o600);
      try {
        execFileSync(process.execPath, ['--import', 'tsx', driver, phase, fixture], {
          cwd: ROOT,
          env: { ...env, ...extraEnv },
          stdio: ['ignore', logFd, logFd],
          timeout: 600_000,
        });
        return fs.readFileSync(logFile);
      } catch (error) {
        error.stdout = fs.readFileSync(logFile);
        throw error;
      } finally {
        fs.closeSync(logFd);
      }
    };
    console.log(JSON.stringify({ fixture, session, port: env.GATEWAY_PORT }));
    process.stdout.write(execute('first'));
    const runId = fs.readFileSync(path.join(fixture, 'run-id'), 'utf8');
    const runFile = path.join(fixture, '.runs', `${runId}.json`);
    const priorRun = fs.readFileSync(runFile);
    const reviewModule = path.join(ROOT, 'services/gateway/src/self-review/review-agent.ts');
    const original = fs.readFileSync(reviewModule, 'utf8');
    const integration = 'warmSession = persistedWarmReviewerSession(warmScope, parentRunForAlloc);';
    assert.ok(original.includes(integration));
    // Mutate a private module copy so the operator gateway is never restarted for the negative proof.
    const mutatedPath = path.join(fixture, 'mutated-review-agent.mts');
    const mutated = original
      .replace(integration, 'warmSession = null;')
      .replace(
        /(from\s+|import\()(['"])(\.[^'"]+)\2/g,
        (match, prefix, quote, relative) =>
          `${prefix}${quote}${pathToFileURL(path.resolve(path.dirname(reviewModule), relative))}${quote}`,
      );
    fs.writeFileSync(mutatedPath, mutated);
    let negativeFailed = false;
    try {
      execute('negative', { FARMSLOT_WARM_PROOF_REVIEW_MODULE: pathToFileURL(mutatedPath).href });
    } catch (error) {
      assert.ok(error.status, 'Negative proof must fail its assertion, not time out');
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      assert.match(output, /Explicit warm publication review must reuse the persisted session/);
      fs.writeFileSync(path.join(fixture, 'negative.log'), output);
      negativeFailed = true;
    }
    assert.ok(negativeFailed, 'Disabling production recovery must break this proof');
    // Retire only the fixture reviewer and restore the completed first generation before positive replay.
    const negativeRun = JSON.parse(fs.readFileSync(runFile));
    const reviewer = negativeRun.agentContexts.find((context) => context.role === 'self-review');
    if (reviewer?.target?.target)
      execFileSync('tmux', ['kill-window', '-t', reviewer.target.target]);
    fs.writeFileSync(runFile, priorRun);
    process.stdout.write(execute('second'));
    const first = JSON.parse(fs.readFileSync(path.join(fixture, 'first.json')));
    const second = JSON.parse(fs.readFileSync(path.join(fixture, 'second.json')));
    assert.notEqual(first.gatewayPid, second.gatewayPid);
    assert.equal(first.sessionId, second.sessionId);
    const report = {
      pass: true,
      fixture,
      sessionId: second.sessionId,
      gatewayRestarted: true,
      disabledRecoveryRejected: negativeFailed,
    };
    const outPath = writeEvidence(report, SCENARIO_ID, 'claude', outDir);
    return { scenario: SCENARIO_ID, runner: 'claude', outPath, pass: true, report };
  } finally {
    killSession(session);
  }
}
