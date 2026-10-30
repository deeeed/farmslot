import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Save the CDP frame timestamps as well as the actual captured frames. No DOM mutation.
export async function recordBrowserProof({ name, run, browserCall, emulation, output, save }) {
  const captured = [];
  const acknowledgements = [];
  const listener = (raw) => {
    const message = JSON.parse(String(raw));
    if (message.method === 'Page.screencastFrame') {
      captured.push(message.params);
      acknowledgements.push(
        browserCall('Page.screencastFrameAck', { sessionId: message.params.sessionId }),
      );
    }
  };
  emulation.on('message', listener);
  await browserCall('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
  try {
    await run();
  } finally {
    await browserCall('Page.stopScreencast');
    emulation.off('message', listener);
    await Promise.all(acknowledgements);
    assert(captured.length > 1, 'The recording must contain actual rendered frames');
    const directory = path.join(output, name + '-frames');
    await mkdir(directory);
    const list = [];
    for (const [index, frame] of captured.entries()) {
      const file = `frame-${String(index).padStart(5, '0')}.jpg`;
      await writeFile(path.join(directory, file), Buffer.from(frame.data, 'base64'));
      list.push(
        `file '${file}'`,
        `duration ${Math.max(0.01, (captured[index + 1]?.metadata.timestamp ?? frame.metadata.timestamp + 1) - frame.metadata.timestamp)}`,
      );
    }
    list.push(`file 'frame-${String(captured.length - 1).padStart(5, '0')}.jpg'`);
    await writeFile(path.join(directory, 'frames.txt'), list.join('\n') + '\n');
    await save(
      name + '-timestamps',
      captured.map(({ metadata }) => metadata),
    );
    await execute('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      path.join(directory, 'frames.txt'),
      '-vf',
      'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      path.join(output, name + '.mp4'),
    ]);
  }
}

/** Real mounted consumers over the presentation fixture, with read-only DOM probes. */
export async function proveRefetchNotices({
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
  const probe = path.join(import.meta.dirname, 'probes/refetch-notices.js');
  const probeSource = await readFile(probe, 'utf8');
  const inspect = async () => {
    const result = await browserCall('Runtime.evaluate', {
      expression: `(async () => { ${probeSource} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  async function until(accept, label) {
    let actual;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      actual = await inspect();
      if (accept(actual)) return actual;
      await delay(200);
    }
    await save('timeout-' + label, actual);
    assert.fail(label + ': ' + JSON.stringify(actual));
  }
  const record = (name, run) =>
    recordBrowserProof({ name, run, browserCall, emulation, output, save });
  // The tray separately covers an expanded narrow sidebar. These views use their full width.
  const expanded = await cdp(
    'eval',
    target,
    "return document.querySelector('farm-app').querySelector('.fa-nav-toggle')?.title === 'Collapse sidebar';",
  );
  if (expanded) await cdp('click', target, '.fa-nav-toggle');
  await cdp(
    'eval',
    target,
    "await Promise.all(document.querySelector('farm-app').querySelector('nav').getAnimations().map(animation => animation.finished)); return true;",
  );
  const observations = [];
  for (const width of before ? [1280] : [1280, 414]) {
    await viewport(width);
    for (const view of ['run', 'evals']) {
      transition('refetch-ready');
      await cdp(
        'eval',
        target,
        `location.hash = ${JSON.stringify(view === 'run' ? 'run/layout-run' : 'evals')}; return { hash: location.hash };`,
      );
      await until(
        (value) =>
          view === 'run' ? value.gateNotice?.includes('Decision resolved') : value.templateNote,
        view + '-loaded',
      );
      const modals = await cdp(
        'eval',
        target,
        "return { open: Boolean(document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('button')) };",
      );
      if (modals.open) await cdp('click', target, 'whats-new-modal >>> button.primary');
      if (view === 'run')
        await cdp(
          'eval',
          target,
          "(document.querySelector('farm-app').shadowRoot ?? document.querySelector('farm-app')).querySelector('run-detail').shadowRoot.querySelector('ready-workspace').scrollIntoView(); return true;",
        );
      else
        await cdp(
          'eval',
          target,
          "const root = (document.querySelector('farm-app').shadowRoot ?? document.querySelector('farm-app')).querySelector('eval-cockpit').shadowRoot; [...root.querySelectorAll('.base-choice-note')].find(element => element.textContent.includes('The gateway captures')).scrollIntoView({ block: 'center' }); return true;",
        );
      const positions = [];
      await record(`${view}-${before ? 'before' : 'after-' + width}`, async () => {
        for (const mode of [
          'refetch-ready',
          'refetch-gap',
          'refetch-ready',
          'refetch-error',
          'refetch-gap',
          'refetch-ready',
        ]) {
          const requestMark = frames.length;
          const expectedRevision = transition(mode);
          const requested = () =>
            frames
              .slice(requestMark)
              .some(({ method, params }) =>
                view === 'run'
                  ? method === 'run.get' && params?.runId === 'layout-run' && !params?.view
                  : method === 'config.templateOptions',
              );
          const settled = (value) =>
            requested() &&
            (view === 'run'
              ? value.runReadStatus === 'ready' &&
                value.runReadRevision === expectedRevision &&
                value.runResolved &&
                value.gateNotice?.includes('Decision resolved')
              : mode === 'refetch-error'
                ? value.configurationError === 'UNAVAILABLE' && value.templateErrorRendered
                : value.configurationStatus === 'ready' &&
                  value.configurationRevision === expectedRevision &&
                  !value.templateErrorRendered);
          const during = await until(
            mode === 'refetch-gap'
              ? (value) =>
                  requested() &&
                  (view === 'run'
                    ? ['loading', 'stale'].includes(value.runReadStatus) &&
                      (value.runReadRevision ?? -1) < expectedRevision
                    : ['loading', 'stale'].includes(value.configurationStatus) &&
                      (value.configurationRevision ?? -1) < expectedRevision)
              : settled,
            `${view}-${width}-${mode}-before-release`,
          );
          await save(`${view}-${width}-${positions.length}-pending`, during);
          if (!before && view === 'run')
            assert(
              during.gateNotice?.includes('Decision resolved'),
              'The last resolved notice must remain visible during refresh',
            );
          if (
            !before &&
            view === 'evals' &&
            mode === 'refetch-gap' &&
            positions.at(-1)?.mode === 'refetch-error'
          )
            assert(
              during.templateStatus?.includes('could not be refreshed'),
              'The last template failure must remain visible during retry',
            );
          positions.push({ mode: mode + '-before-release', expectedRevision, ...during });
          releaseReplies();
          const value = await until(settled, `${view}-${width}-${mode}-settled`);
          positions.push({ mode, expectedRevision, ...value });
          if (view === 'evals')
            assert(value.templateNoteVisible, 'The measured note must be visible in the recording');
          if (!before && view === 'evals') {
            assert.equal(value.operationHeight, 44, 'Idle operation space must remain reserved');
            assert.equal(value.operationBorder, '0px', 'Idle operation space must be neutral');
          }
          const screenshot = await browserCall('Page.captureScreenshot', { format: 'png' });
          await writeFile(
            path.join(output, `${view}-${width}-${mode}-${positions.length}.png`),
            Buffer.from(screenshot.data, 'base64'),
          );
        }
      });
      const tops = positions.map((value) =>
        view === 'run' ? value.gateTabsTop : value.templateNoteTop,
      );
      assert(tops.every(Number.isFinite), 'The retained content must remain mounted');
      const shift = Math.max(...tops) - Math.min(...tops);
      observations.push({ view, width, shift, positions });
      await save(view + (before ? '' : '-' + width) + '-refetch', { shift, positions });
      if (before) assert(shift > 0, 'The original rendering must reproduce a layout shift');
      else assert.equal(shift, 0, 'Refetch notices cannot move retained content');
    }
  }
  assert(
    !frames.some(({ method }) =>
      /resolveDecision|run\.create|eval\..*(create|launch|update)/i.test(method),
    ),
    'The proof must not issue gate or trial commands',
  );
  await save('refetch-result', {
    result: 'PASS',
    expected: before ? 'original shifts reproduced' : 'stable notices',
    observations,
    requests: frames,
    limit: 'Protocol-fixture rendering proof; no live-run or native acceptance.',
  });
}
