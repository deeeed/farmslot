#!/usr/bin/env node
// `task init` is the one producer of a task directory. These assertions are the
// contract every surface relies on: file set, byte-equal checklist, provenance
// digests, no manifest, no checkbox in TASK.md, and a working `mark` shim.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'farmslot-agent.mjs');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function catalog(templateBody) {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-task-init-catalog-'));
  mkdirSync(path.join(root, 'fix-bug'));
  writeFileSync(path.join(root, 'fix-bug', 'autonomous.mobile.md'), templateBody);
  return root;
}

const PLAIN_TEMPLATE = [
  '---',
  'platforms: [mobile]',
  'description: Fix a mobile bug.',
  '---',
  '# Fix bug',
  '',
  '- [ ] 1. Reproduce',
  '- [ ] 2. Fix and prove',
  '',
].join('\n');

function init(taskDir, templateRoot, extra = [], { runMode = 'autonomous' } = {}) {
  return spawnSync(
    process.execPath,
    [
      cli,
      'task',
      'init',
      taskDir,
      '--flow',
      'fix-bug',
      ...(runMode ? ['--run-mode', runMode] : []),
      '--platform',
      'mobile',
      '--template',
      'fix-bug/autonomous.mobile',
      '--package-templates',
      templateRoot,
      '--package-id',
      'test-catalog',
      '--title',
      'Wrong total on the receipt',
      '--task-text',
      'The receipt shows the pre-fee total.',
      '--ticket',
      'TAT-1',
      '--surface',
      'test',
      '--project',
      'demo',
      '--json',
      ...extra,
    ],
    { encoding: 'utf8' },
  );
}

// 1. Full layout from a placeholder-free template.
{
  const work = mkdtempSync(path.join(tmpdir(), 'farmslot-task-init-'));
  const taskDir = path.join(work, 'temp', 'tasks', 'fix', 'tat-1');
  const result = init(taskDir, catalog(PLAIN_TEMPLATE));
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);

  for (const file of [
    'TASK.md',
    'CHECKLIST.md',
    'mark',
    'inputs/handoff.json',
    'inputs/worker-terminal-contract.json',
  ]) {
    assert.ok(existsSync(path.join(taskDir, file)), `missing ${file}`);
  }
  assert.ok(existsSync(path.join(taskDir, 'artifacts')));
  assert.ok(
    !existsSync(path.join(taskDir, 'checklist-target.json')),
    'manifest is written only by a role switch',
  );
  assert.ok(!existsSync(path.join(taskDir, 'inputs', 'execution-template.json')));
  assert.ok(!existsSync(path.join(taskDir, 'inputs', 'bug-input.json')));
  assert.equal(statSync(path.join(taskDir, 'mark')).mode & 0o755, 0o755);

  const checklist = readFileSync(path.join(taskDir, 'CHECKLIST.md'), 'utf8');
  assert.equal(checklist, PLAIN_TEMPLATE, 'placeholder-free template is byte-equal');

  const handoff = JSON.parse(readFileSync(path.join(taskDir, 'inputs', 'handoff.json'), 'utf8'));
  assert.equal(handoff.schemaVersion, 1);
  assert.equal(handoff.surface, 'test');
  assert.equal(handoff.project, 'demo');
  assert.equal(handoff.flow, 'fix-bug');
  assert.equal(handoff.domain, '');
  assert.equal(handoff.taskDocument, 'TASK.md');
  assert.equal(handoff.report, 'artifacts/pr-description.md');
  assert.equal(handoff.learnings, 'artifacts/learnings.md');
  assert.equal(handoff.task.sourceKind, 'text');
  assert.equal(handoff.task.ticket, 'TAT-1');
  assert.equal(
    handoff.task.acceptanceCriteria,
    undefined,
    'a task with no acceptance criteria carries no ledger ids',
  );
  assert.ok(handoff.attemptId.length > 0);
  assert.equal(handoff.executionTemplate.id, 'fix-bug/autonomous.mobile');
  assert.equal(handoff.executionTemplate.sourceId, 'package:test-catalog');
  assert.equal(handoff.executionTemplate.selectionReason, 'explicit');
  assert.equal(handoff.executionTemplate.sha256, sha256(PLAIN_TEMPLATE));
  assert.equal(handoff.executionTemplate.renderedSha256, sha256(checklist));
  assert.equal(
    handoff.templateProvenance,
    undefined,
    'control-plane provenance is not written by the CLI',
  );
  assert.deepEqual(out.handoffMetadata.executionTemplate, handoff.executionTemplate);

  const task = readFileSync(path.join(taskDir, 'TASK.md'), 'utf8');
  assert.match(task, /^# fix-bug: Wrong total on the receipt$/m);
  assert.match(task, /^TICKET: TAT-1$/m);
  assert.match(task, /^FLOW: fix-bug$/m);
  assert.match(task, /^MODE: autonomous$/m);
  assert.match(task, /^TEMPLATE: fix-bug\/autonomous\.mobile$/m);
  assert.match(
    task,
    new RegExp(`^TASK_DIR: ${taskDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
  );
  assert.doesNotMatch(task, /^SESSION:/m, 'unset optional keys render no blank line');
  assert.doesNotMatch(task, /^BRANCH:/m);
  assert.match(task, /^## Acceptance Criteria$/m);
  assert.match(task, /The receipt shows the pre-fee total\./);
  assert.doesNotMatch(task, /^- \[ \]/m, 'TASK.md is never enumerated');
  assert.match(task, /- `handoff.json`/);
  assert.doesNotMatch(task, /execution-template\.json/);

  const contract = JSON.parse(
    readFileSync(path.join(taskDir, 'inputs', 'worker-terminal-contract.json'), 'utf8'),
  );
  assert.equal(contract.flowType, 'fix-bug');
  assert.equal(contract.commands.complete.report, 'artifacts/pr-description.md');

  // The default mark shim reaches this package's engine; no manifest needed.
  const mark = spawnSync(path.join(taskDir, 'mark'), ['start'], { encoding: 'utf8', cwd: work });
  assert.equal(mark.status, 0, mark.stderr);
  const signal = JSON.parse(readFileSync(path.join(taskDir, 'SIGNAL.json'), 'utf8'));
  assert.equal(signal.status, 'running');
  const marked = spawnSync(path.join(taskDir, 'mark'), ['1'], { encoding: 'utf8', cwd: work });
  assert.equal(marked.status, 0, marked.stderr);
  assert.match(
    readFileSync(path.join(taskDir, 'CHECKLIST.md'), 'utf8'),
    /^- \[x\] 1\. Reproduce$/m,
  );

  // The env override replaces the whole command.
  const stub = path.join(work, 'stub-mark.sh');
  writeFileSync(stub, '#!/usr/bin/env bash\nprintf "%s|%s\\n" "$1" "$2" > "$1/stub.out"\n', {
    mode: 0o755,
  });
  const viaEnv = spawnSync(path.join(taskDir, 'mark'), ['complete'], {
    encoding: 'utf8',
    env: { ...process.env, FARMSLOT_MARK_CMD: stub },
  });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.equal(readFileSync(path.join(taskDir, 'stub.out'), 'utf8'), `${taskDir}|complete\n`);
}

// 2. A recorded mark command is the shim's default and is not quoted.
{
  const work = mkdtempSync(path.join(tmpdir(), 'farmslot-task-init-cmd-'));
  const taskDir = path.join(work, 'task');
  const stub = path.join(work, 'harness.sh');
  writeFileSync(stub, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" > "$3/cmd.out"\n', { mode: 0o755 });
  const result = init(taskDir, catalog(PLAIN_TEMPLATE), [
    '--mark-command',
    `${stub} checklist mark`,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    readFileSync(path.join(taskDir, 'mark'), 'utf8'),
    /exec \$\{FARMSLOT_MARK_CMD:-.*harness\.sh checklist mark\} "\$DIR" "\$@"/,
  );
  const run = spawnSync(path.join(taskDir, 'mark'), ['2'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    readFileSync(path.join(taskDir, 'cmd.out'), 'utf8'),
    `checklist mark ${taskDir} 2\n`,
  );
}

// 3. Placeholders render from the task and --var; an unknown one fails.
{
  const work = mkdtempSync(path.join(tmpdir(), 'farmslot-task-init-vars-'));
  const template = PLAIN_TEMPLATE.replace(
    '- [ ] 1. Reproduce',
    '- [ ] 1. Reproduce {{TICKET}} in {{TASK_DIR}} on {{DEVICE}}',
  );
  const result = init(path.join(work, 'task'), catalog(template), [
    '--var',
    'DEVICE=iPhone 16',
    '--task-dir-label',
    'temp/tasks/x',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const checklist = readFileSync(path.join(work, 'task', 'CHECKLIST.md'), 'utf8');
  assert.match(checklist, /^- \[ \] 1\. Reproduce TAT-1 in temp\/tasks\/x on iPhone 16$/m);
  assert.match(
    readFileSync(path.join(work, 'task', 'TASK.md'), 'utf8'),
    /^TASK_DIR: temp\/tasks\/x$/m,
  );

  const failing = init(
    path.join(work, 'task2'),
    catalog(PLAIN_TEMPLATE.replace('Fix and prove', 'Fix {{NOPE}}')),
  );
  assert.notEqual(failing.status, 0);
  assert.match(failing.stderr, /\{\{NOPE\}\}/);
  assert.ok(
    !existsSync(path.join(work, 'task2', 'TASK.md')),
    'nothing is written when rendering fails',
  );
}

// 4. --task-file wins over --task-text and sets sourceKind file.
{
  const work = mkdtempSync(path.join(tmpdir(), 'farmslot-task-init-file-'));
  writeFileSync(path.join(work, 'brief.md'), 'From the file.\n');
  const result = init(path.join(work, 'task'), catalog(PLAIN_TEMPLATE), [
    '--task-file',
    path.join(work, 'brief.md'),
  ]);
  assert.equal(result.status, 0, result.stderr);
  const handoff = JSON.parse(
    readFileSync(path.join(work, 'task', 'inputs', 'handoff.json'), 'utf8'),
  );
  assert.equal(handoff.task.sourceKind, 'file');
  assert.match(readFileSync(path.join(work, 'task', 'TASK.md'), 'utf8'), /From the file\./);
}

// 5. --addendum-file renders into TASK.md, and a task dir with spaces still marks.
{
  const work = mkdtempSync(path.join(tmpdir(), 'farmslot task init spaces-'));
  const taskDir = path.join(work, 'my task');
  writeFileSync(
    path.join(work, 'addendum.md'),
    '## Tooling\n\nMarker help: `{{TASK_DIR}}/mark --help` for {{TICKET}} ({{FLOW}}).\n',
  );
  const result = init(taskDir, catalog(PLAIN_TEMPLATE), [
    '--addendum-file',
    path.join(work, 'addendum.md'),
  ]);
  assert.equal(result.status, 0, result.stderr);
  const task = readFileSync(path.join(taskDir, 'TASK.md'), 'utf8');
  assert.match(task, /## Tooling\n\nMarker help: `.*my task\/mark --help` for TAT-1 \(fix-bug\)\./);
  assert.ok(
    task.indexOf('## Tooling') < task.indexOf('## Checklist'),
    'addendum precedes the checklist pointer',
  );
  const mark = spawnSync(path.join(taskDir, 'mark'), ['start'], { encoding: 'utf8' });
  assert.equal(mark.status, 0, mark.stderr);
  assert.ok(existsSync(path.join(taskDir, 'SIGNAL.json')), 'default engine path survives spaces');
}

// 6. The task dir is the first positional; a flag value is never mistaken for it.
{
  const work = mkdtempSync(path.join(tmpdir(), 'farmslot-task-init-order-'));
  const r = spawnSync(
    process.execPath,
    [cli, 'task', 'init', '--flow', 'fix-bug', path.join(work, 'x')],
    { encoding: 'utf8' },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown option|requires <task-dir>/);
  assert.ok(!existsSync(path.join(work, 'x', 'TASK.md')));
}

// 7. --run-mode is optional: it selects default rules and fills MODE, so a run
//    without one still initialises and simply renders no MODE line.
{
  const work = mkdtempSync(path.join(tmpdir(), 'farmslot-task-init-no-mode-'));
  const taskDir = path.join(work, 'task');
  const result = init(taskDir, catalog(PLAIN_TEMPLATE), [], { runMode: null });
  assert.equal(result.status, 0, result.stderr);
  const task = readFileSync(path.join(taskDir, 'TASK.md'), 'utf8');
  assert.match(task, /^FLOW: fix-bug$/m);
  assert.doesNotMatch(task, /^MODE:/m);
  const handoff = JSON.parse(readFileSync(path.join(taskDir, 'inputs', 'handoff.json'), 'utf8'));
  assert.equal(handoff.executionTemplate.id, 'fix-bug/autonomous.mobile');
  assert.equal(handoff.executionTemplate.runMode, undefined, 'templates carry no run mode');

  // A template that spells {{MODE}} fails the placeholder guard rather than
  // rendering an invented default.
  const needsMode = path.join(work, 'task-mode');
  const withMode = init(needsMode, catalog(`${PLAIN_TEMPLATE}\nMode: {{MODE}}\n`), [], {
    runMode: null,
  });
  assert.notEqual(withMode.status, 0);
  assert.match(withMode.stderr, /\{\{MODE\}\}/);
}

// 8. Acceptance criteria: the handoff carries them in TASK.md order, which is
//    what gives each one its `AC-<N>` ledger id (ADR-060). List markers are
//    stripped and blank entries dropped, so an id can never point at a blank row.
{
  const work = mkdtempSync(path.join(tmpdir(), 'farmslot-task-init-ac-'));
  const taskDir = path.join(work, 'task');
  const result = init(taskDir, catalog(PLAIN_TEMPLATE), [
    '--acceptance',
    '- The receipt total includes fees',
    '--acceptance',
    '   ',
    '--acceptance',
    '[ ] The regression test covers the fee path\nand the refund path',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const handoff = JSON.parse(readFileSync(path.join(taskDir, 'inputs', 'handoff.json'), 'utf8'));
  assert.deepEqual(handoff.task.acceptanceCriteria, [
    'The receipt total includes fees',
    'The regression test covers the fee path\nand the refund path',
  ]);

  // TASK.md rendering is unchanged: bullets, never a live checkbox.
  const task = readFileSync(path.join(taskDir, 'TASK.md'), 'utf8');
  assert.match(task, /^- The receipt total includes fees$/m);
  assert.match(task, /^- The regression test covers the fee path$/m);
  assert.match(task, /^ {2}and the refund path$/m);
  assert.doesNotMatch(task, /- \[[ xX]\]/, 'TASK.md never carries a checkbox');
}

process.stdout.write('agent-runtime task init tests: ok\n');
