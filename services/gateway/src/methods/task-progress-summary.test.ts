import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

// mock.module replaces a module wholesale, so the real namespaces are spread in
// and only the fixtures these tests need are overridden.
import * as realConfig from '../core/config.js';
import * as realSlotIo from '../core/slot-io.js';
import * as realFleetState from '../fleet/state.js';
import * as realRunStore from '../runs/store.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'gw-progress-summary-'));
const taskDir = path.join(root, '.task', 'dev', 'demo');
const vars = {
  remoteRepo: root,
  host: 'localhost',
  machine: 'local',
  sshTarget: '',
  slotId: 'slot-summary',
  projectName: 'farmslot',
};
/** Every slot file operation the read asks for, by function and path. */
const reads: string[] = [];

mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    loadSlotVars: async () => vars,
    resolveTaskPaths: async () => ({
      vars,
      taskDirName: '.task',
      taskDir,
      taskMdPath: path.join(taskDir, 'TASK.md'),
      signalPath: path.join(taskDir, 'SIGNAL.json'),
    }),
  },
});

mock.module('../core/slot-io.js', {
  namedExports: Object.fromEntries(
    Object.entries(realSlotIo).map(([name, value]) => [
      name,
      typeof value === 'function' && name.startsWith('slot')
        ? (...args: unknown[]) => {
            reads.push(`${name} ${path.relative(taskDir, String(args[1]))}`);
            return Reflect.apply(value, undefined, args);
          }
        : value,
    ]),
  ),
});

mock.module('../fleet/state.js', {
  namedExports: {
    ...realFleetState,
    loadFleetStatus: async () => ({
      slots: [{ slot: 'slot-summary', taskFile: 'dev/demo', lifecycle: 'busy' }],
    }),
  },
});

mock.module('../runs/store.js', {
  namedExports: {
    ...realRunStore,
    getRun: () => undefined,
    listRuns: () => ({ runs: [] }),
  },
});

const { taskProgress } = await import('./task.js');

test.after(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(path.join(taskDir, 'subtasks'), { recursive: true });
writeFileSync(
  path.join(taskDir, 'CHECKLIST.md'),
  [
    '# Worker',
    '',
    '## Build',
    '',
    '- [x] **1. read the ticket**',
    '- [ ] **2. write the fix**',
    '- [ ] **3. write the report**',
    '',
  ].join('\n'),
);
writeFileSync(path.join(taskDir, 'subtasks', 'index.json'), '{"schemaVersion":1,"units":[]}\n');

test('a summary read returns counts and the current step, and reads only the checklist', async () => {
  reads.length = 0;
  const full = await taskProgress({ slotId: 'slot-summary' });
  const fullReads = [...reads];
  assert.equal(full.structured?.completedSteps, 1);
  assert(
    fullReads.some((read) => !read.endsWith('CHECKLIST.md') && !read.endsWith('TASK.md')),
    `a full read also reads beside the checklist: ${fullReads.join(', ')}`,
  );

  reads.length = 0;
  const summary = await taskProgress({ slotId: 'slot-summary', summary: true });
  assert.deepEqual(summary, {
    slotId: 'slot-summary',
    markdown: '',
    summary: {
      completedSteps: 1,
      totalSteps: 3,
      currentPhase: full.structured?.currentPhase ?? null,
      currentStep: full.structured?.currentStep ?? null,
    },
  });
  assert(summary.summary?.currentStep, 'the current step is named');
  assert.deepEqual(
    reads.filter((read) => !read.endsWith('CHECKLIST.md') && !read.endsWith('TASK.md')),
    [],
    'nothing beside the checklist is read',
  );
  assert(reads.length < fullReads.length);
});
