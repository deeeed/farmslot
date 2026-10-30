import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { recordBrowserProof } from './stable-layout-refetch-proof.mjs';

/** One isolated run lifecycle per phase, width and subject: a slot run or a slot-free review. */
export function acPanelCase() {
  const width = Number(process.env.FARMSLOT_AC_PANEL_WIDTH);
  assert([1280, 414].includes(width), 'Select FARMSLOT_AC_PANEL_WIDTH=1280 or 414');
  const subject = process.env.FARMSLOT_AC_PANEL_SUBJECT ?? 'slot';
  assert(['slot', 'review'].includes(subject), 'Select FARMSLOT_AC_PANEL_SUBJECT=slot or review');
  const review = subject === 'review';
  const phase = process.env.FARMSLOT_LAYOUT_EXPECT_SHIFT === '1' ? 'before' : 'after';
  const runId = `ac-${phase}-${width}${review ? '-review' : ''}`;
  return {
    width,
    review,
    runId,
    // Opened only after its task exists; its first task read waits until the proof releases it.
    openedRunId: `${runId}-opened`,
    slotId: review ? null : `fixture-task-${phase}-${width}`,
  };
}

/** What the gateway answers while the run has no task: a missing slot task or review checklist. */
export function acPanelUnwrittenError() {
  const { review, slotId } = acPanelCase();
  return review
    ? 'Review checklist is missing: /workspace/task/CHECKLIST.md'
    : `No task file for slot ${slotId}`;
}

export function acPanelRun(mode, run, requestedRunId) {
  const { runId, openedRunId, slotId, review } = acPanelCase();
  const opened = requestedRunId === openedRunId;
  const id = opened ? openedRunId : runId;
  const written = opened || mode.startsWith('ac-written') || mode.startsWith('ac-opened');
  // Unwritten: write-task is still running. Written: it completed and prepare runs next.
  const current = run.steps.findIndex((step) => step.name === (written ? 'prepare' : 'write-task'));
  assert(current > 0, 'The fixture flow must contain write-task and prepare');
  return {
    ...run,
    status: 'preparing',
    id,
    familyId: id,
    slotId: slotId && opened ? `${slotId}-opened` : slotId,
    ...(review
      ? {
          reviewWorkspace: {
            workspaceId: id,
            machine: 'fixture-node',
            executionNodeId: 'fixture-node',
            checkoutPath: '/workspace/source',
            taskPath: '/workspace/task',
            artifactPath: '/workspace/task/artifacts',
          },
        }
      : {}),
    taskFile: written ? (review ? '/workspace/task/TASK.md' : 'tasks/layout/TASK.md') : null,
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

export function acPanelProgress(mode, params) {
  const opened = params?.runId === acPanelCase().openedRunId;
  return {
    slotId: params?.slotId ?? '',
    markdown: '',
    structured: null,
    ...(mode === 'ac-written-none' || opened
      ? {}
      : { acceptanceCriteria: [{ id: 'AC-1', text: 'The written task exposes its criteria.' }] }),
    ...(mode === 'ac-written-error' && !opened
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
  releaseReplies,
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
  const { width, review, runId, openedRunId } = acPanelCase();
  const name = `ac-panel-${before ? 'before' : 'after'}-${width}${review ? '-review' : ''}`;
  const unwrittenError = acPanelUnwrittenError();
  // Each accepted state stays on screen long enough to read in the recording.
  async function shot(state) {
    await delay(750);
    await cdp('screenshot', target, path.join(output, `${name}-${state}.png`));
  }
  await cdp('eval', target, `location.hash='run/${runId}';return true;`);
  let measured;
  await viewport(width);
  transition('ac-unwritten');
  await recordBrowserProof({
    name,
    browserCall,
    emulation,
    output,
    save,
    run: async () => {
      await until(
        (v) =>
          v.runId === runId &&
          !v.taskFile &&
          (before ? v.error.includes(unwrittenError) : !v.panel),
        'unwritten-ready',
      );
      await cdp(
        'eval',
        target,
        "const root=document.querySelector('farm-app').querySelector('run-detail').shadowRoot;root.querySelector('run-pipeline').scrollIntoView({block:'start'});return true;",
      );
      const unwritten = await until(
        (v) =>
          v.runId === runId &&
          !v.taskFile &&
          (before ? v.error.includes(unwrittenError) && v.errorVisible : !v.panel),
        'unwritten',
      );
      await shot('unwritten');
      if (!before)
        assert(
          !frames.some((f) => f.method === 'task.progress' && !f.mode.startsWith('ac-written')),
          'An unwritten task must not be read',
        );
      // write-task records the task; the row stays held while its first read is in flight.
      transition('ac-written-loading');
      const writtenLoading = await until(
        (v) => v.runId === runId && v.taskFile && (before || v.progressLoading),
        'written-loading',
      );
      await shot('written-loading');
      if (!before)
        assert(
          writtenLoading.slotHeld && writtenLoading.reservedHeight === unwritten.reservedHeight,
          'The row stays held while the written task first loads',
        );
      const revision = transition('ac-written');
      releaseReplies();
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
      // The row sits inside the pipeline, so its arrival is the pipeline's change in height.
      // Content loading above and the page's scroll limit leave that height alone.
      const movement = written.pipelineHeight - unwritten.pipelineHeight;
      await save(`${width}-arrival`, { unwritten, written, movement });
      if (!before) {
        assert.equal(movement, 0, 'Task criteria arrival must not move the next control');
        assert(!written.slotHeld, 'Loaded criteria release the reserved row');
      }
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
      // A written task without criteria leaves no reserved blank row behind.
      transition('ac-written-none');
      const none = await until(
        (v) => !v.panel && (before || v.reservedHeight === 0),
        'no-criteria',
      );
      await shot('no-criteria');
      // A run opened after its task exists holds no row while its first read loads.
      transition('ac-opened-loading');
      await cdp('eval', target, `location.hash='run/${openedRunId}';return true;`);
      const opening = await until(
        (v) => v.runId === openedRunId && v.taskFile && v.progressLoading,
        'opened-loading',
      );
      await shot('opened-loading');
      if (!before)
        assert.equal(opening.reservedHeight, 0, 'A run opened after its task exists holds no row');
      transition('ac-opened');
      releaseReplies();
      const opened = await until(
        (v) => v.runId === openedRunId && !v.progressLoading && !v.panel,
        'opened',
      );
      const openedMovement = opened.pipelineHeight - opening.pipelineHeight;
      if (!before)
        assert.equal(openedMovement, 0, 'A first read without criteria must not move the page');
      measured = {
        width,
        subject: review ? 'review' : 'slot',
        unwritten,
        writtenLoading,
        written,
        movement,
        failed,
        recovered,
        none,
        opening,
        opened,
        openedMovement,
      };
    },
  });
  await save('ac-panel-result', {
    result: 'PASS',
    before,
    ...measured,
    limit:
      'Mounted observed-WebSocket presentation. No actual gateway or task writer is activated.',
  });
}
