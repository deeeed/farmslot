import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function simulatorMetroOrigin() {
  const port = process.env.METRO_PORT;
  assert(/^[1-9]\d*$/.test(port ?? ''), 'Set METRO_PORT to the owned proof stack');
  const host =
    process.env.FARMSLOT_RECIPE_METRO_HOST ??
    process.env.COMPANION_PACKAGER_HOSTNAME ??
    'localhost';
  return `http://${host}:${port}`;
}

export function devClientUrl(origin = simulatorMetroOrigin()) {
  const scheme = process.env.SCHEME ?? 'farmslot-development';
  const url = new URL(`${scheme}://expo-development-client/`);
  url.searchParams.set('url', origin);
  url.searchParams.set('disableOnboarding', '1');
  return url.toString();
}

/** Open the installed client on the proof's Metro, rather than its cached bundle. */
export async function openSimulatorDevClient(simulator, { waitForBridge = true } = {}) {
  execFileSync('xcrun', ['simctl', 'openurl', simulator, devClientUrl()]);
  if (!waitForBridge) return;
  await waitForSimulatorRecipeBridge();
}

/** Select only the native URL confirmation for the owned development app. */
export function simulatorURLConfirmation(tree, appName = 'Farmslot Dev') {
  assert(Array.isArray(tree), 'idb must return a structured native accessibility tree');
  const title = tree.find(
    (node) => node.type === 'StaticText' && node.AXLabel?.includes(`Open in “${appName}”`),
  );
  if (!title) return;
  const buttons = tree.filter(
    (node) => node.type === 'Button' && node.AXLabel === 'Open' && node.enabled === true,
  );
  assert.equal(buttons.length, 1, 'Require exactly one native Open button');
  const frame = buttons[0].frame;
  assert(
    frame &&
      ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(frame[key])) &&
      frame.x >= 0 &&
      frame.y >= 0 &&
      frame.width > 0 &&
      frame.height > 0,
    'Require the actual native Open button frame',
  );
  return {
    title: title.AXLabel,
    frame,
    x: frame.x + frame.width / 2,
    y: frame.y + frame.height / 2,
  };
}

/** Use current screenshot text only when IDB cannot translate system accessibility. */
export function simulatorURLConfirmationFromText(image, display, appName = 'Farmslot Dev') {
  assert(Array.isArray(image.text), 'Require recognized text from the current screenshot');
  const titles = image.text.filter(
    (node) => node.text.replace(/[“”]/g, '"').trim() === `Open in "${appName}"?`,
  );
  if (!titles.length) return;
  const opens = image.text.filter((node) => node.text.trim() === 'Open');
  const cancels = image.text.filter((node) => node.text.trim() === 'Cancel');
  assert.equal(titles.length, 1, 'Require one exact native URL-prompt title');
  assert.equal(opens.length, 1, 'Require one recognized native Open button');
  assert.equal(cancels.length, 1, 'Require one recognized native Cancel button');
  const [title, open, cancel] = [titles[0], opens[0], cancels[0]];
  for (const node of [title, open, cancel])
    assert(
      ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(node[key])) &&
        node.width > 0 &&
        node.height > 0 &&
        node.x >= 0 &&
        node.y >= 0 &&
        node.x + node.width <= 1 &&
        node.y + node.height <= 1,
      'Require valid current screenshot text bounds',
    );
  const openY = open.y + open.height / 2;
  const cancelY = cancel.y + cancel.height / 2;
  assert(
    open.x > cancel.x &&
      Math.abs(openY - cancelY) < 0.03 &&
      title.y > openY &&
      title.y - openY < 0.15,
    'Require the actual native title and button layout',
  );
  const dimensions = display.screen_dimensions;
  assert(
    dimensions &&
      dimensions.width === image.width &&
      dimensions.height === image.height &&
      Number.isFinite(dimensions.width_points) &&
      Number.isFinite(dimensions.height_points) &&
      dimensions.width_points > 0 &&
      dimensions.height_points > 0,
    'Require the selected display dimensions for coordinate input',
  );
  return {
    title: title.text,
    x: (open.x + open.width / 2) * dimensions.width_points,
    y: (1 - openY) * dimensions.height_points,
  };
}

export async function confirmSimulatorURLPrompt(simulator, execute = execFileSync) {
  let raw;
  try {
    raw = execute('idb', ['ui', 'describe-all', '--json', '--udid', simulator], {
      encoding: 'utf8',
      timeout: 10000,
    });
  } catch (error) {
    if (
      !String(error.stderr ?? error.message).includes(
        'No translation object returned for simulator',
      )
    )
      throw error;
    const artifacts = process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR;
    const displayFile = process.env.FARMSLOT_NATIVE_URL_PROMPT_DISPLAY_FILE;
    assert(
      artifacts && displayFile,
      'Screenshot fallback requires the owned proof artifacts and display receipt',
    );
    const display = JSON.parse(readFileSync(displayFile, 'utf8'));
    assert.equal(display.udid, simulator, 'Only the selected simulator may receive native input');
    const screenshot = path.join(artifacts, `native-url-probe-${process.pid}-${Date.now()}.png`);
    execute('xcrun', ['simctl', 'io', simulator, 'screenshot', screenshot], { timeout: 10000 });
    const image = JSON.parse(
      execute(
        'osascript',
        [
          '-l',
          'JavaScript',
          fileURLToPath(new URL('./recognize-simulator-prompt.jxa', import.meta.url)),
          screenshot,
        ],
        { encoding: 'utf8', timeout: 30000 },
      ),
    );
    const target = simulatorURLConfirmationFromText(image, display);
    if (target)
      execute('idb', ['ui', 'tap', String(target.x), String(target.y), '--udid', simulator], {
        timeout: 10000,
      });
    writeFileSync(
      screenshot.replace(/\.png$/, '.json'),
      JSON.stringify({
        simulator,
        probe: 'idb-translation-fallback',
        screenshotSha256: createHash('sha256').update(readFileSync(screenshot)).digest('hex'),
        promptPresent: Boolean(target),
        ...(target ? { ...target, nativeInput: 'idb ui tap' } : {}),
      }),
      { flag: 'wx', mode: 0o600 },
    );
    return Boolean(target);
  }
  const target = simulatorURLConfirmation(JSON.parse(raw));
  if (!target) return false;
  execute('idb', ['ui', 'tap', String(target.x), String(target.y), '--udid', simulator], {
    timeout: 10000,
  });
  if (process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR)
    writeFileSync(
      path.join(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR, `native-url-open-${Date.now()}.json`),
      JSON.stringify({
        simulator,
        ...target,
        accessibilitySha256: createHash('sha256').update(raw).digest('hex'),
        nativeInput: 'idb ui tap',
      }),
      { flag: 'wx', mode: 0o600 },
    );
  return true;
}

export async function waitForSimulatorRecipeBridge({ platform = 'ios', simulator } = {}) {
  const origin = simulatorMetroOrigin();
  // A previous app's pending Metro poll can consume the first status request after relaunch.
  // Wait for a structured reply from the new client before a recipe submits its HUD commands.
  const deadline = Date.now() + 60000;
  for (;;) {
    if (platform === 'ios' && simulator) await confirmSimulatorURLPrompt(simulator);
    const response = await fetch(`${origin}/farmslot-recipe/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: 'status',
        nodeId: 'dev-client-ready',
        payload: {},
        timeout_ms: 4000,
      }),
    });
    const result = await response.json();
    if (response.ok && result.ok && result.platform === platform) return;
    if (response.status !== 504 || Date.now() >= deadline)
      throw new Error(result.error ?? 'The simulator recipe bridge did not become ready');
  }
}

export async function openAndroidDevClient(serial, bundleId, { waitForBridge = true } = {}) {
  openAndroidUrl(serial, bundleId, devClientUrl());
  if (waitForBridge) await waitForSimulatorRecipeBridge({ platform: 'android' });
}

export function openAndroidUrl(serial, bundleId, url) {
  execFileSync('adb', [
    '-s',
    serial,
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    `'${url.toString().replaceAll("'", "'\\''")}'`,
    '-p',
    bundleId,
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv[2], 'url', 'Usage: simulator-dev-client.mjs url <metro-origin>');
  process.stdout.write(devClientUrl(process.argv[3]));
}
