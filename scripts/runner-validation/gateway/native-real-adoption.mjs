import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  buildHandoffMetadata,
  builtinTerminalContract,
  ensureTaskRuntime,
} from '@farmslot/agent-runtime';
import { DEFAULT_DEV_INTERACTIVE_PROFILE, FLOW_STEPS, Methods } from '@farmslot/protocol';

const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function realRunnerEnvironment(configDir, credentialFile) {
  const environment = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_OMC: '1',
    DISABLE_OMX: '1',
  };
  delete environment.CLAUDECODE;
  const authKeys = [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
  ];
  const settings = path.join(path.dirname(credentialFile), 'settings.json');
  if (existsSync(settings)) {
    const values = JSON.parse(readFileSync(settings, 'utf8')).env ?? {};
    for (const key of authKeys)
      if (!environment[key] && typeof values[key] === 'string') environment[key] = values[key];
  }
  if (
    !authKeys.slice(0, 2).some((key) => environment[key]) &&
    !environment.CLAUDE_CODE_OAUTH_TOKEN &&
    (existsSync(credentialFile) || process.platform === 'darwin')
  ) {
    let oauth = existsSync(credentialFile)
      ? JSON.parse(readFileSync(credentialFile, 'utf8')).claudeAiOauth
      : undefined;
    if (!oauth && process.platform === 'darwin') {
      const stored = execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      oauth = JSON.parse(stored).claudeAiOauth;
    }
    assert.ok(
      oauth?.accessToken &&
        Number.isFinite(oauth.expiresAt) &&
        oauth.expiresAt > Date.now() + 120000,
      'Real proof needs a currently valid sign-in',
    );
    environment.CLAUDE_CODE_OAUTH_TOKEN = oauth.accessToken;
  }
  return environment;
}

/** Explicit opt-in proof. Authentication stays in the child environment. */
export async function prepareRealAdoption({
  temporary,
  root,
  project,
  sourceRoot,
  gitInit,
  writeJson,
}) {
  assert.ok(
    existsSync(path.join(temporary, '.coherence-fixture')),
    'Real proof requires a disposable fixture marker',
  );
  const cli = realpathSync(execFileSync('which', ['claude'], { encoding: 'utf8' }).trim());
  const repo = path.join(temporary, 'real-repo');
  gitInit(repo);
  const configDir = path.join(temporary, 'real-config');
  mkdirSync(configDir, { mode: 0o700 });
  const resumeReceipt = path.join(temporary, 'real-resume-receipt.json');
  const hook = path.join(temporary, 'real-session-start.cjs');
  writeFileSync(
    hook,
    `const fs=require('node:fs');let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const event=JSON.parse(input);fs.writeFileSync(${JSON.stringify(resumeReceipt)},JSON.stringify({sessionId:event.session_id,transcriptPath:event.transcript_path,cwd:event.cwd,source:event.source}),{mode:0o600});});`,
  );
  writeJson(path.join(configDir, 'settings.json'), {
    enabledPlugins: {},
    hooks: {
      SessionStart: [
        { matcher: 'resume', hooks: [{ type: 'command', command: `node ${quote(hook)}` }] },
      ],
    },
  });
  const credentialFile = path.join(
    process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'),
    '.credentials.json',
  );
  const conversation = randomUUID();
  const environment = realRunnerEnvironment(configDir, credentialFile);
  const seeded = JSON.parse(
    execFileSync(
      cli,
      [
        '--print',
        '--session-id',
        conversation,
        '--model',
        'sonnet',
        '--tools',
        '',
        '--output-format',
        'json',
        'Reply coherence-ready. Do not call tools.',
      ],
      {
        cwd: repo,
        env: environment,
        encoding: 'utf8',
        timeout: 180000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ),
  );
  assert.equal(seeded.is_error, false, 'The real runner must initialize successfully');
  assert.equal(seeded.session_id, conversation);
  const transcript = readdirSync(path.join(configDir, 'projects'), { recursive: true }).find(
    (file) => path.basename(file) === `${conversation}.jsonl`,
  );
  assert.ok(transcript, 'The real runner must persist its conversation');
  const sessionPath = path.join(configDir, 'projects', transcript);
  writeJson(path.join(configDir, '.claude.json'), {
    hasCompletedOnboarding: true,
    projects: { [repo]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  });
  const runId = randomUUID();
  const slotId = `coherence-real-${randomUUID()}`;
  const session = `coherence-real-worker-${randomUUID()}`;
  const taskDir = path.join(repo, '.task/dev/COHERENCE-REAL');
  mkdirSync(taskDir, { recursive: true });
  const taskFile = path.join(taskDir, 'TASK.md');
  writeFileSync(
    taskFile,
    '# Observe a saved conversation\nRead-only task. Completion is recorded by the proof operator.\n',
  );
  const terminalContract = builtinTerminalContract('dev');
  await ensureTaskRuntime({
    taskDir,
    checklistMarkdown: null,
    terminalContract,
    handoff: buildHandoffMetadata({
      attemptId: runId,
      surface: 'fixture',
      project,
      flow: 'dev',
      title: 'Real saved conversation',
      sourceKind: 'text',
      acceptanceCriteria: [],
      terminalContract,
    }),
    markCommand: `node ${quote(path.join(sourceRoot, 'packages/agent-runtime/scripts/mark-checklist-step.cjs'))}`,
  });
  const now = new Date().toISOString();
  writeJson(path.join(root, '.runs', `${runId}.json`), {
    id: runId,
    project,
    ticketOrPr: 'COHERENCE-REAL',
    flowType: 'dev',
    mode: 'interactive',
    transport: 'tmux',
    safetyTier: 'full-auto',
    status: 'paused',
    devInteractiveProfile: DEFAULT_DEV_INTERACTIVE_PROFILE,
    slotId,
    taskFile,
    createdAt: now,
    updatedAt: now,
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'claude', model: 'sonnet' },
    steps: FLOW_STEPS.dev.map((name, index) => ({
      name,
      status:
        name === 'monitor'
          ? 'running'
          : index < FLOW_STEPS.dev.indexOf('monitor')
            ? 'done'
            : 'pending',
    })),
    agentContexts: [
      {
        id: 'dev',
        runId,
        label: 'Developer',
        role: 'dev',
        status: 'waiting',
        slotId,
        taskFile,
        signalFile: path.join(taskDir, 'SIGNAL.json'),
        runner: 'claude',
        model: 'sonnet',
        runnerSessionId: conversation,
        runnerSessionPath: sessionPath,
        startedAt: now,
        target: null,
      },
    ],
  });
  const launch = path.join(temporary, 'launch-real-worker.mjs');
  const moduleUrl = new URL('./native-real-adoption.mjs', import.meta.url).href;
  writeFileSync(
    launch,
    `import {spawn} from 'node:child_process';import {realRunnerEnvironment} from ${JSON.stringify(moduleUrl)};const child=spawn(${JSON.stringify(cli)},['--resume',${JSON.stringify(conversation)},'--permission-mode','plan'],{cwd:${JSON.stringify(repo)},stdio:'inherit',env:realRunnerEnvironment(${JSON.stringify(configDir)},${JSON.stringify(credentialFile)})});child.on('error',error=>{throw error});child.on('exit',code=>process.exit(code??1));`,
    { mode: 0o600 },
  );
  return {
    cli,
    repo,
    slotId,
    runId,
    session,
    taskDir,
    conversation,
    sessionPath,
    launch,
    resumeReceipt,
  };
}

export async function proveRealAdoption({ fixture, rpc, wait, check }) {
  execFileSync('tmux', [
    'new-session',
    '-d',
    '-s',
    fixture.session,
    '-c',
    fixture.repo,
    `node ${quote(fixture.launch)}`,
  ]);
  await wait(() => existsSync(fixture.resumeReceipt), Boolean, 'real runner resume hook');
  const resume = JSON.parse(readFileSync(fixture.resumeReceipt, 'utf8'));
  assert.equal(resume.source, 'resume');
  assert.equal(resume.sessionId, fixture.conversation);
  assert.equal(realpathSync(resume.transcriptPath), realpathSync(fixture.sessionPath));
  assert.equal(realpathSync(resume.cwd), fixture.repo);
  let adopted;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      adopted = rpc('run.adopt', { runId: fixture.runId, tmux: fixture.session });
      break;
    } catch (error) {
      if (
        !/Adoption requires one live worker for the saved conversation; found 0|Tmux adoption target is unavailable/i.test(
          error.message,
        )
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  assert.ok(adopted, 'The real saved conversation must be adopted');
  const context = adopted.run.agentContexts.find((candidate) => candidate.id === 'dev');
  assert.equal(context.runnerSessionId, fixture.conversation);
  assert.equal(context.runnerSessionPath, fixture.sessionPath);
  assert.ok(context.adoptedAt);
  check('real resumed conversation adopts through the production gateway');
  mkdirSync(path.join(fixture.taskDir, 'artifacts'), { recursive: true });
  for (const name of ['learnings.md', 'pr-description.md'])
    writeFileSync(
      path.join(fixture.taskDir, 'artifacts', name),
      '# Read-only conversation proof\nThe isolated operator recorded task completion.\n',
    );
  for (const args of [['start'], ['complete', '--mark-last']])
    execFileSync(path.join(fixture.taskDir, 'mark'), args, {
      cwd: fixture.repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  await wait(
    () => rpc('run.get', { runId: fixture.runId }).run,
    (run) => run.steps.some((step) => step.outputs?.awaitingOperator),
    'real adopted worker monitored completion',
  );
  assert.equal(
    rpc(Methods.RUN_INTERACTIVE_DEV_RESOLVE, {
      runId: fixture.runId,
      action: 'done-no-pr',
      reason: 'Read-only conversation proof',
    }).ok,
    true,
  );
  assert.equal(rpc('run.get', { runId: fixture.runId }).run.status, 'done');
  execFileSync('tmux', ['has-session', '-t', `=${fixture.session}`]);
  check('real adopted worker closes without destroying its operator session');
}
