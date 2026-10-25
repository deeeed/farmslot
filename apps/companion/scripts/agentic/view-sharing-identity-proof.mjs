#!/usr/bin/env node
// Reads real mounted controls and retained source. It never writes UI/cache values.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEvidenceReviewModel } from '../../../../packages/adapter-sdk/src/evidence.ts';

import { assertPlaybackContinuity } from './view-sharing-playback-evidence.mjs';
import {
  viewSharingArtifactReady,
  viewSharingProfileReady,
  viewSharingRectFits,
  viewSharingScreenReady,
} from './view-sharing-readiness.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const mode = process.argv[2];
if (mode === 'check-import') {
  console.log(JSON.stringify({ status: 'PASS', mode, sourceRoot: root, deviceCalls: 0 }));
} else {
  const caseDir = process.env.FARMSLOT_VIEW_SHARING_CASE;
  const output = process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR;
  assert(caseDir && output);
  const fixtureFile =
    process.env.FARMSLOT_VIEW_SHARING_IDENTITY_FIXTURE ??
    path.join(caseDir, 'identity-fixture.json');
  assert.equal(path.dirname(fixtureFile), caseDir, 'Use only this owned case fixture');
  const fixture = JSON.parse(await readFile(fixtureFile, 'utf8'));
  assert.equal(fixture.sourceRoot, root);
  const save = (name, value) =>
    writeFile(path.join(output, name + '.json'), JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  const rpc = (method, params = {}) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(root, 'apps/command-center/scripts/cdp.mjs'),
          'gateway',
          method,
          JSON.stringify(params),
        ],
        { cwd: root, env: process.env, encoding: 'utf8', timeout: 15000 },
      ),
    );
  const counts = async () => {
    const response = await fetch(process.env.FARMSLOT_VIEW_SHARING_COUNTS_URL, {
      signal: AbortSignal.timeout(3000),
    });
    assert(response.ok);
    const value = await response.json();
    assert.equal(value.caseDir, caseDir);
    assert.equal(value.sourceRoot, root);
    assert.equal(value.startId, process.env.FARMSLOT_VIEW_SHARING_PROXY_START_ID);
    assert.equal(value.failure, null);
    assert.equal(value.mutations.length, 0);
    return value;
  };
  if (mode === 'inspect-source') {
    const { fleet } = rpc('fleet.status');
    assert(Array.isArray(fleet?.slots), 'The canonical fleet response is required');
    const slot = fleet.slots.find((row) => row.slot === fixture.slotId);
    assert.equal(slot?.currentRunId, fixture.currentRunId);
    const { run } = rpc('run.get', { runId: fixture.retainedRunId });
    assert.equal(run.slotId, fixture.slotId);
    assert(!run.reviewWorkspace, 'An ordinary slot-backed run must exercise the refusal');
    const read = rpc('run.recipeRunsForRun', { runId: run.id, includeRecordedEvidence: true });
    assert(read.recordedEvidence?.input);
    assert.deepEqual(read.recordedEvidence.errors, []);
    const model = createEvidenceReviewModel({
      context: 'artifact',
      artifacts: read.recordedEvidence.report.artifactManifest,
      package: read.recordedEvidence.input,
      comparisonSnapshot: read.recordedEvidence.comparisonSnapshot,
      visualReviewAuthority: read.recordedEvidence.visualReviewAuthority,
      visualReviewContext: read.recordedEvidence.visualReviewContext,
      artifactPrefix: read.recordedEvidence.artifactPrefix,
      packagePath: read.recordedEvidence.packagePath,
      contractVersion: read.recordedEvidence.contractVersion,
      readErrors: read.recordedEvidence.errors,
    });
    assert.deepEqual(model.errors, []);
    const recording = model.recordings.find(
      (row) => model.artifactPath(row.videoPath) === fixture.video,
    );
    assert(recording, 'The actual retained video must have a checked timeline');
    const group = model
      .timelineGroups(recording.videoPath)
      .find(
        (row) => row.startMs !== null && row.endMs !== null && row.endMs - row.startMs >= 30000,
      );
    assert(group, 'A measured span of at least30 seconds is required');
    await save(mode, {
      runId: run.id,
      slotId: slot.slot,
      currentRunId: slot.currentRunId,
      noReviewWorkspace: true,
      video: fixture.video,
      group,
      recordingDigest: recording.videoDigest,
      retainedReadErrors: read.recordedEvidence.errors,
    });
  } else if (mode === 'no-commands') {
    await save(mode, await counts());
  } else {
    const { createAgentDeviceClient } = await import('agent-device');
    const device = createAgentDeviceClient({
      stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR,
    });
    const sessions = (await device.sessions.list()).filter(
      (row) => row.device.id === process.env.ADB_SERIAL,
    );
    assert.equal(sessions.length, 1, 'Reuse only the current recipe lease');
    const selection = {
      session: sessions[0].name,
      platform: 'android',
      target: 'mobile',
      serial: process.env.ADB_SERIAL,
    };
    const snapshot = () => device.capture.snapshot({ ...selection, raw: true, depth: 60 });
    const label = (node) => [node.label, node.value].filter(Boolean).join(' ');
    const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
    const paired = async (name, screen, details = {}) => {
      const file = path.join(output, name + '.png');
      await device.capture.screenshot({ ...selection, path: file });
      await save(name, {
        ...details,
        screen,
        screenshotSha256: createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
        observedAt: new Date().toISOString(),
      });
    };
    const pid = () =>
      execFileSync(
        path.join(process.env.ANDROID_HOME, 'platform-tools/adb'),
        ['-s', selection.serial, 'shell', 'pidof', process.env.FARMSLOT_RECIPE_APP_ID],
        { env: process.env, encoding: 'utf8', timeout: 5000 },
      ).trim();
    const safeRect = (screen, node) => {
      const rect = node.rect;
      const windows = screen.nodes.filter(
        (row) =>
          row.depth === 0 &&
          row.rect &&
          [row.rect.x, row.rect.y, row.rect.width, row.rect.height].every(Number.isFinite),
      );
      const viewport = windows.length
        ? {
            width: Math.max(...windows.map((row) => row.rect.x + row.rect.width)),
            height: Math.max(...windows.map((row) => row.rect.y + row.rect.height)),
          }
        : null;
      assert(viewport && rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite));
      assert(
        rect.width > 0 &&
          rect.height > 0 &&
          rect.x >= 0 &&
          rect.y >= 0 &&
          rect.x + rect.width <= viewport.width &&
          rect.y + rect.height <= viewport.height,
      );
      const visited = new Set();
      let parent = node;
      while (parent.parentIndex !== undefined) {
        assert(!visited.has(parent.parentIndex), 'Cyclic native ancestry');
        visited.add(parent.parentIndex);
        parent = screen.nodes.find((row) => row.index === parent.parentIndex);
        assert(parent, 'Missing native ancestor');
        if (/ScrollView/.test(parent.type)) {
          const clip = parent.rect;
          assert(clip && [clip.x, clip.y, clip.width, clip.height].every(Number.isFinite));
          assert(
            rect.x >= clip.x &&
              rect.y >= clip.y &&
              rect.x + rect.width <= clip.x + clip.width &&
              rect.y + rect.height <= clip.y + clip.height,
          );
        }
      }
      return rect;
    };
    const tap = async (screen, node) => {
      assert(node.enabled === true && node.visibleToUser !== false);
      const rect = safeRect(screen, node);
      await device.interactions.press({
        ...selection,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        settle: true,
        verify: true,
      });
      return rect;
    };
    if (mode === 'begin' || mode.startsWith('mounted-')) {
      const until = Date.now() + (mode === 'mounted-video-files' ? 30000 : 12000);
      let screen;
      let profileScrolls = 0;
      let ready = false;
      do {
        screen = await snapshot();
        ready =
          mode === 'begin'
            ? viewSharingProfileReady(screen, {
                gatewayUrl: 'ws://10.0.2.2:' + process.env.FARMSLOT_VIEW_SHARING_PROXY_PORT,
                webBase: process.env.FARMSLOT_VIEW_SHARING_WEB_BASE,
              })
            : mode === 'mounted-video-files'
              ? viewSharingArtifactReady(screen, fixture.video)
              : viewSharingScreenReady(screen, mode.slice('mounted-'.length), fixture.slotId);
        if (ready) break;
        assert(Date.now() < until, 'The actual connected profile or destination did not settle');
        if (
          mode === 'begin' &&
          profileScrolls < 2 &&
          screen.nodes.some((node) => node.identifier === 'companion-screen-settings') &&
          !screen.nodes.some(
            (node) => node.identifier === 'companion-command-center-url-configured-gateway',
          )
        ) {
          const views = screen.nodes.filter(
            (node) => /ScrollView/.test(node.type) && node.rect.y > 0 && node.rect.height > 400,
          );
          assert.equal(views.length, 1, 'Require the current unique Settings scroll viewport');
          const rect = safeRect(screen, views[0]);
          await paired('profile-before-scroll-' + profileScrolls, screen);
          await device.interactions.swipe({
            ...selection,
            from: { x: rect.x + rect.width * 0.5, y: rect.y + rect.height * 0.8 },
            to: { x: rect.x + rect.width * 0.5, y: rect.y + rect.height * 0.2 },
            durationMs: 300,
          });
          profileScrolls += 1;
        }
        await pause();
      } while (!ready);
      await paired(mode === 'begin' ? 'connected-profile' : mode, screen);
      if (mode === 'begin') await save(mode, await counts());
    } else if (
      ['open-settings', 'open-slot', 'open-terminal', 'open-run-terminal', 'open-video'].includes(
        mode,
      )
    ) {
      const destination =
        mode === 'open-settings'
          ? 'settings'
          : mode === 'open-video'
            ? 'artifacts/' +
              fixture.retainedRunId +
              '?artifact=' +
              encodeURIComponent(fixture.video)
            : mode === 'open-run-terminal'
              ? 'run-terminal/' + fixture.retainedRunId + '?contextId=retained-context'
              : 'workspace/slot/' +
                fixture.slotId +
                '/' +
                (mode === 'open-slot' ? 'slot' : 'terminal') +
                '?runId=' +
                fixture.retainedRunId;
      const before = pid();
      await device.apps.open({
        ...selection,
        app: process.env.FARMSLOT_RECIPE_APP_ID,
        url: 'farmslot-development:///' + destination,
        relaunch: false,
        noRecord: true,
      });
      assert.equal(pid(), before);
      await save(mode, { destination, pid: before, appRelaunched: false });
    } else if (mode === 'known-video') {
      const screen = await snapshot();
      for (const id of ['companion-copy-view-link', 'companion-share-view-link']) {
        const rows = screen.nodes.filter((row) => row.identifier === id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].enabled, true);
      }
      assert(!screen.nodes.some((row) => label(row).includes('Web link unavailable')));
      await paired(mode, screen, { sourceVideo: fixture.video, changedSelection: false });
    } else if (['pinned-slot', 'pinned-terminal', 'run-terminal', 'changed-video'].includes(mode)) {
      const expected =
        mode === 'pinned-slot'
          ? 'this pinned slot view'
          : mode === 'pinned-terminal'
            ? 'this pinned slot terminal'
            : mode === 'run-terminal'
              ? 'this run terminal'
              : 'this selected recording or occurrence';
      const until = Date.now() + 12000;
      let screen;
      let found = false;
      do {
        screen = await snapshot();
        found = screen.nodes.some((row) => label(row).includes(expected));
        if (found) break;
        assert(Date.now() < until, 'The exact current selection refusal was not visible');
        await pause();
      } while (!found);
      for (const id of ['companion-copy-view-link', 'companion-share-view-link']) {
        const rows = screen.nodes.filter((row) => row.identifier === id);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].enabled, false);
      }
      const { fleet } = rpc('fleet.status');
      assert(Array.isArray(fleet?.slots), 'The canonical fleet response is required');
      assert.equal(
        fleet.slots.find((row) => row.slot === fixture.slotId)?.currentRunId,
        fixture.currentRunId,
      );
      await paired(mode, screen, {
        expected,
        retainedRunId: fixture.retainedRunId,
        currentRunId: fixture.currentRunId,
        disabledTapPerformed: false,
      });
    } else if (mode === 'select-group') {
      const source = JSON.parse(
        await readFile(process.env.FARMSLOT_VIEW_SHARING_IDENTITY_SOURCE, 'utf8'),
      );
      const until = Date.now() + 15000;
      let screen;
      let target;
      let navigations = 0;
      let previous = '';
      let unchanged = 0;
      do {
        screen = await snapshot();
        const views = screen.nodes.filter(
          (row) =>
            /HorizontalScrollView/.test(row.type) &&
            row.rect.y > 0 &&
            row.rect.width > row.rect.height,
        );
        assert.equal(views.length, 1, 'Require the actual unique recording timeline viewport');
        const viewport = safeRect(screen, views[0]);
        const candidates = screen.nodes.filter(
          (row) =>
            row.identifier === 'evidence-timeline-group' &&
            row.enabled === true &&
            row.visibleToUser !== false,
        );
        target = candidates.find(
          (row) =>
            label(row).includes(source.group.summary) && viewSharingRectFits(viewport, row.rect),
        );
        if (target) break;
        assert(Date.now() < until, 'The checked recording group did not render');
        const fingerprint = JSON.stringify(
          screen.nodes
            .filter((row) => row.identifier === 'evidence-timeline-group')
            .map((row) => [label(row), row.rect]),
        );
        unchanged = fingerprint === previous ? unchanged + 1 : 0;
        assert(unchanged < 2, 'Timeline content did not move after two observed gestures');
        assert(navigations < 4, 'The measured group was not reached within four gestures');
        previous = fingerprint;
        const from = {
          x: viewport.x + viewport.width * 0.8,
          y: viewport.y + viewport.height * 0.25,
        };
        const to = { x: viewport.x + viewport.width * 0.2, y: from.y };
        await paired('before-group-navigation-' + navigations, screen, { viewport, from, to });
        await device.interactions.swipe({ ...selection, from, to, durationMs: 300 });
        navigations += 1;
        await pause();
      } while (!target);
      await paired('before-group-press', screen, { group: source.group });
      const rect = await tap(screen, target);
      await save(mode, {
        group: source.group,
        rect,
        navigations,
        actualEnabledControlPressed: true,
      });
    } else if (mode === 'playback-continuity') {
      const source = JSON.parse(
        await readFile(process.env.FARMSLOT_VIEW_SHARING_IDENTITY_SOURCE, 'utf8'),
      );
      const position = (screen) => {
        const nodes = screen.nodes.filter(
          (row) =>
            /(?:^|[/:])exo_position$/.test(row.identifier ?? '') && row.visibleToUser !== false,
        );
        if (nodes.length !== 1) return null;
        const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(
          String(nodes[0].value || nodes[0].label || '').trim(),
        );
        if (!match) return null;
        return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      };
      const observePosition = async (minimum, expectedWidth) => {
        const until = Date.now() + 14000;
        let screen;
        let value;
        let controlsShown = false;
        let geometrySaved = false;
        do {
          screen = await snapshot();
          const player = screen.nodes.find((row) => row.identifier === 'companion-evidence-video');
          if (
            expectedWidth !== undefined &&
            !(
              Number.isFinite(player?.rect.width) &&
              Math.abs(player.rect.width - expectedWidth) <= 2
            )
          ) {
            assert(Date.now() < until, 'The actual parent did not resize');
            await pause();
            continue;
          }
          value = position(screen);
          if (expectedWidth !== undefined && !geometrySaved) {
            await save('playback-first-resized-tree', {
              screen,
              seconds: value,
              at: Date.now(),
              expectedWidth,
            });
            geometrySaved = true;
          }
          if (value !== null && value >= minimum) return { screen, seconds: value, at: Date.now() };
          if (value === null && !controlsShown) {
            const players = screen.nodes.filter(
              (row) => row.identifier === 'companion-evidence-video',
            );
            assert.equal(players.length, 1);
            assert.equal(players[0].enabled, true);
            const rect = safeRect(screen, players[0]);
            // Read transient controls immediately; settling can outwait their auto-hide.
            await device.interactions.press({
              ...selection,
              x: rect.x + rect.width * 0.25,
              y: rect.y + rect.height * 0.25,
            });
            controlsShown = true;
          }
          if (Date.now() >= until) {
            await paired(
              'playback-unavailable-' + (expectedWidth === undefined ? 'before' : 'after'),
              screen,
              { minimum, expectedWidth, seconds: value, controlsShown },
            );
            throw Error('Actual visible player progress did not reach the measured point');
          }
          await pause();
        } while (Date.now() < until);
        throw Error('Actual player progress was unavailable');
      };
      const before = await observePosition(source.group.startMs / 1000 + 8);
      const appPid = pid();
      const adb = (args) =>
        execFileSync(
          path.join(process.env.ANDROID_HOME, 'platform-tools/adb'),
          ['-s', selection.serial, 'shell', ...args],
          { env: process.env, encoding: 'utf8', timeout: 5000 },
        ).trim();
      const originalSize = adb(['wm', 'size']);
      const physical = /^Physical size: (\d+)x(\d+)$/m.exec(originalSize);
      const override = /^Override size: (\d+)x(\d+)$/m.exec(originalSize);
      assert(physical, 'Require the owned device display size');
      const current = override ?? physical;
      const width = Number(current[1]);
      const height = Number(current[2]);
      assert(width > 0 && height > width, 'Use the current portrait viewport');
      const nextWidth = width + 120;
      const beforePlayer = before.screen.nodes.find(
        (row) => row.identifier === 'companion-evidence-video',
      );
      assert(beforePlayer && Math.abs(beforePlayer.rect.width - width) <= 2);
      const identity = (screen, id) => screen.nodes.find((row) => row.identifier === id)?.label;
      const expectedTitle = identity(before.screen, 'companion-artifact-media-viewer-title');
      const expectedIndex = identity(before.screen, 'companion-artifact-media-viewer-index');
      assert(expectedTitle && expectedIndex, 'Require the actual opening viewer identity');
      await paired('playback-before-resize', before.screen, { ...before, originalSize, nextWidth });
      let failure;
      try {
        adb(['wm', 'size', `${nextWidth}x${height}`]);
        const after = await observePosition(0, nextWidth);
        assert.equal(pid(), appPid);
        assertPlaybackContinuity(before, after);
        await paired('playback-after-resize', after.screen, { ...after, appPid });
        await save(mode, {
          before: { seconds: before.seconds, at: before.at, width },
          after: { seconds: after.seconds, at: after.at, width: nextWidth },
          appPid,
          sameRuntime: true,
          actualViewportResize: true,
        });
      } catch (error) {
        failure = error;
      }
      try {
        adb(['wm', 'size', override ? `${override[1]}x${override[2]}` : 'reset']);
        const restoredSize = adb(['wm', 'size']);
        assert.equal(restoredSize, originalSize, 'Restore the exact original display override');
        await save('viewport-restored', { originalSize, restoredSize });
        if (!failure) {
          const until = Date.now() + 6000;
          let restored;
          let matched = false;
          do {
            restored = await snapshot();
            const player = restored.nodes.find(
              (row) => row.identifier === 'companion-evidence-video',
            );
            const close = restored.nodes.find(
              (row) => row.identifier === 'companion-artifact-media-viewer-close',
            );
            if (
              player &&
              Math.abs(player.rect.width - width) <= 2 &&
              close?.enabled === true &&
              close.visibleToUser !== false &&
              identity(restored, 'companion-artifact-media-viewer-title') === expectedTitle &&
              identity(restored, 'companion-artifact-media-viewer-index') === expectedIndex
            ) {
              matched = true;
              break;
            }
            assert(Date.now() < until, 'The restored viewer lost its identity or controls');
            await pause();
          } while (!matched);
          await paired('playback-restored-view', restored, {
            expectedTitle,
            expectedIndex,
            appPid,
          });
        }
      } catch (error) {
        if (failure)
          throw new AggregateError([failure, error], 'Playback check and viewport restore failed');
        throw error;
      }
      if (failure) throw failure;
    } else throw Error('Unknown identity proof mode ' + mode);
  }
  console.log(JSON.stringify({ status: 'PASS', mode }));
}
