'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');

const FOCUS_LIB = path.join(__dirname, '../src/macos-focus.cjs');
const PREVIOUS = {
  pid: 4242,
  bundlePath: '/Applications/Target.app',
  name: 'Target',
};
const OUR_BROWSER_PID = 1111;
const CHROME = '/Applications/Google Chrome.app';

let root;

// lsappinfo/osascript stand-ins: `front` answers the app named by FRONT;
// osascript records each activation by pid. Tool calls are logged.
function env(front, extra = {}) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'lsappinfo'),
    `#!/bin/bash
echo "$*" >> "${root}/lsappinfo.log"
case "$1" in
  front) echo "ASN:${front}" ;;
  info)
    case "$2" in
      ASN:ours) echo '"Google Chrome"'; echo '    bundle path="${CHROME}"'; echo '    pid = ${OUR_BROWSER_PID} type="Foreground"' ;;
      ASN:operatorchrome) echo '"Google Chrome"'; echo '    bundle path="${CHROME}"'; echo '    pid = 7777 type="Foreground"' ;;
      ASN:other) echo '"Other"'; echo '    bundle path="/Applications/Other.app"'; echo '    pid = 5555 type="Foreground"' ;;
    esac
    ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'osascript'),
    `#!/bin/bash
printf '%s\\n' "\${@: -1}" >> "${root}/activations.log"
echo ok
`,
    { mode: 0o755 },
  );
  return {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FARMSLOT_FOCUS_HOLD: '1',
    ...extra,
  };
}

const lines = (file) =>
  fs.existsSync(path.join(root, file))
    ? fs.readFileSync(path.join(root, file), 'utf8').trim().split('\n').filter(Boolean)
    : [];

// Two restore attempts in one launcher process, as macOS.
function restoreTwice(processEnv, previous = PREVIOUS) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const focus = require(${JSON.stringify(FOCUS_LIB)});
    const previous = ${JSON.stringify(previous)};
    process.stdout.write(JSON.stringify([
      focus.restoreFrontmostIfOurs(previous, [${OUR_BROWSER_PID}]),
      focus.restoreFrontmostIfOurs(previous, [${OUR_BROWSER_PID}]),
    ]));
  `,
    ],
    { env: processEnv, encoding: 'utf8' },
  );
  return JSON.parse(result.stdout);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'macos-focus-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('macOS focus restore after a background launch', () => {
  it('restores the previous app once, by pid, when our browser pid holds the front', () => {
    assert.deepStrictEqual(restoreTwice(env('ours')), ['restored', 'off']);
    assert.deepStrictEqual(lines('activations.log'), ['4242']);
  });

  it('leaves the operator own Chrome alone: same bundle as ours, another pid', () => {
    assert.deepStrictEqual(restoreTwice(env('operatorchrome')), ['kept', 'kept']);
    assert.deepStrictEqual(lines('activations.log'), []);
  });

  it('leaves any other app in front alone', () => {
    assert.deepStrictEqual(restoreTwice(env('other')), ['kept', 'kept']);
    assert.deepStrictEqual(lines('activations.log'), []);
  });

  it('makes no tool call at all with FARMSLOT_FOCUS_HOLD=0', () => {
    assert.deepStrictEqual(restoreTwice(env('ours', { FARMSLOT_FOCUS_HOLD: '0' })), ['off', 'off']);
    assert.deepStrictEqual(lines('lsappinfo.log'), []);
    assert.deepStrictEqual(lines('activations.log'), []);
  });

  it('does nothing without a previous app to give the front back to', () => {
    assert.deepStrictEqual(restoreTwice(env('ours'), null), ['off', 'off']);
    assert.deepStrictEqual(lines('activations.log'), []);
  });

  it('never runs anywhere but macOS', () => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const focus = require(${JSON.stringify(FOCUS_LIB)});
      process.stdout.write(JSON.stringify([focus.captureMacFrontmost(), focus.activateMacAppByPid(4242), focus.restoreFrontmostIfOurs(${JSON.stringify(PREVIOUS)}, [${OUR_BROWSER_PID}])]));
    `,
      ],
      { env: env('ours'), encoding: 'utf8' },
    );
    assert.deepStrictEqual(JSON.parse(result.stdout), [null, false, 'off']);
    assert.deepStrictEqual(lines('lsappinfo.log'), []);
  });
});
