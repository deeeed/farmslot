import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveWorkerDispatchPrompt, resolveWorkerNudgePrompt } from './worker-prompt.js';

describe('worker-prompt', () => {
  it('resolveWorkerDispatchPrompt expands TASK_FILE from farmslot-farm template', async () => {
    const taskFile = 'temp/tasks/feat/tat-3215-0626-211118/TASK.md';
    const prompt = await resolveWorkerDispatchPrompt('farmslot-farm', { taskFile });
    assert.match(prompt, /Follow the checklist in temp\/tasks\/feat\/tat-3215-0626-211118\/TASK\.md/);
    assert.match(prompt, /{{TASK_DIR}}\/mark N|temp\/tasks\/feat\/tat-3215-0626-211118\/mark N/);
    assert.match(prompt, /do not start the next step until that mark succeeds/i);
  });

  it('resolveWorkerNudgePrompt expands TASK_FILE from farmslot-farm template', async () => {
    const taskFile = '/Users/dev/repo/temp/tasks/feat/demo/TASK.md';
    const prompt = await resolveWorkerNudgePrompt('farmslot-farm', { taskFile });
    assert.match(prompt, /New task waiting at \/Users\/dev\/repo\/temp\/tasks\/feat\/demo\/TASK\.md/);
    assert.match(prompt, /follow the checklist in that file/);
    assert.match(prompt, /\/Users\/dev\/repo\/temp\/tasks\/feat\/demo\/mark N/);
  });

  it('falls back to farmslot-farm when project template is missing', async () => {
    const prompt = await resolveWorkerDispatchPrompt('nonexistent-farm-project', {
      taskFile: 'temp/tasks/demo/TASK.md',
    });
    assert.match(prompt, /Follow the checklist in temp\/tasks\/demo\/TASK\.md/);
  });
});