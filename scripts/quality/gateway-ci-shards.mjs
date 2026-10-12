import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { formatDuration, isMainModule, REPO_ROOT } from './lib/step-timing.mjs';
import { discoverTests, parseShard, verifyAssignment } from './run-tsx-tests.mjs';

export function verifyGatewayShards(reports, discovered) {
  if (!reports.length) throw new Error('Gateway shard reports are missing');
  const total = reports[0].shard?.total;
  const indices = new Set();
  for (const report of reports) {
    const shard = parseShard(`${report.shard?.index}/${report.shard?.total}`);
    if (shard.total !== total || indices.has(shard.index)) {
      throw new Error('Gateway shard identities disagree or repeat');
    }
    indices.add(shard.index);
    if (
      report.workspace !== 'gateway' ||
      report.status !== 'ok' ||
      !report.assignment?.ok ||
      !Array.isArray(report.files) ||
      report.files.some((file) => file.status !== 'ok')
    ) {
      throw new Error(`Gateway shard ${shard.index} did not pass every assigned file`);
    }
  }
  if (reports.length !== total) throw new Error(`Gateway requires ${total} shard reports`);
  // Reuse the runner's independent file-set check; lane ordering is irrelevant here.
  const coverage = verifyAssignment(discovered, {
    moduleMock: reports.flatMap((report) => report.files.map((entry) => entry.file)),
    serial: [],
    parallel: [],
  });
  if (!coverage.ok) throw new Error(`Gateway shard coverage failed: ${JSON.stringify(coverage)}`);
  return [...reports].sort((left, right) => left.shard.index - right.shard.index);
}

export function shardSummary(reports) {
  return [
    '### Gateway test shards',
    '',
    '| Shard | Test files | Test time |',
    '| --- | ---: | ---: |',
    ...reports.map(
      (report) =>
        `| ${report.shard.index}/${report.shard.total} | ${report.files.length} | ${formatDuration(report.totalMs)} |`,
    ),
    '',
  ].join('\n');
}

if (isMainModule(import.meta.url)) {
  const directory = resolve(process.argv[2]);
  const reports = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      JSON.parse(readFileSync(join(directory, entry.name, 'tsx-tests-gateway.json'), 'utf8')),
    );
  const summary = shardSummary(reports);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (process.env.GATEWAY_SHARDS_RESULT !== 'success') {
    throw new Error(`Gateway shards did not succeed: ${process.env.GATEWAY_SHARDS_RESULT}`);
  }
  const cwd = join(REPO_ROOT, 'services/gateway');
  const discovered = discoverTests(['src'], cwd).map((file) => relative(cwd, file));
  verifyGatewayShards(reports, discovered);
  console.log(`Gateway shards passed: ${discovered.length} files covered exactly once`);
}
