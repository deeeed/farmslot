import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { screenshotForSlot } from './screen-screenshot.js';

/**
 * Fake `xcrun` and `sips` on PATH. `xcrun simctl list` reports `booted` as the
 * booted simulators; `xcrun simctl io` takes `ioSeconds`, then writes a PNG.
 * Every call is appended to `calls`.
 */
function fakeTools(t: test.TestContext, booted: string[], ioSeconds: number) {
  const bin = mkdtempSync(path.join(tmpdir(), 'farmslot-thumb-tools-'));
  const calls = path.join(bin, 'calls');
  writeFileSync(calls, '');
  const devices = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': booted.map((name) => ({
        name,
        udid: `${name}-udid`,
        state: 'Booted',
      })),
    },
  });
  writeFileSync(
    path.join(bin, 'xcrun'),
    [
      '#!/bin/sh',
      `echo "xcrun $*" >> '${calls}'`,
      `if [ "$2" = list ]; then printf '%s' '${devices}'; exit 0; fi`,
      `sleep ${ioSeconds}`,
      'for last; do :; done',
      `printf 'png' > "$last"`,
    ].join('\n'),
  );
  writeFileSync(path.join(bin, 'sips'), `#!/bin/sh\necho "sips $*" >> '${calls}'\n`);
  chmodSync(path.join(bin, 'xcrun'), 0o755);
  chmodSync(path.join(bin, 'sips'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ''}`;
  t.after(() => {
    process.env.PATH = previous;
    rmSync(bin, { recursive: true, force: true });
  });
  return { calls: () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) };
}

test("a slow simulator screenshot leaves the node's event loop free", async (t) => {
  fakeTools(t, ['mm-2'], 1);
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 50);
  try {
    const shot = await screenshotForSlot({ platform: 'ios', iosSimulator: 'mm-2', maxWidth: 0 });
    assert.equal(Buffer.from(shot.data, 'base64').toString(), 'png');
  } finally {
    clearInterval(ticker);
  }
  // A blocking capture lets no timer run for the whole second.
  assert.ok(ticks >= 10, `other work ran during the capture (${ticks} ticks)`);
});

test('a simulator that is not booted is refused without asking it for a screenshot', async (t) => {
  const tools = fakeTools(t, ['mm-2'], 30);
  const started = Date.now();
  await assert.rejects(
    screenshotForSlot({ platform: 'ios', iosSimulator: 'mmrp-1', maxWidth: 0 }),
    /iOS simulator mmrp-1 is not booted/,
  );
  assert.ok(Date.now() - started < 5_000, 'refused at once, not after a hung capture');
  assert.ok(!tools.calls().some((call) => call.includes('simctl io')));
});
