// Project packs, seed repositories and workers for the canary.
//
// `farmslot-canary` is the demo project the live canary uses (setup.mts writes it into a farm):
// no app, a tiny repo, the scripted runner only. Its repo ships the fake runner a scripted
// scenario launches from the slot checkout. The isolated stack uses the same pack and repo.
//
// `ri-pipe` and `ri-review` drive the isolated restart matrix. `ri-pipe` runs the whole dev
// pipeline with the scripted worker and no reviewer. `ri-review` has the pipeline REVIEW on
// (codex): its scripted worker commits a two-file change, one file a leftover debug helper the
// reviewer should flag. When the engine relaunches the worker for the review-fix round, the same
// command marks the fix task started, removes that file, commits and marks it complete. Workers
// hold while their marker exists under the stack's holds/ directory. fakePi is a Pi-runner worker
// with no model, for the case where its model stream drops while it stays alive. fakeClaude is a
// Claude-runner worker with no model, for a runner that takes its task after launch.
import type { ProjectPack } from '../lib/remote-node-stack.mjs';

export const CANARY_PROJECT = 'farmslot-canary';
export const PIPE_PROJECT = 'ri-pipe';
export const REVIEW_PROJECT = 'ri-review';
export const REVIEWER = { runner: 'codex', model: 'gpt-6-luna', effort: 'low' } as const;

export const SEED: Record<string, string> = {
  'README.md': '# Restart invariant fixture\n\nA tiny repository the isolated slots clone.\n',
  'src/index.ts': "export const fixture = 'restart-invariant';\n",
  '.gitignore': '.task/\n.agent/\n',
};

// What `node "$PWD/packages/cli/bin/farmslot.mjs" scripted-runner …` runs in a canary slot: wait
// the scenario's step delay (MONITOR must see a live runner), write the reports a dev run hands
// over, and signal complete. No model, no code change.
const FAKE_RUNNER = `#!/usr/bin/env node
// Farmslot canary fake runner: the slot checkout's "CLI" for a scripted scenario. No model.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(\`--\${name}\`);
  return index >= 0 ? args[index + 1] : fallback;
};
if (args[0] !== 'scripted-runner' || value('scenario', 'success') !== 'success') {
  console.error('canary fake runner: only "scripted-runner --scenario success" is supported');
  process.exit(2);
}
const taskDir = path.resolve(value('task-dir'));
const artifacts = path.join(taskDir, 'artifacts');
mkdirSync(artifacts, { recursive: true });
setTimeout(() => {
  writeFileSync(path.join(artifacts, 'pr-description.md'), '# Canary\\n\\nScripted canary run; no code change.\\n');
  writeFileSync(path.join(artifacts, 'learnings.md'), '# Learnings\\n\\n- Canary run.\\n');
  writeFileSync(path.join(artifacts, 'report.md'), '# Canary report\\n\\n- Status: complete\\n');
  const signal = {
    status: 'complete',
    outcome: 'success',
    disposition: 'fixed',
    reason: 'canary scripted run',
    evidence: { reportPath: 'artifacts/report.md', artifacts: [] },
    timestamp: new Date().toISOString(),
  };
  writeFileSync(path.join(taskDir, 'SIGNAL.json'), \`\${JSON.stringify(signal, null, 2)}\\n\`);
}, Number(value('step-delay-ms', '8000')));
`;

/** The canary slot repo: committed in each canary slot's origin. */
export const CANARY_REPO: Record<string, string> = {
  'README.md':
    '# Farmslot canary\n\nThe post-deploy canary runs scripted runs here. Nothing else.\n',
  '.gitignore': '.task/\n.agent/\n',
  'packages/cli/bin/farmslot.mjs': FAKE_RUNNER,
};

export const CANARY_TAGS = ['canary'];

/**
 * An interactive dev run with the reviewed profile (HUMAN_GATE prepares a package and presents a
 * card) on `worker`, no code change, so the gate offers to close it as shipped, which goes through
 * FINALIZE without GitHub.
 */
const lifecycleRunParams = (
  project: string,
  slotId: string,
  ticketOrPr: string,
  initialContext: string,
  worker: Record<string, unknown>,
): Record<string, unknown> => ({
  project,
  flowType: 'dev',
  mode: 'interactive',
  devInteractiveProfile: 'reviewed',
  ticketOrPr,
  initialContext,
  slotId,
  transport: 'tmux',
  ...worker,
});

/** A canary lifecycle run: the scripted runner on the canary project. */
export const canaryRunParams = (slotId: string, label: string): Record<string, unknown> =>
  lifecycleRunParams(
    CANARY_PROJECT,
    slotId,
    `canary ${label}`,
    'Post-deploy canary: a scripted run through the whole lifecycle. No code change.',
    {
      runner: 'scripted',
      model: 'scripted',
      scripted: { mode: 'scenario', scenario: 'success', stepDelayMs: 8000 },
      tags: CANARY_TAGS,
    },
  );

/** The restart matrix's pipeline: the same lifecycle, with a worker that can hold (slotCli). */
export const pipeRunParams = (slotId: string): Record<string, unknown> =>
  lifecycleRunParams(
    PIPE_PROJECT,
    slotId,
    'restart invariant pipeline',
    'Scripted restart-invariant run; the worker changes nothing.',
    {
      runner: 'scripted',
      model: 'scripted',
      // The slot's CLI turns the scenario launch into the project's `work` command (slotCli).
      scripted: { mode: 'scenario', scenario: 'success' },
    },
  );

/** The same pipeline with a Pi-runner worker: the fixture's `pi` (fakePi), no model. */
export const piRunParams = (slotId: string): Record<string, unknown> =>
  lifecycleRunParams(
    PIPE_PROJECT,
    slotId,
    'restart invariant pi worker',
    'Restart-invariant run with a Pi-runner worker that calls no model.',
    { runner: 'pi', model: 'scripted' },
  );

/** The same pipeline with a Claude-runner worker: the fixture's `claude` (fakeClaude), no model. */
export const claudeRunParams = (slotId: string): Record<string, unknown> =>
  lifecycleRunParams(
    PIPE_PROJECT,
    slotId,
    'restart invariant claude worker',
    'Restart-invariant run with a Claude-runner worker that calls no model.',
    { runner: 'claude', model: 'haiku' },
  );

/**
 * A validation dev run (never a publication candidate) whose REVIEW runs codex. Artifact-only, so
 * an output-review card is open while the fix round runs (#1724's case).
 */
export const reviewRunParams = (slotId: string): Record<string, unknown> => ({
  project: REVIEW_PROJECT,
  flowType: 'dev',
  mode: 'validation',
  // A Jira-shaped key passes dev ticket validation; ticketData means nothing is fetched. One per
  // run: a second run on the same ticket raises a collision decision.
  ticketOrPr: `RI-${slotId.replace(/^.*-/, '')}`,
  ticketData: {
    source: 'manual',
    ...REVIEW_TICKET,
    acceptanceCriteria: [],
    affectedArea: 'src',
    stepsToReproduce: [],
    screenshots: [],
    labels: [],
  },
  slotId,
  runner: 'scripted',
  model: 'scripted',
  transport: 'tmux',
  scripted: { mode: 'scenario', scenario: 'success' },
  completionPolicy: 'artifact-only',
  reviewMode: 'cold',
  reviewValidationDepth: 'static-code',
  reviewSequence: [{ ...REVIEWER, mode: 'cold' }],
});

/** The same reviewed run with a Claude-runner worker: the fixture's `claude` (fakeClaude), no model. */
export const claudeReviewRunParams = (slotId: string): Record<string, unknown> => ({
  ...reviewRunParams(slotId),
  runner: 'claude',
  model: 'haiku',
  scripted: undefined,
});

/** A pack: what every project here shares, plus its own `project.json` fields and files. */
function buildPack(
  name: string,
  options: {
    title: string;
    devStep: string;
    dispatchPrompt: string;
    projectJson: Record<string, unknown>;
    files?: Record<string, string>;
  },
): ProjectPack {
  return {
    name,
    projectJson: {
      // Pack portability requires a QA flow even though these runs never use one.
      qa: {
        default_profile: 'changes',
        profiles: [{ id: 'changes', title: 'Validate changes', template_id: 'validation/shared' }],
      },
      paths: { runtime_dir: '.agent', artifact_dir: '.task' },
      execution_templates: {
        sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
      },
      ...options.projectJson,
    },
    files: {
      'shared/dev/shared.md': `---\nplatforms: [cli]\n---\n\n# ${options.title} development\n\n- [ ] ${options.devStep}\n`,
      'shared/validation/shared.md': `---\nplatforms: [cli]\n---\n\n# ${options.title} validation\n\n- [ ] Validate the change.\n`,
      'templates/prompts/worker-dispatch.md': `${options.dispatchPrompt}\n`,
      'templates/prompts/worker-nudge.md': 'Continue {{TASK_FILE}}.\n',
      ...options.files,
    },
  };
}

/** The canary demo project, for a repo at `origin`. */
export const canaryPack = (origin: string): ProjectPack =>
  buildPack(CANARY_PROJECT, {
    title: 'Canary',
    devStep: 'Run the scripted canary scenario.',
    dispatchPrompt: 'Read {{TASK_FILE}} and follow it.',
    projectJson: {
      repo_url: origin,
      default_branch: 'main',
      review: { enabled: false },
      monitoring: { poll_interval_min: 0.02, total_timeout_min: 15 },
    },
  });

export const REVIEW_TICKET = {
  title: 'Add a name formatter',
  description:
    'Add src/format-name.ts exporting formatName(first, last): both names trimmed, joined by one space. The repository has no build or tests, and none are required for this change.',
};

const FORMAT_NAME = [
  'export function formatName(first: string, last: string): string {',
  '  return `${first.trim()} ${last.trim()}`.trim();',
  '}',
].join('\n');
const LEFTOVER = [
  '// Temporary debugging helper, remove before merge.',
  'export function debugTrace(value: unknown): unknown {',
  '  debugger;',
  "  console.log('debug trace', JSON.stringify(value));",
  '  return value;',
  '}',
].join('\n');

/** Waits while `holds/<name>` exists (15 min ceiling) after recording `<name>.hit`. */
const holdFunction = (holds: string) =>
  [
    `hold() { [ -e '${holds}'/"$1" ] || return 0; date -u +%FT%TZ > '${holds}'/"$1".hit; i=0; while [ -e '${holds}'/"$1" ] && [ $i -lt 9000 ]; do sleep 0.1; i=$((i+1)); done; }`,
    // DISPATCH confirms the launch by seeing the runner alive, so the worker stays up until the
    // test sees MONITOR watching it (holds/monitoring), for at most 5 min.
    `i=0; until [ -e '${holds}/monitoring' ] || [ $i -ge 3000 ]; do sleep 0.1; i=$((i+1)); done`,
  ].join('\n');

const reports = (summary: string) =>
  [
    `printf '# Restart invariant\\n\\n${summary}\\n' > "$FARMSLOT_TASK_DIR/artifacts/pr-description.md"`,
    `printf '# Learnings\\n\\n- Scripted restart-invariant worker.\\n' > "$FARMSLOT_TASK_DIR/artifacts/learnings.md"`,
  ].join('\n');

function pipeWorker(holds: string): string {
  return [
    'set -e',
    holdFunction(holds),
    'hold worker',
    reports('Scripted worker; no code change.'),
  ].join('\n');
}

function reviewWorker(holds: string): string {
  return [
    'set -e',
    holdFunction(holds),
    'task="$FARMSLOT_TASK_DIR"',
    'mark() { "$task/mark" --checklist REVIEW-FIX.md --signal REVIEW-FIX-SIGNAL.json "$@"; }',
    'if [ -e "$task/artifacts/pr-description.md" ]; then',
    // The relaunch for the review-fix round: the engine writes REVIEW-FIX.md after relaunching.
    '  i=0; until [ -e "$task/REVIEW-FIX.md" ] || [ $i -ge 6000 ]; do sleep 0.1; i=$((i+1)); done',
    '  mark start',
    '  git rm -q src/debug-trace.ts',
    '  git commit -qm "fix: remove the leftover debug helper"',
    `  printf '# Restart invariant\\n\\nAdds formatName in src/format-name.ts. A debug helper the first commit added is removed by the second, so the net change is that one file.\\n' > "$task/artifacts/pr-description.md"`,
    '  steps=$(grep -c "^- \\[ \\]" "$task/REVIEW-FIX.md" || true)',
    '  k=1; while [ "$k" -lt "${steps:-1}" ]; do mark "$k"; k=$((k+1)); done',
    // Held with the fix round live (its signal reads running) until the test lets it finish.
    '  hold fix',
    '  mark complete --mark-last',
    '  exit 0',
    'fi',
    'hold worker',
    'mkdir -p src',
    `cat > src/format-name.ts <<'EOF'\n${FORMAT_NAME}\nEOF`,
    `cat > src/debug-trace.ts <<'EOF'\n${LEFTOVER}\nEOF`,
    'git add src',
    'git commit -qm "feat: add formatName"',
    reports('Adds formatName in src/format-name.ts.'),
    // Without a manifest the reviewer may flag its absence in one loop and not the next, which
    // would make the verdicts, not the restarts, decide the outcome.
    `printf '%s\\n' '{"version":1,"summary":"A library function only: no screenshots or recordings apply.","before_after_pairs":[],"standalone":[]}' > "$FARMSLOT_TASK_DIR/artifacts/evidence-manifest.json"`,
  ].join('\n');
}

const REVIEW_TEMPLATE = `# Worker: Review

> Checklist marker: run \`{{TASK_DIR}}/mark --checklist {{REVIEW_CHECKLIST}} --signal {{REVIEW_SIGNAL}} start\` once, then \`{{TASK_DIR}}/mark --checklist {{REVIEW_CHECKLIST}} --signal {{REVIEW_SIGNAL}} N\`
> after each checklist item. Finish with \`{{TASK_DIR}}/mark --checklist {{REVIEW_CHECKLIST}} --signal {{REVIEW_SIGNAL}} complete --mark-last\`.

## Task

\`\`\`
TASK_DIR: {{TASK_DIR}}
REPO: {{REPO}}
TICKET: {{TICKET}}
VALIDATION_DEPTH: {{VALIDATION_DEPTH}}
\`\`\`

## Checklist

- [ ] **1. Start** - run the marker with \`start\`, then \`1\`.
- [ ] **2. Inspect the change**:
  \`\`\`bash
  cd {{REPO}}
  git diff main...HEAD --stat
  git diff main...HEAD
  cat {{TASK_DIR}}/artifacts/pr-description.md
  \`\`\`
- [ ] **3. Judge the change** against the ticket: correctness, minimality, and leftover debugging code. The repository has no build or tests; do not run any.
- [ ] **4. Write \`{{TASK_DIR}}/{{REVIEW_FEEDBACK}}\`**:
  \`\`\`markdown
  # Review: {{TICKET}}

  ## Verdict: PASS

  ## Summary
  <one or two sentences>

  ## Issues
  - <blocker or major findings only, file:line; empty for PASS>

  ## Follow-ups
  - <minor findings and nits>
  \`\`\`
  Use \`## Verdict: ISSUES\` when a blocker or major finding remains. Minor findings are follow-ups and never block: with no blocker or major finding, the verdict is PASS.
- [ ] **5. Complete** - run the marker with \`complete --mark-last\`.
`;

const REVIEW_FIX_TEMPLATE = `# Worker: Review fix

> Checklist marker: \`{{TASK_DIR}}/mark --checklist REVIEW-FIX.md --signal REVIEW-FIX-SIGNAL.json start\`, then \`N\` after each item, then \`complete --mark-last\`.

## Issues

{{ISSUES}}

## Checklist

- [ ] **1. Start** - run the marker with \`start\`, then \`1\`.
- [ ] **2. Fix each issue** and commit: \`git add -A && git commit -m "fix: address review findings"\`.
- [ ] **3. Complete** - run the marker with \`complete --mark-last\`.
`;

const pack = (name: string, holds: string, review: boolean): ProjectPack =>
  buildPack(name, {
    title: 'Restart invariant',
    devStep: 'Run the configured scripted command.',
    dispatchPrompt:
      'Read {{TASK_FILE}} and follow it. After each checklist step, run {{TASK_DIR}}/mark N.',
    projectJson: {
      review: {
        enabled: review,
        ...REVIEWER,
        mode: 'cold',
        max_retries: 1,
        review_timeout_min: 20,
      },
      scripted: {
        commands: {
          work: {
            command: review ? reviewWorker(holds) : pipeWorker(holds),
            timeout_ms: 1_200_000,
          },
        },
      },
      monitoring: { poll_interval_min: 0.02, total_timeout_min: 60 },
    },
    files: {
      'templates/worker/review.md': REVIEW_TEMPLATE,
      'templates/worker/review-fix.md': REVIEW_FIX_TEMPLATE,
    },
  });

/**
 * The slot's own CLI. A scripted scenario launches `packages/cli/bin/farmslot.mjs` from the slot
 * checkout; this one runs the checkout-under-test's scripted runner in command mode instead, so
 * the worker is its project's `work` command. (Command mode itself cannot start on a remote
 * node: it runs with FARMSLOT_ROOT at the node support bundle, which is not a Farmslot root.)
 * It is the process the engine sees as the scripted runner, so it also arms a dispatch hold once
 * the worker runs (holds/tmux.arm becomes holds/tmux), and while holds/idle exists it stays alive
 * after its work is done, as an interactive runner waits at its prompt (15 min ceiling).
 */
export function slotCli(root: string) {
  return (slotId: string, fixture: string): Record<string, string> => ({
    'packages/cli/bin/farmslot.mjs': [
      '#!/usr/bin/env node',
      "import { spawnSync } from 'node:child_process';",
      "import { existsSync, renameSync } from 'node:fs';",
      `const holds = ${JSON.stringify(`${fixture}/holds`)};`,
      'try {',
      '  renameSync(`${holds}/tmux.arm`, `${holds}/tmux`);',
      '} catch {',
      '  // No dispatch hold to arm.',
      '}',
      'const args = process.argv.slice(2);',
      "const taskDir = args[args.indexOf('--task-dir') + 1];",
      'const result = spawnSync(',
      '  process.execPath,',
      `  [${JSON.stringify(`${root}/packages/cli/bin/farmslot.mjs`)}, 'scripted-runner', '--task-dir', taskDir, '--mode', 'command', '--project', ${JSON.stringify(slotId.replace(/-\d+$/, ''))}, '--command-ref', 'work'],`,
      `  { stdio: 'inherit', env: { ...process.env, FARMSLOT_ROOT: ${JSON.stringify(fixture)} } },`,
      ');',
      'const tick = new Int32Array(new SharedArrayBuffer(4));',
      'const until = Date.now() + 15 * 60_000;',
      'while (existsSync(`${holds}/idle`) && Date.now() < until) Atomics.wait(tick, 0, 0, 100);',
      'process.exit(result.status ?? 1);',
      '',
    ].join('\n'),
  });
}

/** The marker fakePi turns into a failed turn; its content is the failure Pi reports. */
export const PI_TURN_FAILURE = 'pi-turn-failure';

/** A fake worker finishing its task: its evidence, then every checklist mark. */
const FAKE_WORKER_FINISH = `  const artifacts = path.join(taskDir, 'artifacts');
  fs.writeFileSync(path.join(artifacts, 'pr-description.md'), '# Restart invariant\\n\\nFake worker; no code change.\\n');
  fs.writeFileSync(path.join(artifacts, 'learnings.md'), '# Learnings\\n\\n- Fake worker.\\n');
  const mark = (...markArgs) => execFileSync(path.join(taskDir, 'mark'), markArgs, { cwd: taskDir, stdio: 'inherit' });
  const steps = (fs.readFileSync(taskFile, 'utf8').match(/^- \\[ \\]/gm) ?? []).length;
  mark('start');
  for (let step = 1; step < steps; step++) mark(String(step));
  mark('complete', '--mark-last');`;

/**
 * A Pi-runner worker with no model, the fixture's `pi`. Like Pi it answers `auth check`, keeps a
 * session file and reports its turn through the hook writer the real extension uses, which the
 * real installer copied beside the `-e` extension. It stays mid-turn while holds/worker exists;
 * while it does, holds/pi-turn-failure makes it record that failed turn as Pi would (StopFailure)
 * and stay alive. Then it finishes its task and waits at its prompt until the slot stops it.
 */
export const fakePi = (holds: string): string => `#!/usr/bin/env node
'use strict';
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const holds = ${JSON.stringify(holds)};
const args = process.argv.slice(2);
if (args[0] === 'auth') {
  process.stdout.write(JSON.stringify({ status: 'ready' }) + '\\n');
  process.exit(0);
}
const tick = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(tick, 0, 0, ms);
(async () => {
  const extension = args[args.indexOf('-e') + 1];
  const { writePiHook } = await import(pathToFileURL(path.join(path.dirname(extension), 'pi-farmslot-hook-writer.mjs')).href);
  const taskFile = process.env.FARMSLOT_TASK_FILE;
  const taskDir = path.dirname(taskFile);
  const cwd = process.cwd();
  const sessionId = randomUUID();
  const transcriptPath = path.join(os.homedir(), '.pi/agent/sessions/canary', sessionId + '.jsonl');
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'session', cwd, timestamp: new Date().toISOString() }) + '\\n');
  const hook = (event, extra) => writePiHook({ obsDir: process.env.FARMSLOT_OBS_DIR, event, sessionId, transcriptPath, cwd, ...extra });
  hook('SessionStart');
  hook('UserPromptSubmit', { promptText: fs.readFileSync(taskFile, 'utf8') });
  const worker = path.join(holds, 'worker');
  const failure = path.join(holds, ${JSON.stringify(PI_TURN_FAILURE)});
  if (fs.existsSync(worker)) fs.writeFileSync(worker + '.hit', new Date().toISOString() + '\\n');
  const until = Date.now() + 15 * 60_000;
  while (fs.existsSync(worker) && Date.now() < until) {
    if (fs.existsSync(failure) && !fs.existsSync(failure + '.hit')) {
      hook('StopFailure', { failure: fs.readFileSync(failure, 'utf8').trim() });
      fs.writeFileSync(failure + '.hit', new Date().toISOString() + '\\n');
    }
    sleep(100);
  }
${FAKE_WORKER_FINISH}
  hook('Stop');
  setTimeout(() => process.exit(0), 15 * 60_000);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

/**
 * A Claude-runner worker with no model, the fixture's `claude`. Like Claude it takes its task after
 * launch: it reads the typed prompt at a raw terminal and reports through the hooks in its
 * --settings, which the real installer wrote. Holds: holds/claude-startup keeps it starting up (no
 * prompt marker, so DISPATCH stays in its readiness wait); holds/tmux.arm becomes holds/tmux once
 * its prompt is accepted; holds/claude-late-session withholds its session until it may finish, so
 * DISPATCH stays recapturing it after delivery; holds/claude-no-hook keeps its accepted prompt
 * from its hooks, so nothing proves delivery; holds/claude-no-finish makes that attempt stay
 * mid-turn until /exit; holds/worker keeps it mid-turn. Then it finishes its task and waits at its
 * prompt until /exit. The two prompt holds are read when the prompt arrives, so lifting them only
 * affects the next launch. On a reviewed project it commits the work its reviewer flags, and a
 * fix round reaches it as Claude's does: a resumed session with the prompt on argv.
 */
export const fakeClaude = (holds: string): string => `#!/usr/bin/env node
'use strict';
const { execFileSync, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const holds = ${JSON.stringify(holds)};
const held = (name) => fs.existsSync(path.join(holds, name));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ceiling = Date.now() + 15 * 60_000;
const whileHeld = async (name) => {
  if (held(name)) fs.writeFileSync(path.join(holds, name + '.hit'), new Date().toISOString() + '\\n');
  while (held(name) && Date.now() < ceiling) await sleep(100);
};
const args = process.argv.slice(2);
const settingsAt = args.indexOf('--settings');
const settings = settingsAt < 0 ? {} : JSON.parse(fs.readFileSync(args[settingsAt + 1], 'utf8'));
const cwd = process.cwd();
const resumeAt = args.indexOf('--resume');
const sessionId = resumeAt < 0 ? randomUUID() : args[resumeAt + 1];
const transcriptPath = path.join(os.homedir(), '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), sessionId + '.jsonl');
const session = { session_id: sessionId, transcript_path: transcriptPath };
const hook = (event, extra) => {
  for (const entry of settings.hooks?.[event] ?? [])
    for (const handler of entry.hooks ?? [])
      spawnSync('sh', ['-c', handler.command], { input: JSON.stringify({ hook_event_name: event, cwd, ...extra }) });
};
let typed = '';
let onPrompt = () => {};
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  const text = chunk.toString();
  if (text.includes('\\u0003')) process.exit(130);
  process.stdout.write(text);
  typed += text;
  const end = typed.search(/[\\r\\n]/);
  if (end < 0) return;
  const line = typed.slice(0, end).trim();
  typed = typed.slice(end + 1);
  if (line === '/exit') process.exit(0);
  if (line) onPrompt(line);
});
setTimeout(() => process.exit(0), 15 * 60_000);
(async () => {
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.appendFileSync(transcriptPath, JSON.stringify({ type: 'system', sessionId, cwd }) + '\\n');
  process.stdout.write('starting\\n');
  await whileHeld('claude-startup');
  const lateSession = held('claude-late-session');
  if (!lateSession) hook('SessionStart', session);
  process.stdout.write('\\u276f\\n');
  const prompt =
    resumeAt < 0
      ? await new Promise((resolve) => {
          onPrompt = resolve;
        })
      : args.at(-1);
  onPrompt = () => {};
  const noFinish = held('claude-no-finish');
  if (!held('claude-no-hook')) hook('UserPromptSubmit', { prompt, ...(lateSession ? {} : session) });
  process.stdout.write('working\\n');
  try {
    fs.renameSync(path.join(holds, 'tmux.arm'), path.join(holds, 'tmux'));
  } catch {
    // No dispatch hold to arm.
  }
  await whileHeld('worker');
  if (noFinish) await new Promise(() => {});
  while (held('claude-late-session') && Date.now() < ceiling) await sleep(100);
  if (lateSession) hook('SessionStart', session);
  const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd, stdio: 'inherit' });
  const fixFile = prompt.match(/\\S*REVIEW-FIX\\.md/)?.[0];
  if (fixFile) {
    const fixTask = path.resolve(cwd, fixFile);
    const mark = (...markArgs) => execFileSync(path.join(path.dirname(fixTask), 'mark'), ['--checklist', 'REVIEW-FIX.md', '--signal', 'REVIEW-FIX-SIGNAL.json', ...markArgs], { cwd, encoding: 'utf8', stdio: 'pipe' });
    const steps = (fs.readFileSync(fixTask, 'utf8').match(/^- \\[ \\]/gm) ?? []).length;
    mark('start');
    git('rm', '-q', 'src/debug-trace.ts');
    git('commit', '-qm', 'fix: remove the leftover debug helper');
    for (let step = 1; step < steps; step++) mark(String(step));
    mark('complete', '--mark-last');
  } else {
    const taskFile = path.resolve(cwd, prompt.match(/\\S*TASK\\.md/)[0]);
    const taskDir = path.dirname(taskFile);
    if (path.basename(cwd).startsWith(${JSON.stringify(REVIEW_PROJECT)})) {
      fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'src/format-name.ts'), ${JSON.stringify(`${FORMAT_NAME}\n`)});
      fs.writeFileSync(path.join(cwd, 'src/debug-trace.ts'), ${JSON.stringify(`${LEFTOVER}\n`)});
      git('add', 'src');
      git('commit', '-qm', 'feat: add formatName');
    }
${FAKE_WORKER_FINISH}
  }
  hook('Stop', session);
  process.stdout.write('\\u276f\\n');
})().catch((error) => {
  console.error(error);
  // A crashed fixture reads as a worker gone: say why, or recovery looks at fault.
  fs.appendFileSync(path.join(holds, 'claude-worker.err'), [error.stack, error.stdout, error.stderr].filter(Boolean).join('\\n') + '\\n');
  process.exit(1);
});
`;

export function projectPacks(holds: string): ProjectPack[] {
  return [pack(PIPE_PROJECT, holds, false), pack(REVIEW_PROJECT, holds, true)];
}
