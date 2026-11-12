// Run on a copy containing record JSON and decision journals, never on operator state.
// Create a copy with --copy-from <operator-runs> --runs-copy <new-dir>.
// Measure the same copy before/after with --runs-copy <dir> --output <json>.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { register } from 'tsx/esm/api';

register({ tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) });
const { openRunBundleStore, runBundleHousekeepingPaths, withRunBundleStoreLock } =
  await import('../src/retained.ts');
const { parseRunRecordFile } = await import('../src/collect.ts');
const { isRacyStamp } = await import('@farmslot/protocol');
const { values } = parseArgs({
  options: {
    'runs-copy': { type: 'string' },
    'copy-from': { type: 'string' },
    output: { type: 'string' },
  },
});
assert(values['runs-copy'] && values.output);
if (values['copy-from']) {
  const source = await fsp.realpath(values['copy-from']);
  assert.notEqual(path.resolve(values['runs-copy']), source);
  await fsp.mkdir(values['runs-copy']); // Refuse an existing destination.
  const files = [];
  for (const subdir of ['', 'archive']) {
    const target = path.join(values['runs-copy'], subdir);
    if (subdir) await fsp.mkdir(target);
    let names;
    try {
      names = await fsp.readdir(path.join(source, subdir));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      names = [];
    }
    for (const name of names) {
      const file = path.join(source, subdir, name);
      if (name.endsWith('.json')) {
        if (!parseRunRecordFile(name, await fsp.readFile(file, 'utf8'))) continue;
      } else if (!name.endsWith('.decisions.jsonl')) continue;
      await fsp.copyFile(file, path.join(target, name));
      files.push(path.join(subdir, name));
    }
  }
  await fsp.writeFile(
    path.join(values['runs-copy'], '.inventory-benchmark-copy'),
    JSON.stringify({ source, files }),
  );
}
const runsDir = await fsp.realpath(values['runs-copy']);
const marker = JSON.parse(
  await fsp.readFile(path.join(runsDir, '.inventory-benchmark-copy'), 'utf8'),
);
assert.notEqual(runsDir, path.resolve(marker.source), 'Refuse operator state; benchmark a copy');
const files = marker.files.map((file) => path.join(runsDir, file));
const store = await openRunBundleStore({
  runsDir,
  home: path.join(runsDir, 'benchmark-home'),
  create: true,
});
const newestChange = Math.max(
  ...(await Promise.all(
    files.map(async (file) => {
      const info = await fsp.stat(file);
      return Math.max(info.mtimeMs, info.ctimeMs);
    }),
  )),
);
// Copy creation changes ctime. Wait for the real stamp rule rather than faking the clock.
while (isRacyStamp(newestChange)) await delay(10);
const records = new Set(files.filter((file) => file.endsWith('.json')));
const journals = new Set(files.filter((file) => file.endsWith('.decisions.jsonl')));
const reads = [];
const syncRead = fs.readFileSync;
const asyncRead = fsp.readFile;
const note = (file, started) => {
  file = String(file);
  if (records.has(file) || journals.has(file))
    reads.push({
      file: path.relative(runsDir, file),
      kind: records.has(file) ? 'record' : 'journal',
      ms: performance.now() - started,
    });
};
fs.readFileSync = function (file, ...args) {
  const started = performance.now();
  try {
    return syncRead.call(this, file, ...args);
  } finally {
    note(file, started);
  }
};
fsp.readFile = async function (file, ...args) {
  const started = performance.now();
  try {
    return await asyncRead.call(this, file, ...args);
  } finally {
    note(file, started);
  }
};
syncBuiltinESMExports();
async function pass() {
  reads.length = 0;
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  const lags = [];
  let tick;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - last - 5));
    last = now;
    tick?.();
    tick = undefined;
  }, 5);
  try {
    await new Promise((resolve) => {
      tick = resolve;
    });
    lags.length = 0;
    const started = performance.now();
    const selected = await withRunBundleStoreLock(store, () => runBundleHousekeepingPaths(store));
    const totalMs = performance.now() - started;
    await new Promise((resolve) => {
      tick = resolve;
    });
    return {
      totalMs,
      maxBlockMs: Math.max(...lags),
      loopP99Ms: histogram.percentile(99) / 1e6,
      recordReads: reads.filter((row) => row.kind === 'record').length,
      journalReads: reads.filter((row) => row.kind === 'journal').length,
      reads: [...reads],
      selected,
    };
  } finally {
    clearInterval(probe);
    histogram.disable();
  }
}
let cold, warm;
try {
  cold = await pass();
  warm = await pass();
} finally {
  fs.readFileSync = syncRead;
  fsp.readFile = asyncRead;
  syncBuiltinESMExports();
}
const perFile = [];
for (const file of records) {
  const started = performance.now();
  const raw = await fsp.readFile(file, 'utf8');
  const readMs = performance.now() - started;
  const parsing = performance.now();
  const run = parseRunRecordFile(path.basename(file), raw);
  const parseMs = performance.now() - parsing;
  perFile.push({
    file: path.relative(runsDir, file),
    bytes: Buffer.byteLength(raw),
    readMs,
    parseMs,
    validRun: Boolean(run),
    sha256: createHash('sha256').update(raw).digest('hex'),
  });
}
assert.deepEqual(warm.selected, cold.selected);
const result = {
  node: process.version,
  runsDir,
  records: records.size,
  journals: journals.size,
  cold,
  warm,
  perFile,
  maxParseMs: Math.max(...perFile.map((row) => row.parseMs)),
};
await fsp.writeFile(values.output, JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({
    records: result.records,
    journals: result.journals,
    cold: { ...cold, reads: undefined, selected: undefined },
    warm: { ...warm, reads: undefined, selected: undefined },
    maxParseMs: result.maxParseMs,
  }),
);
