// @farmslot:serial — writes a task dir under the repo's .sandbox/farmslot-farm/tasks
// (mock-mode task root) like writer.test.ts, and points FARMSLOT_PROJECTS_DIR at a
// temp copy of farmslot-farm with a configured execution-template catalog and a
// placeholder-free fixture template, so CHECKLIST.md can be compared byte for byte.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Both env values must be set before slot-config loads: it resolves the projects
// dir and the demo-pool opt-in at module evaluation. Hence the dynamic imports.
process.env.FARMSLOT_DEMO_POOL = '1';
const projectsDir = await mkdtemp(path.join(os.tmpdir(), 'farmslot-split-projects-'));
process.env.FARMSLOT_PROJECTS_DIR = projectsDir;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const realProjectJson = path.join(repoRoot, 'projects', 'farmslot-farm', 'project.json');
const tempProject = path.join(projectsDir, 'farmslot-farm');

const TEMPLATE_SOURCE = [
  '---',
  'description: Split-layout fixture checklist',
  '---',
  '',
  '# Fixture fix-bug checklist',
  '',
  '- [ ] 1. Read TASK.md and freeze the acceptance criteria.',
  '- [ ] 2. Reproduce the bug, then apply the minimal fix.',
  '- [ ] 3. Run `./mark complete --mark-last`.',
  '',
].join('\n');

const ADDENDUM_SOURCE = ['## Tooling', '', 'Marker help: `{{TASK_DIR}}/mark --help`.', ''].join(
  '\n',
);

await mkdir(path.join(tempProject, 'templates', 'worker'), { recursive: true });
const projectJson = JSON.parse(await readFile(realProjectJson, 'utf-8')) as Record<string, unknown>;
projectJson.execution_templates = { sources: [] };
await writeFile(
  path.join(tempProject, 'project.json'),
  `${JSON.stringify(projectJson, null, 2)}\n`,
  'utf-8',
);
await writeFile(
  path.join(tempProject, 'templates', 'worker', 'fix-bug.md'),
  TEMPLATE_SOURCE,
  'utf-8',
);
await writeFile(path.join(tempProject, 'templates', 'task-document.md'), ADDENDUM_SOURCE, 'utf-8');

const { enumerateChecklistCheckboxes } = await import('@farmslot/protocol');
const { CHECKLIST_MARKER_INPUT } = await import('./sidecars.js');
const { EXECUTION_TEMPLATE_INPUT, HANDOFF_INPUT } = await import('./task-document.js');
const { TEMPLATE_PROVENANCE_INPUT, writeTaskFile } = await import('./writer.js');
type Run = import('@farmslot/protocol').Run;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function makeSplitRun(ticket: string): Run {
  return {
    id: 'run-split',
    familyId: 'family-split',
    parentRunId: null,
    familyRootTicketOrPr: ticket,
    lane: 'comparison',
    variant: 'split',
    flowType: 'fix-bug',
    mode: 'autonomous',
    status: 'writing-task',
    project: 'farmslot-farm',
    ticketOrPr: ticket,
    slotId: 'demo-ff-1',
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: {
      nudgeCount: 0,
      model: 'sonnet',
      runner: 'fake',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ticketData: {
      source: 'manual',
      title: 'Saving a note drops the last character',
      description: 'Typing then tapping Save persists everything except the final character.',
      // Authors often paste ACs as checkboxes; the task document must not turn
      // them back into live steps.
      acceptanceCriteria: ['[ ] Tapping Save persists the full text', '- No error toast appears'],
      affectedArea: 'Notes editor',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
  };
}

test('split layout writes CHECKLIST.md verbatim and TASK.md as the task document', async (t) => {
  const run = makeSplitRun(`SPLIT-${Date.now()}`);
  let taskFile = '';
  t.after(async () => {
    if (taskFile) await rm(path.dirname(taskFile), { recursive: true, force: true });
    await rm(projectsDir, { recursive: true, force: true });
  });

  taskFile = await writeTaskFile(run);
  const taskDir = path.dirname(taskFile);
  assert.equal(path.basename(taskFile), 'TASK.md');

  // CHECKLIST.md is the template source, byte for byte: no preamble, no appended
  // contracts, frontmatter intact. This is what makes it equal to a skill-side
  // materialization of the same template.
  const checklist = await readFile(path.join(taskDir, 'CHECKLIST.md'), 'utf-8');
  assert.equal(checklist, TEMPLATE_SOURCE);
  assert.equal(enumerateChecklistCheckboxes(checklist).length, 3);

  // TASK.md carries the ticket, ACs, the preamble, the addendum and the pointer,
  // and contributes zero steps even though an AC was authored as a checkbox.
  const taskDocument = await readFile(taskFile, 'utf-8');
  if (process.env.FARMSLOT_SPLIT_TEST_DUMP) console.log(taskDocument);
  assert.match(taskDocument, /^# fix-bug: Saving a note drops the last character/m);
  assert.match(taskDocument, /> Fully autonomous — zero human input/);
  assert.match(taskDocument, /^TICKET: SPLIT-\d+$/m);
  assert.match(taskDocument, /^STATUS: pending$/m);
  assert.match(
    taskDocument,
    /## Acceptance Criteria\n\n- Tapping Save persists the full text\n- No error toast appears/,
  );
  assert.match(taskDocument, /## Affected Area\n\nNotes editor/);
  // The addendum's {{TASK_DIR}} expands to the repo-relative task dir.
  assert.match(taskDocument, /## Tooling\n\nMarker help: `[^`]+\/fix\/split-[^`]+\/mark --help`\./);
  assert.match(taskDocument, /## Checklist\n\nFollow `[^`]+\/CHECKLIST\.md` top to bottom/);
  assert.match(taskDocument, /## Inputs\n\nUnder `[^`]+\/inputs\/`:\n\n- `handoff\.json`/);
  assert.match(taskDocument, /- `execution-template\.json`/);
  assert.match(taskDocument, /- `bug-input\.json`/);
  assert.match(taskDocument, /## Runtime capability proof plan/);
  assert.doesNotMatch(taskDocument, /- \[ \]/);
  assert.equal(enumerateChecklistCheckboxes(taskDocument).length, 0);
  assert.doesNotMatch(checklist, /Fully autonomous/);

  // The checklist target already prefers CHECKLIST.md when it exists.
  const manifest = JSON.parse(await readFile(path.join(taskDir, 'checklist-target.json'), 'utf-8'));
  assert.deepEqual(manifest, { checklist: 'CHECKLIST.md' });
  await readFile(path.join(taskDir, CHECKLIST_MARKER_INPUT));

  // Provenance digests describe the checklist file, not TASK.md.
  const provenance = JSON.parse(
    await readFile(path.join(taskDir, TEMPLATE_PROVENANCE_INPUT), 'utf-8'),
  ) as { contentHash: string; executionTemplate: { sha256: string; renderedSha256: string } };
  assert.equal(provenance.contentHash, sha256(TEMPLATE_SOURCE));
  assert.equal(provenance.executionTemplate.sha256, sha256(TEMPLATE_SOURCE));
  assert.equal(provenance.executionTemplate.renderedSha256, sha256(checklist));

  const executionTemplate = JSON.parse(
    await readFile(path.join(taskDir, EXECUTION_TEMPLATE_INPUT), 'utf-8'),
  ) as { schemaVersion: number; selectionReason: string; executionTemplate: { id: string } };
  assert.equal(executionTemplate.schemaVersion, 1);
  assert.equal(executionTemplate.selectionReason, 'single-general-candidate');
  assert.equal(executionTemplate.executionTemplate.id, 'fix-bug/default');
  assert.deepEqual(executionTemplate.executionTemplate, provenance.executionTemplate);

  // handoff.json matches what the recipe-cook skill writes and what
  // @farmslot/handoff closeout requires.
  const handoff = JSON.parse(await readFile(path.join(taskDir, HANDOFF_INPUT), 'utf-8')) as Record<
    string,
    unknown
  >;
  assert.equal(handoff.schemaVersion, 1);
  assert.equal(handoff.attemptId, 'run-split');
  assert.equal(handoff.surface, 'farmslot');
  assert.equal(handoff.project, 'farmslot-farm');
  assert.equal(handoff.repo, 'deeeed/farmslot');
  assert.equal(handoff.flow, 'fix-bug');
  assert.equal(typeof handoff.startedAt, 'string');
  assert.deepEqual(handoff.task, {
    title: 'Saving a note drops the last character',
    sourceKind: 'text',
    ticket: run.ticketOrPr,
  });
  assert.equal(handoff.taskDocument, 'TASK.md');
  assert.match(String(handoff.report), /^artifacts\//);
  assert.equal(handoff.learnings, 'artifacts/learnings.md');
});
