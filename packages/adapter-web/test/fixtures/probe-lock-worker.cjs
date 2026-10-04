#!/usr/bin/env node
// probe-lock-worker.cjs <cft-bin> <chrome-bin> <cache.json> <probes.log> —
// one resolver process for the cross-process probe-lock test. Its probe
// appends a line to probes.log, waits, and reports a crash; it prints the
// browser the resolver chose.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const resolver = require(path.join(__dirname, '../../src/browser-resolver.cjs'));

const [cftBin, chromeBin, cachePath, probesLog] = process.argv.slice(2);
resolver
  .resolveBrowser({
    env: {},
    cft: () => ({ executable: cftBin }),
    cachePath,
    chromeCandidates: [chromeBin],
    probe: async () => {
      fs.appendFileSync(probesLog, `${process.pid}\n`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      return { ok: false, reason: 'exited during startup (SIGBUS)', transient: false };
    },
  })
  .then(
    (resolution) => {
      process.stdout.write(resolution.bin);
    },
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    },
  );
