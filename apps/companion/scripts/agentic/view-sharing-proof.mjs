#!/usr/bin/env node
// Real clipboard / mounted-page observations. No app, cache, DOM or store writes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readForegroundClipboard } from './clipboard-probe/read.mjs';
import { workerInstructionAttempts } from './terminal-control-replies.mjs';

const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const mode = process.argv[2];
try {
  if (mode === 'check-import') {
    const sdk = await import('agent-device');
    assert.equal(typeof sdk.createAgentDeviceClient, 'function');
    console.log(JSON.stringify({ status: 'PASS', sourceRoot, sessionCalls: 0, deviceCalls: 0 }));
  } else {
    const caseDir = process.env.FARMSLOT_VIEW_SHARING_CASE;
    const artifactDir = process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR;
    assert(caseDir && artifactDir && path.isAbsolute(caseDir) && path.isAbsolute(artifactDir));
    const fixture = JSON.parse(await readFile(path.join(caseDir, 'fixture.json'), 'utf8'));
    assert.equal(fixture.sourceRoot, sourceRoot);
    assert.equal(await realpath(caseDir), caseDir);
    const save = (name, value) =>
      writeFile(path.join(artifactDir, name + '.json'), JSON.stringify(value, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    const readClipboard = () =>
      readFile(path.join(artifactDir, 'native-clipboard.json'), 'utf8').then(JSON.parse);
    const counts = async () => {
      const response = await fetch(process.env.FARMSLOT_VIEW_SHARING_COUNTS_URL, {
        signal: AbortSignal.timeout(3000),
      });
      assert(response.ok);
      const value = await response.json();
      assert.equal(value.sourceRoot, sourceRoot);
      assert.equal(value.caseDir, caseDir);
      assert(
        process.env.FARMSLOT_VIEW_SHARING_PROXY_START_ID &&
          value.startId === process.env.FARMSLOT_VIEW_SHARING_PROXY_START_ID,
        'The exact retained proxy must serve the whole attempt',
      );
      assert.equal(value.failure, null, 'Passive proxy must remain healthy');
      return value;
    };
    const nativeSession = async () => {
      const stateDir = process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR;
      const serial = process.env.ADB_SERIAL;
      assert(stateDir && serial && process.env.PLATFORM === 'android');
      assert.equal(await realpath(stateDir), stateDir);
      const { createAgentDeviceClient } = await import('agent-device');
      const device = createAgentDeviceClient({ stateDir });
      const sessions = (await device.sessions.list()).filter(
        (session) => session.device.id === serial,
      );
      assert.equal(
        sessions.length,
        1,
        'Reuse the current recipe lease, without opening or restarting the app',
      );
      return {
        device,
        selection: { session: sessions[0].name, platform: 'android', target: 'mobile', serial },
      };
    };
    if (mode === 'begin' || mode === 'no-commands') {
      const observed = await counts();
      assert.equal(
        observed.mutations.length,
        0,
        'Sharing, navigation and reconnect must not execute commands',
      );
      await save(mode, observed);
    } else if (mode === 'open-run') {
      const { device, selection } = await nativeSession();
      await device.apps.open({
        ...selection,
        app: process.env.FARMSLOT_RECIPE_APP_ID,
        url: 'farmslot-development:///workspace/run/' + fixture.runs[0].id + '/timeline',
        relaunch: false,
        noRecord: true,
      });
    } else if (mode === 'wait-editor' || mode === 'wait-editor-menu') {
      const { device, selection } = await nativeSession();
      const deadline = Date.now() + 30000;
      let screen;
      let editorReady = false;
      do {
        screen = await device.capture.snapshot({ ...selection, raw: true, depth: 40 });
        const field = screen.nodes.find((node) => node.identifier === 'worker-voice-instruction');
        const busy = screen.nodes.some((node) => node.identifier === 'worker-voice-progress');
        editorReady = field?.enabled === true && !busy;
        if (editorReady) break;
        assert(
          Date.now() < deadline,
          'The foreground recorder did not settle into an editable draft',
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      assert(editorReady, 'The foreground editor stayed locked');
      await save(mode, { screen, ready: true });
    } else if (mode === 'voice-context' || mode === 'voice-context-menu') {
      const { device, selection } = await nativeSession();
      const screen = await device.capture.snapshot({ ...selection, raw: true, depth: 40 });
      const label = screen.nodes.find((node) => node.identifier === 'worker-voice-context');
      assert(
        label &&
          String(label.label ?? label.value).includes('run=' + fixture.runs[0].id.slice(0, 16)),
        'Recorder must keep the source run context',
      );
      await save(mode, { runId: fixture.runs[0].id, screen });
    } else if (mode === 'review-send') {
      const { device, selection } = await nativeSession();
      const screen = await device.capture.snapshot({ ...selection, raw: true, depth: 40 });
      const field = screen.nodes.find((node) => node.identifier === 'worker-voice-instruction');
      assert.equal(String(field?.value ?? field?.label), 'Report current status.');
      const send = screen.nodes.find((node) => node.identifier === 'worker-voice-send');
      const bubble = screen.nodes.find((node) => node.identifier === 'companion-quick-actions');
      assert(send?.enabled && send.rect && bubble?.rect);
      const a = send.rect,
        b = bubble.rect;
      assert([a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height].every(Number.isFinite));
      assert(a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0);
      assert(
        a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y,
        'The floating action must not cover any part of Send',
      );
      await device.capture.screenshot({
        ...selection,
        path: path.join(artifactDir, 'reviewed-instruction.png'),
      });
      await save(mode, { screen, send, bubble, fullySeparate: true });
    } else if (mode === 'voice-sent' || mode === 'final-counts') {
      const setup = JSON.parse(
        await readFile(
          process.env.FARMSLOT_VIEW_SHARING_WORKER_RECEIPT ??
            path.join(caseDir, 'worker-setup.json'),
          'utf8',
        ),
      );
      const input = (await readFile(setup.inputPath, 'utf8')).trim().split('\n').map(JSON.parse);
      const text = input.map((entry) => entry.data).join('');
      assert(text.includes('run=' + fixture.runs[0].id.slice(0, 16)));
      assert(text.includes('Report current status.'));
      const observed = await counts();
      const instructions = workerInstructionAttempts(observed);
      assert.equal(instructions.length, 1);
      assert.equal(instructions[0].method, 'terminal.worker.input');
      await save(mode, {
        input,
        observed,
        instructionAttempts: instructions,
        rawTransportFramesPreserved: true,
      });
    } else if (mode === 'clipboard') {
      const { selection } = await nativeSession();
      assert.equal(process.env.PLATFORM, 'android');
      assert(
        process.env.FARMSLOT_VIEW_SHARING_CLIPBOARD_PROBE,
        'Use the exact built read-only foreground probe',
      );
      const result = await readForegroundClipboard({
        adb: path.join(process.env.ANDROID_HOME, 'platform-tools/adb'),
        serial: process.env.ADB_SERIAL,
        receiptPath: process.env.FARMSLOT_VIEW_SHARING_CLIPBOARD_PROBE,
        artifactDir,
      });
      assert.equal(result.action, 'read');
      const url = new URL(result.text);
      assert.equal(url.origin + url.pathname, process.env.FARMSLOT_VIEW_SHARING_WEB_BASE);
      assert.equal(url.username, '');
      assert.equal(url.password, '');
      const [route, query] = url.hash.split('?');
      const params = new URLSearchParams(query);
      assert.equal(route, '#run/' + fixture.runs[0].id);
      assert.equal(params.get('panel'), 'timeline');
      assert.equal(params.get('sharedView'), '1');
      assert.notEqual(route, '#run/' + fixture.runs[1].id);
      await save('native-clipboard', {
        url: result.text,
        runId: fixture.runs[0].id,
        panel: 'timeline',
        capturedAt: new Date().toISOString(),
        sdkSession: selection.session,
      });
    } else if (mode === 'share-sheet') {
      const clipboard = await readClipboard();
      const { device, selection } = await nativeSession();
      const screen = await device.capture.snapshot({ ...selection, raw: true, depth: 30 });
      assert(
        screen.nodes.some((node) =>
          [node.label, node.value].some(
            (text) => typeof text === 'string' && text.includes(clipboard.url),
          ),
        ),
        'Native share sheet must expose the identical actual clipboard URL',
      );
      await save('native-share-sheet', { clipboardUrl: clipboard.url, screen });
      await device.capture.screenshot({
        ...selection,
        path: path.join(artifactDir, 'native-share-sheet.png'),
      });
    } else if (mode === 'open-web') {
      const clipboard = await readClipboard();
      const pageId = Number(process.env.FARMSLOT_VIEW_SHARING_WEB_PAGE_ID);
      assert(
        Number.isInteger(pageId) && pageId > 0,
        'Use the exact owned authenticated receiving page',
      );
      const response = JSON.parse(
        execFileSync(
          'mcporter',
          [
            'call',
            'agent-chrome.navigate_page',
            '--args',
            JSON.stringify({ pageId, type: 'url', url: clipboard.url, timeout: 15000 }),
            '--output',
            'json',
          ],
          {
            cwd: sourceRoot,
            env: process.env,
            encoding: 'utf8',
            timeout: 20000,
          },
        ),
      );
      assert(!response.isError, 'The owned receiving page refused navigation');
      // A prior failed module fetch is cached in the current document's module map.
      // Load a fresh document, just as opening the copied URL in a new browser tab does.
      const loaded = JSON.parse(
        execFileSync(
          'mcporter',
          [
            'call',
            'agent-chrome.navigate_page',
            '--args',
            JSON.stringify({ pageId, type: 'reload', ignoreCache: true, timeout: 15000 }),
            '--output',
            'json',
          ],
          {
            cwd: sourceRoot,
            env: process.env,
            encoding: 'utf8',
            timeout: 20000,
          },
        ),
      );
      assert(!loaded.isError, 'The receiving document did not load');
      await save('web-navigation', {
        requestedUrl: clipboard.url,
        pageId,
        successfulToolNavigation: true,
      });
    } else if (mode === 'web-identity') {
      const clipboard = await readClipboard();
      const helper = path.join(sourceRoot, 'apps/command-center/scripts/cdp.mjs');
      const expression = `
      const all = (root) => Array.from(root.querySelectorAll('*')).flatMap(el => [el, ...(el.shadowRoot ? all(el.shadowRoot) : [])]);
      const deadline = Date.now() + 10000;
      let nodes, detail;
      do {
        nodes = all(document); detail = nodes.find(el => el.localName === 'run-detail');
        if (detail?.run?.id === ${JSON.stringify(fixture.runs[0].id)}) break;
        if (Date.now() >= deadline) throw new Error('The copied run did not finish loading');
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (true);
      if (!detail || detail.runId !== ${JSON.stringify(fixture.runs[0].id)} || detail.run?.id !== ${JSON.stringify(fixture.runs[0].id)}) throw new Error('The actual mounted run is not the copied run');
      const panel = nodes.find(el => el.getAttribute('data-shared-run-panel') === 'timeline');
      if (!panel || !panel.getBoundingClientRect().height) throw new Error('Timeline is not mounted');
      return { href: location.href, runId: detail.run.id, title: detail.run.ticketOrPr, panel: 'timeline', text: document.body.innerText };
    `;
      const observed = JSON.parse(
        execFileSync(process.execPath, [helper, 'eval', 'run/' + fixture.runs[0].id, expression], {
          cwd: sourceRoot,
          env: process.env,
          encoding: 'utf8',
        }),
      );
      assert.equal(observed.runId, clipboard.runId);
      assert.equal(new URL(observed.href).origin, new URL(clipboard.url).origin);
      const canonical = new URL(clipboard.url);
      const [view, selection = ''] = canonical.hash.split('?');
      const selectors = new URLSearchParams(selection);
      assert.equal(selectors.get('sharedView'), '1');
      selectors.delete('sharedView');
      canonical.hash = view + (selectors.toString() ? '?' + selectors : '');
      assert.equal(observed.href, canonical.href, 'Only the validated web marker may be consumed');
      const traffic = await counts();
      assert(
        traffic.requests.some(
          (request) =>
            request.method === 'run.get' &&
            request.runId === clipboard.runId &&
            traffic.responses.some(
              (response) =>
                response.connectionId === request.connectionId &&
                response.id === request.id &&
                response.ok &&
                response.runId === clipboard.runId,
            ),
        ),
        'The actual mounted run must also have a successful observed protocol read',
      );
      await save('web-identity', { ...observed, protocolRead: true });
      execFileSync(
        process.execPath,
        [
          helper,
          'screenshot',
          'run/' + fixture.runs[0].id,
          path.join(artifactDir, 'same-run-web.png'),
        ],
        { cwd: sourceRoot, env: process.env, stdio: 'inherit' },
      );
    } else throw new Error('Unknown view-sharing proof phase: ' + mode);
    console.log(JSON.stringify({ status: 'PASS', mode, sourceRoot }));
  }
} catch (error) {
  console.error(JSON.stringify({ mode, failure: error.message, code: error.code }));
  throw error;
}
