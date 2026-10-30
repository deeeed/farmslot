import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { recordBrowserProof } from './stable-layout-refetch-proof.mjs';

export function acPanelCase() {
  const width = Number(process.env.FARMSLOT_AC_PANEL_WIDTH);
  assert([1280, 414].includes(width), 'Select FARMSLOT_AC_PANEL_WIDTH=1280 or414');
  const phase = process.env.FARMSLOT_LAYOUT_EXPECT_SHIFT === '1' ? 'before' : 'after';
  return { width, runId: `ac-${phase}-${width}`, slotId: `fixture-task-${phase}-${width}` };
}

export function acPanelRun(mode, run) {
  const { runId, slotId } = acPanelCase();
  const written = mode.startsWith('ac-written');
  // Unwritten: write-task is still running. Written: it completed and prepare runs next.
  const current = run.steps.findIndex((step) => step.name === (written ? 'prepare' : 'write-task'));
  assert(current > 0, 'The fixture flow must contain write-task and prepare');
  return {
    ...run,
    status: 'preparing',
    id: runId,
    familyId: runId,
    slotId,
    taskFile: written ? 'tasks/layout/TASK.md' : null,
    agentContexts: [],
    steps: run.steps.map((step, index) =>
      index < current
        ? step
        : index === current
          ? { name: step.name, status: 'running', startedAt: run.steps[index - 1].completedAt }
          : { name: step.name, status: 'pending' },
    ),
  };
}

export function acPanelProgress(mode) {
  return {
    slotId: acPanelCase().slotId,
    markdown: '',
    structured: null,
    acceptanceCriteria: [{ id: 'AC-1', text: 'The written task exposes its criteria.' }],
    ...(mode === 'ac-written-error'
      ? { acceptanceStatusError: 'Invalid JSON in artifacts/acceptance-status.json' }
      : {}),
  };
}

export async function proveAcPanel({
  cdp,
  target,
  browserCall,
  emulation,
  transition,
  output,
  save,
  frames,
  viewport,
}) {
  const before = process.env.FARMSLOT_LAYOUT_EXPECT_SHIFT === '1';
  const inspect = () =>
    cdp('eval', target, '--file', path.join(import.meta.dirname, 'probes/ac-panel.js'));
  async function until(accept, label) {
    const end = Date.now() + 45_000;
    let value;
    do {
      value = await inspect();
      if (value.sourceReady && value.postureReady && !value.sidebarAnimating && accept(value))
        return value;
      await delay(100);
    } while (Date.now() < end);
    await save('timeout-' + label, value);
    assert.fail(label + ': ' + JSON.stringify(value));
  }
  const { width: caseWidth, runId } = acPanelCase();
  // Each accepted state stays on screen long enough to read in the recording.
  async function shot(state) {
    await delay(1000);
    await cdp(
      'screenshot',
      target,
      path.join(output, `ac-panel-${before ? 'before' : 'after'}-${caseWidth}-${state}.png`),
    );
  }
  await cdp('eval', target, `location.hash='run/${runId}';return true;`);
  const results = [];
  for (const width of [caseWidth]) {
    await viewport(width);
    transition('ac-unwritten');
    await recordBrowserProof({
      name: `ac-panel-${before ? 'before' : 'after'}-${width}`,
      browserCall,
      emulation,
      output,
      save,
      run: async () => {
        await until(
          (v) =>
            v.runLoaded &&
            !v.taskFile &&
            (before ? v.error.includes('No task file for slot') : !v.panel),
          'unwritten-ready',
        );
        await cdp(
          'eval',
          target,
          "const root=document.querySelector('farm-app').querySelector('run-detail').shadowRoot;root.querySelector('run-pipeline').scrollIntoView({block:'start'});return true;",
        );
        const unwritten = await until(
          (v) =>
            v.runLoaded &&
            !v.taskFile &&
            (before ? v.error.includes('No task file for slot') && v.errorVisible : !v.panel),
          'unwritten',
        );
        await shot('unwritten');
        if (!before)
          assert(
            !frames.some((f) => f.method === 'task.progress' && !f.mode.startsWith('ac-written')),
            'An unwritten task must not be read',
          );
        const revision = transition('ac-written');
        const written = await until(
          (v) =>
            v.taskFile &&
            v.panel &&
            v.panelVisible &&
            v.counts.includes('0/1 assessed') &&
            !v.error &&
            frames.some((f) => f.method === 'task.progress' && f.revision === revision),
          'written',
        );
        await shot('written');
        const movement = written.nextTop - unwritten.nextTop;
        await save(`${width}-arrival`, { unwritten, written, movement });
        if (!before)
          assert.equal(movement, 0, 'Task criteria arrival must not move the next control');
        transition('ac-written-error');
        const failed = await until(
          (v) => v.error.includes('Invalid JSON') && v.errorVisible,
          'real-read-error',
        );
        await shot('real-read-error');
        transition('ac-written-recovered');
        const recovered = await until(
          (v) => v.panel && !v.error && v.counts.includes('0/1 assessed'),
          'recovered',
        );
        await shot('recovered');
        results.push({ width, unwritten, written, movement, failed, recovered });
      },
    });
  }
  await save('ac-panel-result', {
    result: 'PASS',
    before,
    results,
    limit:
      'Mounted observed-WebSocket presentation. No actual gateway or task writer is activated.',
  });
}
