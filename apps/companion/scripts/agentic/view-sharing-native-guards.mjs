#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workerInstructionAttempts } from './terminal-control-replies.mjs';

const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const mode = process.argv[2];
if (mode === 'check-import') {
  const sdk = await import('agent-device');
  assert.equal(typeof sdk.createAgentDeviceClient, 'function');
  console.log(JSON.stringify({ status: 'PASS', sessionCalls: 0, deviceCalls: 0 }));
} else {
  const caseDir = process.env.FARMSLOT_VIEW_SHARING_CASE;
  const artifactDir = process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR;
  assert(caseDir && artifactDir && (await realpath(caseDir)) === caseDir);
  const fixture = JSON.parse(await readFile(path.join(caseDir, 'fixture.json'), 'utf8'));
  assert.equal(fixture.sourceRoot, sourceRoot);
  const save = (name, value) =>
    writeFile(path.join(artifactDir, name + '.json'), JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  const counts = async () => {
    const response = await fetch(process.env.FARMSLOT_VIEW_SHARING_COUNTS_URL, {
      signal: AbortSignal.timeout(3000),
    });
    assert(response.ok);
    const current = await response.json();
    assert.equal(current.caseDir, caseDir);
    assert.equal(current.sourceRoot, sourceRoot);
    assert.equal(current.startId, process.env.FARMSLOT_VIEW_SHARING_PROXY_START_ID);
    assert.equal(current.failure, null);
    return current;
  };
  if (mode === 'begin' || mode === 'no-new-commands') {
    const current = await counts();
    if (mode === 'no-new-commands') {
      const baseline = JSON.parse(await readFile(path.join(artifactDir, 'begin.json'), 'utf8'));
      assert.deepEqual(workerInstructionAttempts(current), workerInstructionAttempts(baseline));
    }
    await save(mode, current);
  } else {
    const { createAgentDeviceClient } = await import('agent-device');
    const device = createAgentDeviceClient({
      stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR,
    });
    const sessions = (await device.sessions.list()).filter(
      (s) => s.device.id === process.env.ADB_SERIAL,
    );
    assert.equal(sessions.length, 1, 'Reuse only this running recipe lease');
    const selection = {
      session: sessions[0].name,
      platform: 'android',
      target: 'mobile',
      serial: process.env.ADB_SERIAL,
    };
    const snapshot = () => device.capture.snapshot({ ...selection, raw: true, depth: 50 });
    if (mode === 'open-settings' || mode === 'open-unsupported') {
      await device.apps.open({
        ...selection,
        app: process.env.FARMSLOT_RECIPE_APP_ID,
        url: 'farmslot-development:///' + (mode === 'open-settings' ? 'settings' : 'workers'),
        relaunch: false,
        noRecord: true,
      });
      if (mode === 'open-settings') {
        // A retained focused editor can leave the IME over the scroll viewport.
        // Use the keyboard API before observing geometry, never a blind app Back.
        await device.command.keyboard({ ...selection, action: 'dismiss' });
      }
    } else if (mode === 'find-url-editor' || mode === 'find-url-editor-restore') {
      const readinessDeadline = Date.now() + 15000;
      let readyScreen;
      do {
        readyScreen = await snapshot();
        if (readyScreen.nodes.some((n) => n.identifier === 'companion-screen-settings')) break;
        assert(Date.now() < readinessDeadline, 'The actual Settings viewport did not mount');
        await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < readinessDeadline);
      const gestures = [];
      let previous = '',
        unchanged = 0,
        found = false;
      let towardsEnd = true;
      for (let i = 0; i < 16; i++) {
        const screen = await snapshot();
        const field = screen.nodes.find(
          (n) => n.identifier === 'companion-command-center-url-configured-gateway',
        );
        const scrolls = screen.nodes.filter(
          (n) =>
            n.identifier === 'companion-screen-settings' &&
            /ScrollView$/.test(n.type ?? '') &&
            n.rect?.height > 200 &&
            n.rect?.width > 200 &&
            n.rect.x >= 0 &&
            n.rect.y >= 0,
        );
        assert.equal(scrolls.length, 1, 'Use a unique actual Settings scroll viewport');
        const rect = scrolls[0].rect;
        if (
          field?.rect &&
          field.rect.y >= rect.y &&
          field.rect.y + field.rect.height <= rect.y + rect.height
        ) {
          found = true;
          break;
        }
        const digest = JSON.stringify(
          screen.nodes.map((n) => [n.identifier, n.label, n.value, n.rect]),
        );
        unchanged = digest === previous ? unchanged + 1 : 0;
        previous = digest;
        if (!field && screen.nodes.some((n) => n.identifier === 'companion-screen-settings-end')) {
          towardsEnd = false;
          unchanged = 0;
        }
        assert(unchanged < 2, 'Settings did not move after two observed swipes');
        const from = {
          x: rect.x + rect.width * 0.5,
          y: rect.y + rect.height * (towardsEnd ? 0.65 : 0.35),
        };
        const to = { x: from.x, y: rect.y + rect.height * (towardsEnd ? 0.35 : 0.65) };
        gestures.push({ rect, from, to });
        await device.interactions.swipe({ ...selection, from, to, durationMs: 250 });
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert(found, 'The actual URL editor was not reached');
      await save(mode, { gestures, found });
    } else if (mode === 'enter-invalid' || mode === 'enter-valid') {
      const id = 'companion-command-center-url-configured-gateway';
      const expected =
        mode === 'enter-invalid'
          ? 'https://user:pass@invalid.example/'
          : process.env.FARMSLOT_VIEW_SHARING_WEB_BASE;
      await device.interactions.press({
        ...selection,
        selector: 'id="' + id + '"',
        settle: true,
        verify: true,
      });
      const adb = path.join(process.env.ANDROID_HOME, 'platform-tools/adb');
      execFileSync(adb, ['-s', selection.serial, 'shell', 'input', 'keycombination', '113', '29'], {
        timeout: 5000,
      });
      execFileSync(adb, ['-s', selection.serial, 'shell', 'input', 'keyevent', '67'], {
        timeout: 5000,
      });
      const quoted = "'" + expected.replaceAll("'", "'\\''") + "'";
      execFileSync(adb, ['-s', selection.serial, 'shell', 'input text ' + quoted], {
        timeout: 10000,
      });
      await device.command.keyboard({ ...selection, action: 'dismiss' });
      const screen = await snapshot();
      const field = screen.nodes.find((n) => n.identifier === id);
      assert.equal(
        field?.value ?? field?.label,
        expected,
        'The actual native editor must contain the typed value',
      );
      await save(mode, { screen, expected, realInput: true });
    } else if (mode === 'invalid-url' || mode === 'restored-url') {
      const screen = await snapshot();
      assert(screen.nodes.some((n) => n.identifier === 'companion-screen-settings'));
      const field = screen.nodes.find(
        (n) => n.identifier === 'companion-command-center-url-configured-gateway',
      );
      const expected =
        mode === 'invalid-url'
          ? 'https://user:pass@invalid.example/'
          : process.env.FARMSLOT_VIEW_SHARING_WEB_BASE;
      assert.equal(field?.value ?? field?.label, expected);
      const message =
        mode === 'invalid-url'
          ? 'Use a reachable HTTPS Command Center URL without credentials, query or fragment.'
          : 'Command Center URL saved';
      assert(screen.nodes.some((n) => n.label === message || n.value === message));
      await device.capture.screenshot({
        ...selection,
        path: path.join(artifactDir, mode + '-observed.png'),
      });
      await save(mode, { screen, expected, message });
    } else if (mode === 'clear-url') {
      const id = 'companion-command-center-url-configured-gateway';
      const before = await snapshot();
      const field = before.nodes.find((n) => n.identifier === id);
      const value = field?.value ?? field?.label;
      assert.equal(value, 'https://user:pass@invalid.example/');
      assert(field.enabled && /EditText$/.test(field.type));
      await device.interactions.press({
        ...selection,
        selector: 'id="' + id + '"',
        settle: true,
        verify: true,
      });
      const adb = path.join(process.env.ANDROID_HOME, 'platform-tools/adb');
      execFileSync(adb, ['-s', selection.serial, 'shell', 'input', 'keyevent', '123'], {
        timeout: 5000,
      });
      execFileSync(
        adb,
        ['-s', selection.serial, 'shell', 'input', 'keyevent', ...Array.from(value, () => '67')],
        { timeout: value.length * 1000 },
      );
      const after = await snapshot();
      const cleared = after.nodes.find((n) => n.identifier === id);
      assert.equal(
        cleared?.value,
        'https://cc.example.org/',
        'Deletion must return the editor to its observed empty-field caption',
      );
      // Accessibility exposes the placeholder as text. Only the subsequent owning Save
      // and exact unset-state guard may claim the setting is empty.
      await save(mode, {
        before,
        after,
        characterCount: value.length,
        actualKeyboardEvents: true,
        emptySettingClaimed: false,
      });
    } else if (mode === 'unset' || mode === 'unsupported') {
      const screen = await snapshot();
      for (const id of ['companion-copy-view-link', 'companion-share-view-link']) {
        const target = screen.nodes.find((n) => n.identifier === id);
        assert(target && target.enabled === false, 'Copy and Share must actually be disabled');
      }
      const reason = screen.nodes.find((n) => n.identifier === 'companion-share-unavailable');
      assert(reason);
      if (mode === 'unset') {
        assert.equal(
          reason.label ?? reason.value,
          'Web link unavailable: set the Command Center URL',
        );
        assert(screen.nodes.some((n) => n.identifier === 'companion-share-settings'));
      } else {
        assert.equal(
          reason.label ?? reason.value,
          'Web link unavailable: this screen has no exact Command Center view.',
        );
        assert(!screen.nodes.some((n) => n.identifier === 'companion-share-settings'));
      }
      await device.capture.screenshot({
        ...selection,
        path: path.join(artifactDir, mode + '.png'),
      });
      await save(mode, { screen, disabled: true, coordinatePress: false });
    } else throw new Error('Unknown native guard mode ' + mode);
  }
  console.log(JSON.stringify({ status: 'PASS', mode }));
}
