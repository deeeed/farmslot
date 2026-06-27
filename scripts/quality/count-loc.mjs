#!/usr/bin/env node
/**
 * Count lines of code across the farmslot repo from git-tracked files.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HISTORY_PATH = 'docs/reference/loc-history.json';

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp4',
  '.webm',
  '.pdf',
  '.zip',
  '.wav',
  '.map',
]);
const IGNORED_PATH_PARTS = new Set([
  '.git',
  '.omc',
  '.omx',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);
const IGNORED_SUFFIXES = ['.generated.md', '.lock'];

const EXTENSION_LANGUAGE = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.sh': 'Shell',
  '.py': 'Python',
  '.md': 'Markdown',
  '.mdx': 'Markdown',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.css': 'CSS',
  '.html': 'HTML',
};

const KIND_BY_LANGUAGE = {
  TypeScript: 'code',
  JavaScript: 'code',
  Shell: 'code',
  Python: 'code',
  CSS: 'code',
  HTML: 'code',
  Markdown: 'docs',
  JSON: 'config',
  YAML: 'config',
};

const ROLLUP_ORDER = [
  'command-center',
  'companion',
  'gateway',
  'packages',
  'scripts',
  'docs',
  'docs-site',
  'node',
  'projects',
  'infra',
];

function parseArgs(argv) {
  const options = {
    group: 'rollup',
    scope: 'all',
    excludeTests: false,
    excludeDev: false,
    json: false,
    record: false,
    trend: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--exclude-tests':
        options.excludeTests = true;
        break;
      case '--exclude-dev':
        options.excludeDev = true;
        break;
      case '--record':
        options.record = true;
        break;
      case '--trend':
        options.trend = true;
        break;
      case '--group': {
        const value = argv[++i];
        if (!value || !['rollup', 'area', 'both'].includes(value)) {
          console.error('[count-loc] --group must be rollup, area, or both');
          process.exit(1);
        }
        options.group = value;
        break;
      }
      case '--scope': {
        const value = argv[++i];
        if (!value || !['all', 'framework', 'projects'].includes(value)) {
          console.error('[count-loc] --scope must be all, framework, or projects');
          process.exit(1);
        }
        options.scope = value;
        break;
      }
      default:
        console.error(`[count-loc] unknown argument: ${arg}`);
        process.exit(1);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/quality/count-loc.mjs [options]

Count git-tracked lines across the farmslot framework.

Options:
  --group <rollup|area|both>       Grouping (default: rollup)
  --scope <all|framework|projects> File set (default: all)
  --exclude-tests                  Skip *.test.* and /test/ paths
  --exclude-dev                    Skip */src/dev/* harness fixtures
  --record                         Append snapshot to docs/reference/loc-history.json
  --trend                          Show LOC evolution from recorded snapshots
  --json                           Machine-readable output
  --help, -h                       Show this help

Examples:
  yarn quality:loc
  yarn quality:loc --group area --scope framework
  yarn quality:loc --exclude-tests --exclude-dev
  yarn quality:loc --record --scope framework
  yarn quality:loc --trend
  yarn quality:loc --json --group both`);
}

function extensionOf(file) {
  const slash = file.lastIndexOf('/');
  const dot = file.lastIndexOf('.');
  return dot > slash ? file.slice(dot).toLowerCase() : '';
}

function isTestFile(file) {
  const base = path.basename(file);
  return (
    base.includes('.test.') ||
    base.includes('.contract.test.') ||
    file.includes('/__tests__/') ||
    /\/test\//.test(file)
  );
}

function isDevHarnessFile(file, excludeDev) {
  if (!excludeDev) return false;
  return file.includes('/src/dev/');
}

function shouldCount(file, options) {
  const ext = extensionOf(file);
  if (BINARY_EXTENSIONS.has(ext)) return false;
  if (IGNORED_SUFFIXES.some((suffix) => file.endsWith(suffix))) return false;
  if (file.split('/').some((part) => IGNORED_PATH_PARTS.has(part))) return false;
  if (options.excludeTests && isTestFile(file)) return false;
  if (isDevHarnessFile(file, options.excludeDev)) return false;
  return true;
}

function classifyScope(file) {
  if (file.startsWith('projects/') && file !== 'projects/README.md') {
    return 'projects';
  }
  return 'framework';
}

function classifyArea(file) {
  const parts = file.split('/');
  if (parts[0] === 'projects') {
    return parts.length > 1 ? `projects/${parts[1]}` : 'projects';
  }
  if (parts[0] === 'packages' && parts.length > 1) {
    return `packages/${parts[1]}`;
  }
  if (parts[0] === 'services' && parts.length > 1) {
    return `services/${parts[1]}`;
  }
  if (parts[0] === 'apps' && parts.length > 1) {
    if (parts[1] === 'command-center' && parts[2] === 'ui') {
      return 'apps/command-center/ui';
    }
    return `apps/${parts[1]}`;
  }
  if (parts[0] === 'scripts') {
    if (parts.length > 1 && ['quality', 'lib', 'scoring'].includes(parts[1])) {
      return `scripts/${parts[1]}`;
    }
    return 'scripts';
  }
  return parts[0];
}

function classifyRollup(area) {
  if (area === 'apps/command-center' || area === 'apps/command-center/ui') {
    return 'command-center';
  }
  if (area === 'apps/companion') return 'companion';
  if (area === 'apps/docs') return 'docs-site';
  if (area === 'services/gateway') return 'gateway';
  if (area === 'services/node') return 'node';
  if (area.startsWith('packages/')) return 'packages';
  if (area === 'scripts' || area.startsWith('scripts/')) return 'scripts';
  if (area === 'docs') return 'docs';
  if (area.startsWith('projects/')) return 'projects';
  return 'infra';
}

function trackedFiles() {
  const result = spawnSync('git', ['ls-files'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout.split('\n').filter(Boolean);
}

function lineCount(file) {
  const buffer = readFileSync(file);
  if (buffer.includes(0)) return 0;
  const contents = buffer.toString('utf8');
  if (contents.length === 0) return 0;
  return contents.split('\n').length - (contents.endsWith('\n') ? 1 : 0);
}

function emptyBucket() {
  return {
    files: 0,
    total: 0,
    code: 0,
    docs: 0,
    config: 0,
    other: 0,
    languages: {},
  };
}

function addLine(bucket, language, lines) {
  bucket.files += 1;
  bucket.total += lines;
  const kind = KIND_BY_LANGUAGE[language] ?? 'other';
  bucket[kind] += lines;
  bucket.languages[language] = (bucket.languages[language] ?? 0) + lines;
}

function summarize(buckets) {
  return [...buckets.values()].reduce(
    (acc, bucket) => ({
      files: acc.files + bucket.files,
      total: acc.total + bucket.total,
      code: acc.code + bucket.code,
      docs: acc.docs + bucket.docs,
      config: acc.config + bucket.config,
      other: acc.other + bucket.other,
    }),
    { files: 0, total: 0, code: 0, docs: 0, config: 0, other: 0 },
  );
}

function bucketToJson(bucket) {
  return {
    files: bucket.files,
    total: bucket.total,
    code: bucket.code,
    docs: bucket.docs,
    config: bucket.config,
    other: bucket.other,
    languages: bucket.languages,
  };
}

function sortedEntries(buckets, order = null) {
  const entries = [...buckets.entries()];
  if (order) {
    const rank = new Map(order.map((name, index) => [name, index]));
    return entries.sort(
      (a, b) =>
        (rank.get(a[0]) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b[0]) ?? Number.MAX_SAFE_INTEGER) ||
        b[1].total - a[1].total ||
        a[0].localeCompare(b[0]),
    );
  }
  return entries.sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));
}

function printTable(title, entries, totals) {
  console.log(title);
  console.log(
    `${'Area'.padEnd(34)} ${'Files'.padStart(6)} ${'Code'.padStart(9)} ${'Docs'.padStart(8)} ${'Config'.padStart(8)} ${'Total'.padStart(9)}`,
  );
  console.log('-'.repeat(78));
  for (const [name, bucket] of entries) {
    console.log(
      `${name.padEnd(34)} ${String(bucket.files).padStart(6)} ${bucket.code.toLocaleString().padStart(9)} ${bucket.docs.toLocaleString().padStart(8)} ${bucket.config.toLocaleString().padStart(8)} ${bucket.total.toLocaleString().padStart(9)}`,
    );
  }
  console.log('-'.repeat(78));
  console.log(
    `${'TOTAL'.padEnd(34)} ${String(totals.files).padStart(6)} ${totals.code.toLocaleString().padStart(9)} ${totals.docs.toLocaleString().padStart(8)} ${totals.config.toLocaleString().padStart(8)} ${totals.total.toLocaleString().padStart(9)}`,
  );
}

function collect(options) {
  const areas = new Map();
  const rollups = new Map();
  const languages = new Map();

  for (const file of trackedFiles()) {
    if (!existsSync(file) || !shouldCount(file, options)) continue;

    const fileScope = classifyScope(file);
    if (options.scope !== 'all' && fileScope !== options.scope) continue;

    const lines = lineCount(file);
    if (lines === 0) continue;

    const language = EXTENSION_LANGUAGE[extensionOf(file)] ?? 'other';
    const area = classifyArea(file);
    const rollup = classifyRollup(area);

    if (!areas.has(area)) areas.set(area, emptyBucket());
    addLine(areas.get(area), language, lines);

    if (!rollups.has(rollup)) rollups.set(rollup, emptyBucket());
    addLine(rollups.get(rollup), language, lines);

    languages.set(language, (languages.get(language) ?? 0) + lines);
  }

  return { areas, rollups, languages };
}

function gitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) {
    return { version: 1, snapshots: [] };
  }
  return JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
}

function rollupSnapshot(rollups) {
  return Object.fromEntries(
    sortedEntries(rollups, ROLLUP_ORDER).map(([name, bucket]) => [
      name,
      { code: bucket.code, total: bucket.total },
    ]),
  );
}

function buildSnapshot(options, totals, rollups) {
  return {
    recordedAt: new Date().toISOString(),
    commit: gitSha(),
    scope: options.scope,
    exclusions: {
      tests: options.excludeTests,
      dev: options.excludeDev,
    },
    totals: {
      files: totals.files,
      code: totals.code,
      docs: totals.docs,
      config: totals.config,
      total: totals.total,
    },
    rollup: rollupSnapshot(rollups),
  };
}

/** Exported for unit tests — must stay in sync with recordSnapshot guards. */
export function locSnapshotMetricsMatch(last, next) {
  if (!last || !next) return false;
  return (
    last.scope === next.scope &&
    JSON.stringify(last.exclusions) === JSON.stringify(next.exclusions) &&
    JSON.stringify(last.totals) === JSON.stringify(next.totals) &&
    JSON.stringify(last.rollup) === JSON.stringify(next.rollup)
  );
}

function recordSnapshot(options, totals, rollups) {
  const history = loadHistory();
  const snapshot = buildSnapshot(options, totals, rollups);
  const last = history.snapshots.at(-1);
  if (
    last?.commit === snapshot.commit &&
    last.scope === snapshot.scope &&
    JSON.stringify(last.exclusions) === JSON.stringify(snapshot.exclusions)
  ) {
    console.log(`[count-loc] snapshot already recorded for ${snapshot.commit.slice(0, 8)}`);
    return false;
  }
  if (locSnapshotMetricsMatch(last, snapshot)) {
    console.log(
      `[count-loc] LOC metrics unchanged since ${last.commit.slice(0, 8)}; skip recording ${snapshot.commit.slice(0, 8)}`,
    );
    return false;
  }

  history.snapshots.push(snapshot);
  writeFileSync(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`);
  console.log(
    `[count-loc] recorded ${snapshot.totals.code.toLocaleString()} code lines at ${HISTORY_PATH}`,
  );
  return true;
}

function formatDelta(current, previous) {
  if (previous == null) return '—';
  const delta = current - previous;
  if (delta === 0) return '0';
  return `${delta > 0 ? '+' : ''}${delta.toLocaleString()}`;
}

function printTrend(limit = 12) {
  const history = loadHistory();
  const snapshots = history.snapshots.slice(-limit);
  if (snapshots.length === 0) {
    console.log(`[count-loc] no snapshots in ${HISTORY_PATH}; run with --record first`);
    return;
  }

  console.log(`Farmslot LOC trend — last ${snapshots.length} snapshot(s)\n`);
  console.log(
    `${'Date'.padEnd(12)} ${'Commit'.padEnd(9)} ${'Code'.padStart(9)} ${'Δ code'.padStart(9)} ${'Total'.padStart(9)} ${'Δ total'.padStart(9)}`,
  );
  console.log('-'.repeat(62));

  let previous = null;
  for (const snapshot of snapshots) {
    const date = snapshot.recordedAt.slice(0, 10);
    const commit = snapshot.commit.slice(0, 8);
    const code = snapshot.totals.code;
    const total = snapshot.totals.total;
    console.log(
      `${date.padEnd(12)} ${commit.padEnd(9)} ${code.toLocaleString().padStart(9)} ${formatDelta(code, previous?.totals.code).padStart(9)} ${total.toLocaleString().padStart(9)} ${formatDelta(total, previous?.totals.total).padStart(9)}`,
    );
    previous = snapshot;
  }

  const latest = snapshots.at(-1);
  const prior = snapshots.length > 1 ? snapshots.at(-2) : null;
  if (prior) {
    console.log('\nRollup code deltas (latest vs previous):');
    for (const name of ROLLUP_ORDER) {
      const current = latest.rollup[name]?.code;
      const before = prior.rollup[name]?.code;
      if (current == null && before == null) continue;
      console.log(
        `  ${name.padEnd(16)} ${formatDelta(current ?? 0, before).padStart(8)}  (${(current ?? 0).toLocaleString()} code)`,
      );
    }
  }
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}

if (options.trend) {
  printTrend();
  process.exit(0);
}

const { areas, rollups, languages } = collect(options);
const areaTotals = summarize(areas);
const rollupTotals = summarize(rollups);

if (options.record) {
  recordSnapshot(options, areaTotals, rollups);
  if (!options.json) {
    process.exit(0);
  }
}

if (options.json) {
  const payload = {
    scope: options.scope,
    group: options.group,
    exclusions: {
      tests: options.excludeTests,
      dev: options.excludeDev,
    },
    totals: areaTotals,
    languages: Object.fromEntries([...languages.entries()].sort((a, b) => b[1] - a[1])),
  };

  if (options.group === 'rollup' || options.group === 'both') {
    payload.rollup = Object.fromEntries(
      sortedEntries(rollups, ROLLUP_ORDER).map(([name, bucket]) => [name, bucketToJson(bucket)]),
    );
  }
  if (options.group === 'area' || options.group === 'both') {
    payload.areas = Object.fromEntries(
      sortedEntries(areas).map(([name, bucket]) => [name, bucketToJson(bucket)]),
    );
  }

  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const exclusionBits = [
  options.excludeTests ? 'no tests' : null,
  options.excludeDev ? 'no dev harness' : null,
]
  .filter(Boolean)
  .join(', ');

const header = `Farmslot LOC — git-tracked, scope=${options.scope}${exclusionBits ? ` (${exclusionBits})` : ''}`;

if (options.group === 'area') {
  console.log(`${header}\n`);
  printTable('By workspace:', sortedEntries(areas), areaTotals);
} else if (options.group === 'rollup') {
  console.log(`${header}\n`);
  printTable('By product area:', sortedEntries(rollups, ROLLUP_ORDER), rollupTotals);
} else {
  console.log(`${header}\n`);
  printTable('By product area:', sortedEntries(rollups, ROLLUP_ORDER), rollupTotals);
  console.log('');
  printTable('By workspace:', sortedEntries(areas), areaTotals);
}

console.log('\nBy language:');
for (const [language, lines] of [...languages.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${language.padEnd(12)} ${lines.toLocaleString().padStart(9)}`);
}
}
