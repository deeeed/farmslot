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
// hold while their marker exists under the stack's holds/ directory.
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
 * A canary lifecycle run: interactive dev with the reviewed profile (HUMAN_GATE prepares a
 * package and presents a card), the scripted runner, no code change, so the gate offers to close
 * it as shipped, which goes through FINALIZE without GitHub.
 */
export function canaryRunParams(slotId: string, label: string): Record<string, unknown> {
  return {
    project: CANARY_PROJECT,
    flowType: 'dev',
    mode: 'interactive',
    devInteractiveProfile: 'reviewed',
    ticketOrPr: `canary ${label}`,
    initialContext:
      'Post-deploy canary: a scripted run through the whole lifecycle. No code change.',
    slotId,
    runner: 'scripted',
    model: 'scripted',
    transport: 'tmux',
    scripted: { mode: 'scenario', scenario: 'success', stepDelayMs: 8000 },
    tags: CANARY_TAGS,
  };
}

/** The canary demo project, for a repo at `origin`. */
export function canaryPack(origin: string): ProjectPack {
  return {
    name: CANARY_PROJECT,
    projectJson: {
      repo_url: origin,
      default_branch: 'main',
      // Pack portability requires a QA flow even though canary runs never use one.
      qa: {
        default_profile: 'changes',
        profiles: [{ id: 'changes', title: 'Validate changes', template_id: 'validation/shared' }],
      },
      paths: { runtime_dir: '.agent', artifact_dir: '.task' },
      execution_templates: {
        sources: [{ id: 'workspace:shared', kind: 'workspace', root: { projectPath: 'shared' } }],
      },
      review: { enabled: false },
      monitoring: { poll_interval_min: 0.02, total_timeout_min: 15 },
    },
    files: {
      'shared/dev/shared.md':
        '---\nplatforms: [cli]\n---\n\n# Canary development\n\n- [ ] Run the scripted canary scenario.\n',
      'shared/validation/shared.md':
        '---\nplatforms: [cli]\n---\n\n# Canary validation\n\n- [ ] Validate the change.\n',
      'templates/prompts/worker-dispatch.md': 'Read {{TASK_FILE}} and follow it.\n',
      'templates/prompts/worker-nudge.md': 'Continue {{TASK_FILE}}.\n',
    },
  };
}

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

function pack(name: string, holds: string, review: boolean): ProjectPack {
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
      'shared/dev/shared.md':
        '---\nplatforms: [cli]\n---\n\n# Restart invariant development\n\n- [ ] Run the configured scripted command.\n',
      'shared/validation/shared.md':
        '---\nplatforms: [cli]\n---\n\n# Restart invariant validation\n\n- [ ] Validate the change.\n',
      'templates/prompts/worker-dispatch.md':
        'Read {{TASK_FILE}} and follow it. After each checklist step, run {{TASK_DIR}}/mark N.\n',
      'templates/prompts/worker-nudge.md': 'Continue {{TASK_FILE}}.\n',
      'templates/worker/review.md': REVIEW_TEMPLATE,
      'templates/worker/review-fix.md': REVIEW_FIX_TEMPLATE,
    },
  };
}

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

export function projectPacks(holds: string): ProjectPack[] {
  return [pack(PIPE_PROJECT, holds, false), pack(REVIEW_PROJECT, holds, true)];
}
