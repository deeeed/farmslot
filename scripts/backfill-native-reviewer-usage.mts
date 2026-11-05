// Offline one-off migration. Dry-run is safe while the gateway runs; --apply refuses a live owner.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { RunnerSessionUsage } from '../packages/protocol/src/index.js';
import {
  nativeSessionUsageArgv,
  type NativeSessionUsageRequest,
} from '../services/gateway/src/runners/native-session-usage-command.js';
import { parseSessionUsageOutput } from '../services/gateway/src/runtime/session-usage-result.js';
import {
  backfillDocument,
  agentSessionRequests,
  sessionCaptureGaps,
  object,
  usageKey,
  visitLegacyUsage,
} from './lib/native-reviewer-usage-backfill.js';

const execute = promisify(execFile);
const flags = process.argv.slice(2);
const option = (name: string) => {
  const index = flags.indexOf(name);
  return index < 0 ? undefined : flags[index + 1];
};
const farm = option('--gateway-root');
const runs = option('--runs-dir');
assert(
  farm && runs,
  'Usage: backfill-native-reviewer-usage.mts --gateway-root <checkout> --runs-dir <data> [--pool-dir <pool>] [--report <file>] [--apply]',
);
const gatewayRoot = path.resolve(farm);
const runsDir = path.resolve(runs);
const apply = flags.includes('--apply');
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const live = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};
async function assertGatewayStopped(): Promise<void> {
  const directory = path.join(gatewayRoot, '.runs');
  for (const file of await readdir(directory))
    if (/^gateway-[0-9]+\.pid$/.test(file)) {
      const pid = Number((await readFile(path.join(directory, file), 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0 && live(pid))
        throw Error(
          `Refusing --apply: gateway pid ${pid} is running. Stop the whole stack before migration.`,
        );
    }
}
if (apply) await assertGatewayStopped();
const peers = new Map<string, string>();
const repos = new Map<string, string>();
const slotNodes = new Map<string, string>();
for (const name of await readdir(option('--pool-dir') ?? path.join(gatewayRoot, 'pool'))) {
  if (!name.endsWith('.json') || name.endsWith('.bak.json')) continue;
  const pool: unknown = JSON.parse(
    await readFile(path.join(option('--pool-dir') ?? path.join(gatewayRoot, 'pool'), name), 'utf8'),
  );
  if (
    !object(pool) ||
    typeof pool.machine !== 'string' ||
    typeof pool.host !== 'string' ||
    !Array.isArray(pool.slots)
  )
    continue;
  peers.set(pool.machine, pool.host);
  for (const slot of pool.slots)
    if (object(slot) && typeof slot.id === 'string' && typeof slot.repo === 'string') {
      repos.set(slot.id, slot.repo);
      slotNodes.set(slot.id, pool.machine);
    }
}
const files = new Map<string, { file: string; bytes: string; document: unknown }>();
for (const directory of [path.join(runsDir, 'archive'), runsDir]) {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
    throw error;
  }
  for (const name of names)
    if (name.endsWith('.json')) {
      const file = path.join(directory, name);
      const bytes = await readFile(file, 'utf8');
      const document: unknown = JSON.parse(bytes);
      if (object(document) && typeof document.id === 'string' && name === document.id + '.json')
        files.set(document.id, { file, bytes, document });
    }
}
// Normal registered providers are declared in the runner layer; no new accounting parser.
const { runnerSessionUsageProviders } =
  await import('../services/gateway/src/runners/session-usage-provider.js');
const jobs = new Map<string, Map<string, NativeSessionUsageRequest>>();
const fileJobs = new Map<string, NativeSessionUsageRequest[]>();
const unresolved: Array<{ runId: string; runner: string; sessionId: string }> = [];
for (const [id, item] of files) {
  const repo =
    object(item.document) && typeof item.document.slotId === 'string'
      ? (repos.get(item.document.slotId) ?? '')
      : '';
  const requests = agentSessionRequests(
    item.document,
    repo,
    (runner) => runnerSessionUsageProviders.get(runner)?.id,
    (slotId) => slotNodes.get(slotId),
  );
  fileJobs.set(id, requests);
  const covered = new Set(requests.map((request) => request.key));
  const missing = new Map<string, { runner: string; runnerSessionId: string }>();
  visitLegacyUsage(item.document, (usage) => {
    if (!covered.has(usageKey(usage.runner, usage.runnerSessionId)))
      missing.set(usageKey(usage.runner, usage.runnerSessionId), usage);
  });
  for (const usage of missing.values())
    unresolved.push({ runId: id, runner: usage.runner, sessionId: usage.runnerSessionId });
  for (const request of requests) {
    const node = request.nativeSession?.executionNodeId ?? request.executionNodeId;
    assert(node, 'Accounting request has no execution node');
    const batch = jobs.get(node) ?? new Map();
    const key = (request.nativeSession?.ownerPrincipalId ?? 'terminal') + ':' + request.key;
    batch.set(key, { ...request, key });
    jobs.set(node, batch);
  }
}
const results = new Map<string, RunnerSessionUsage>();
const failures: Array<{ node: string; sessionId: string; error: string }> = [];
for (const [node, requests] of jobs) {
  const entries = [...requests.values()];
  for (let offset = 0; offset < entries.length; offset += 32) {
    const chunk = entries.slice(offset, offset + 32);
    const argv = nativeSessionUsageArgv(chunk);
    const host = node === 'local' ? undefined : peers.get(node);
    if (node !== 'local' && !host) {
      for (const request of chunk)
        failures.push({
          node,
          sessionId: request.runnerSessionId,
          error: 'No configured SSH host for this execution node',
        });
      continue;
    }
    let output: { stdout: string; stderr: string };
    try {
      output = host
        ? await execute('ssh', ['--', host, argv.map(quote).join(' ')], {
            encoding: 'utf8',
            timeout: 120000,
            maxBuffer: 1024 * 1024,
          })
        : await execute(process.execPath, argv.slice(1), {
            encoding: 'utf8',
            timeout: 120000,
            maxBuffer: 1024 * 1024,
          });
    } catch (error) {
      // An unavailable node leaves its records unchanged and remains explicit in the report.
      for (const request of chunk)
        failures.push({
          node,
          sessionId: request.runnerSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      continue;
    }
    const rows: unknown = JSON.parse(output.stdout);
    assert(Array.isArray(rows) && rows.length === chunk.length, 'Incomplete accounting response');
    const requested = new Map(chunk.map((request) => [request.key, request]));
    for (const row of rows) {
      assert(object(row) && typeof row.key === 'string' && typeof row.runnerSessionId === 'string');
      const request = requested.get(row.key);
      assert(
        request && request.runnerSessionId === row.runnerSessionId,
        'Accounting response changed its requested identity',
      );
      if (typeof row.error === 'string') {
        failures.push({ node, sessionId: request.runnerSessionId, error: row.error });
        continue;
      }
      assert(typeof row.output === 'string' && typeof row.sessionPath === 'string');
      results.set(
        node + ':' + request.key,
        parseSessionUsageOutput(row.output, {
          runner: request.runner,
          runnerSessionId: request.runnerSessionId,
          runnerSessionPath: row.sessionPath,
        }),
      );
    }
  }
}
const changes: Array<{
  runId: string;
  file: string;
  replacements: number;
  beforeSha256: string;
  backup?: string;
}> = [];
const unrepresented: Array<{ runId: string; runner: string; sessionId: string }> = [];
const captureGaps: Array<{
  runId: string;
  role: string;
  sessionId: string | null;
  reason: string;
}> = [];
let lock;
try {
  if (apply)
    lock = await open(path.join(runsDir, '.native-reviewer-usage-backfill.lock'), 'wx', 0o600);
  for (const [id, item] of files) {
    const usages = new Map<string, RunnerSessionUsage>();
    for (const request of fileJobs.get(id) ?? []) {
      const result = results.get(
        (request.nativeSession?.executionNodeId ?? request.executionNodeId) +
          ':' +
          (request.nativeSession?.ownerPrincipalId ?? 'terminal') +
          ':' +
          request.key,
      );
      if (result) usages.set(request.key, result);
    }
    const patched = backfillDocument(item.document, usages);
    for (const gap of sessionCaptureGaps(patched.document)) captureGaps.push({ runId: id, ...gap });
    const written = new Set(patched.sessionKeys);
    for (const request of fileJobs.get(id) ?? [])
      if (usages.has(request.key) && !written.has(request.key))
        unrepresented.push({
          runId: id,
          runner: request.runner,
          sessionId: request.runnerSessionId,
        });
    if (!patched.replacements) continue;
    const beforeSha256 = digest(item.bytes);
    let backup: string | undefined;
    if (apply) {
      await assertGatewayStopped();
      assert.equal(
        digest(await readFile(item.file, 'utf8')),
        beforeSha256,
        `Run changed during accounting: ${id}`,
      );
      backup = item.file + '.f404-' + beforeSha256 + '.bak';
      try {
        await link(item.file, backup);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
          digest(await readFile(backup, 'utf8')) !== beforeSha256
        )
          throw error;
      }
      const temporary = item.file + '.f404-' + process.pid + '.tmp';
      try {
        const writer = await open(temporary, 'wx', 0o600);
        try {
          await writer.writeFile(JSON.stringify(patched.document, null, 2) + '\n');
          await writer.sync();
        } finally {
          await writer.close();
        }
        await rename(temporary, item.file);
        const parent = await open(path.dirname(item.file), 'r');
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      } finally {
        await rm(temporary, { force: true });
      }
    }
    changes.push({
      runId: id,
      file: item.file,
      replacements: patched.replacements,
      beforeSha256,
      ...(backup ? { backup } : {}),
    });
  }
} finally {
  if (lock) {
    await lock.close();
    await rm(path.join(runsDir, '.native-reviewer-usage-backfill.lock'));
  }
}
const report = {
  dryRun: !apply,
  runsScanned: files.size,
  sessionsMeasured: results.size,
  runsChanged: changes.length,
  changes,
  measurements: [...results.entries()].map(([binding, usage]) => ({ binding, usage })),
  failures,
  unresolved,
  unrepresented,
  captureGaps,
};
if (option('--report'))
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(option('--report')!, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }),
  );
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
if (failures.length || unresolved.length || unrepresented.length) process.exitCode = 1;
