import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';

import {
  buildHandoffMetadata,
  builtinTerminalContract,
  projectWorkerTemplateSource,
  selectExecutionTemplate,
} from '@farmslot/agent-runtime';

import * as realConfig from '../core/config.js';

import * as realTemplates from './execution-template-catalog.js';
import * as realHosted from './hosted-task-init.js';

let current: ReturnType<typeof fixture>;
const initialized: realHosted.HostedTaskInput[] = [];
const verified: string[] = [];
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'authored-task-boundary-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const taskDir = path.join(root, 'mirror/dev/input');
  const templates = path.join(root, 'templates');
  fs.mkdirSync(path.join(templates, 'worker'), { recursive: true });
  fs.mkdirSync(path.join(taskDir, 'inputs'), { recursive: true });
  const markdown = '# Task\n- [ ] Observe retained task\n';
  fs.writeFileSync(path.join(templates, 'worker/dev.md'), markdown);
  fs.writeFileSync(path.join(taskDir, 'TASK.md'), markdown);
  const slot: realConfig.SlotVars = {
    slotId: 'fixture-1',
    host: 'localhost',
    machine: 'local',
    platform: 'cli',
    sshUser: 'test',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: root,
    remoteRepo: path.join(root, 'checkout'),
    session: 'fixture-1',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    projectName: 'fixture',
    resourceVars: {},
    domain: 'perps',
  };
  const project: realConfig.ProjectVars = {
    projectName: 'fixture',
    projectConfig: path.join(root, 'project.json'),
    projectFixturesDir: path.join(root, 'fixtures'),
    projectTemplatesDir: templates,
    projectJson: { name: 'fixture' },
    runtimeDir: '.agent',
    artifactDir: '.task',
  };
  const selection: realTemplates.ResolvedSlotExecutionTemplate = {
    ...selectExecutionTemplate({
      sources: [projectWorkerTemplateSource('fixture', templates)],
      flow: 'dev',
      platform: 'cli',
    }),
    markdown,
    effectiveDomain: 'perps',
  };
  initialized.length = 0;
  verified.length = 0;
  return { root, taskDir, slot, project, selection };
}
mock.module('../core/config.js', {
  namedExports: { ...realConfig, loadProjectVars: async () => current.project },
});
mock.module('./execution-template-catalog.js', {
  namedExports: {
    ...realTemplates,
    resolveConfiguredExecutionTemplateForSlot: () => current.selection,
  },
});
mock.module('./hosted-task-init.js', {
  namedExports: {
    ...realHosted,
    initializeHostedTaskOnSlot: async (
      _slot: realConfig.SlotVars,
      _directory: string,
      input: realHosted.HostedTaskInput,
    ) => {
      initialized.push(input);
      return input.template.reference;
    },
    verifyHostedTaskOnSlot: async (_slot: realConfig.SlotVars, directory: string) => {
      verified.push(directory);
    },
  },
});
const fresh: string = './existing-runtime.js?boundary-tests';
const { initializeAuthoredTaskOnSlot } = (await import(
  fresh
)) as typeof import('./existing-runtime.js');

test('authored initialization carries the effective inherited slot domain', async (t) => {
  current = fixture(t);
  await initializeAuthoredTaskOnSlot(current.slot, {
    taskFile: path.join(current.taskDir, 'TASK.md'),
    project: 'fixture',
    flowType: 'dev',
    ticketOrPr: 'Authored domain',
    mode: 'validation',
  });
  assert.equal(initialized.length, 1);
  assert.equal(initialized[0]!.task.domain, 'perps');
  assert.equal(initialized[0]!.task.authored?.handoff.domain, 'perps');
});

for (const mismatched of [true, false])
  test(`retained authored adoption ${mismatched ? 'refuses a changed flow' : 'preserves its original attempt identity'}`, async (t) => {
    current = fixture(t);
    const handoff = buildHandoffMetadata({
      attemptId: 'original-authored-attempt',
      surface: 'farmslot',
      project: 'fixture',
      flow: 'pr-complete',
      title: 'Authored task',
      sourceKind: 'text',
      terminalContract: builtinTerminalContract('pr-complete'),
    });
    const file = path.join(current.taskDir, 'inputs/handoff.json');
    fs.writeFileSync(file, JSON.stringify(handoff));
    fs.mkdirSync(path.join(current.taskDir, 'artifacts'));
    // Tooling verification is mocked here; these cases isolate adoption routing.
    fs.writeFileSync(path.join(current.taskDir, 'artifacts/harness-provenance.json'), '{}');
    const before = fs.readFileSync(file, 'utf8');
    const invoke = () =>
      initializeAuthoredTaskOnSlot(current.slot, {
        taskFile: path.join(current.taskDir, 'TASK.md'),
        project: 'fixture',
        flowType: mismatched ? 'review-pr' : 'pr-complete',
        ticketOrPr: 'Adopt authored task',
        attemptId: 'new-run-identity',
      });
    if (mismatched) await assert.rejects(invoke, /different project or flow/);
    else await invoke();
    assert.equal(verified.length, mismatched ? 0 : 1);
    assert.equal(initialized.length, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
