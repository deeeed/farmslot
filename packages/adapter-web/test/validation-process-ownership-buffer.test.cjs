'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, it } = require('node:test');

const { profileProcessPids } = require('../src/validation-process-ownership.cjs');

// A host with many booted iOS simulators lists over 1 MB of processes (4,110
// processes, 1.06 MB on one Mac), and execFileSync's 1 MB default made every
// Extension launch there fail with "spawnSync ps ENOBUFS".
let root;
let savedPath;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-web-ps-buffer-'));
  const fakePs = path.join(root, 'ps');
  fs.writeFileSync(
    fakePs,
    [
      '#!/bin/sh',
      'awk -v profile="$FAKE_PS_PROFILE" \'BEGIN {',
      '  pad = sprintf("%1000s", ""); gsub(/ /, "x", pad);',
      '  for (i = 1; i <= 2100; i++) printf "%d /Library/Developer/CoreSimulator/fake-%s\\n", 10000 + i, pad;',
      '  printf "424242 /Applications/Chrome --user-data-dir=%s --remote-debugging-port=9222\\n", profile',
      "}'",
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  savedPath = process.env.PATH;
  process.env.PATH = `${root}${path.delimiter}${savedPath}`;
});

after(() => {
  process.env.PATH = savedPath;
  delete process.env.FAKE_PS_PROFILE;
  fs.rmSync(root, { recursive: true, force: true });
});

it(
  'finds the profile owner in a process table larger than 1 MB',
  { skip: process.platform === 'win32' },
  () => {
    const profile = path.join(root, 'profile');
    process.env.FAKE_PS_PROFILE = profile;
    assert.deepEqual(profileProcessPids(profile), [424242]);
  },
);
