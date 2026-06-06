// chat-tools.test.ts — Direct executor tests (run against live gateway state)
// Usage: tsx services/gateway/src/chat/chat-tools.test.ts

import { chmod, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DIAGNOSTIC_READ_ONLY_TOOLS,
  executeReadOnlyInvestigationTool,
  executeTool,
  INVESTIGATION_TOOLS,
  INVESTIGATOR_MAX_TOOL_ROUNDS,
} from './chat-tools.js';
import { FLEET_TOOLS } from './tool-definitions.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const WRITE_TOOL_NAMES = new Set([
  'send_terminal',
  'cancel_run',
  'resolve_decision',
  'slot_prepare',
  'slot_release',
  'slot_recycle',
  'queue_add',
  'restart_gateway',
  'tmux_send_keys',
  'tmux_select_window',
  'resource_control',
  'fleet_refresh',
  'resource_refresh',
]);

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`${GREEN}PASS${RESET} ${name}`);
    passed++;
  } catch (err) {
    console.log(`${RED}FAIL${RESET} ${name}: ${(err as Error).message}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ─── Tool definition tests ───

await test('FLEET_TOOLS exposes required core tools', async () => {
  const names = new Set(FLEET_TOOLS.map((t) => t.name));
  for (const name of [
    'list_active_runs',
    'operator_snapshot',
    'get_run',
    'run_context_bundle',
    'propose_run_recovery',
    'get_slot',
    'read_farmslot_file',
    'search_farmslot_files',
    'list_farmslot_logs',
    'investigate_gateway_issue',
    'chat_session_context',
    'terminal_snapshot',
    'task_progress',
    'resource_pressure_snapshot',
    'slot_prepare',
    'slot_release',
    'slot_recycle',
    'queue_add',
  ]) {
    assert(names.has(name), `missing core tool ${name}`);
  }
  assert(!names.has('restart_gateway'), 'restart_gateway should not be exposed as a chat tool');
});

await test('all tools have name, description, parameters', async () => {
  for (const t of FLEET_TOOLS) {
    assert(!!t.name, `tool missing name`);
    assert(!!t.description, `${t.name} missing description`);
    assert(!!t.parameters, `${t.name} missing parameters`);
  }
});

await test('no duplicate tool names', async () => {
  const names = FLEET_TOOLS.map((t) => t.name);
  const unique = new Set(names);
  assert(
    names.length === unique.size,
    `duplicate names: ${names.filter((n, i) => names.indexOf(n) !== i)}`,
  );
});

await test('chat write tools do not expose startRef direct checkout primitive', async () => {
  for (const toolName of ['slot_prepare', 'queue_add']) {
    const tool = FLEET_TOOLS.find((t) => t.name === toolName);
    if (!tool) throw new Error(`missing ${toolName}`);
    const schema = JSON.stringify(tool.parameters);
    assert(!schema.includes('startRef'), `${toolName} exposed startRef`);
    assert(!schema.includes('start_ref'), `${toolName} exposed start_ref`);
  }
});

await test('diagnostic read-only tools exclude write and refresh tools', async () => {
  const names = new Set(DIAGNOSTIC_READ_ONLY_TOOLS.map((t) => t.name));
  for (const name of WRITE_TOOL_NAMES) {
    assert(!names.has(name), `diagnostic read-only tools exposed ${name}`);
  }
  assert(names.has('run_context_bundle'), 'missing run_context_bundle');
  assert(names.has('propose_run_recovery'), 'missing propose_run_recovery');
  assert(names.has('investigate_gateway_issue'), 'missing investigate_gateway_issue');
  assert(names.has('resource_pressure_snapshot'), 'missing resource_pressure_snapshot');
});

await test('investigation tools exclude write and refresh tools', async () => {
  for (const tool of INVESTIGATION_TOOLS) {
    assert(!WRITE_TOOL_NAMES.has(tool.name), `investigation tools exposed ${tool.name}`);
  }
  const names = new Set(INVESTIGATION_TOOLS.map((t) => t.name));
  assert(
    !names.has('investigate_gateway_issue'),
    'investigation tools exposed recursive investigator',
  );
});

// ─── Read tool executor tests ───

await test('list_active_runs returns array', async () => {
  const r = await executeTool('list_active_runs', {}, 'test-1');
  assert(!r.isError, `error: ${r.content}`);
  const data = JSON.parse(r.content);
  assert(Array.isArray(data), `expected array, got ${typeof data}`);
  console.log(`  ${DIM}→ ${data.length} active run(s)${RESET}`);
});

await test('get_run with prefix match', async () => {
  // First get a run ID from list
  const listR = await executeTool('list_active_runs', {}, 'test-2a');
  const runs = JSON.parse(listR.content);
  if (runs.length === 0) {
    console.log(`  ${DIM}→ skipped (no active runs)${RESET}`);
    return;
  }
  const prefix = runs[0].id;
  const r = await executeTool('get_run', { run_id: prefix }, 'test-2b');
  assert(!r.isError, `error: ${r.content}`);
  const run = JSON.parse(r.content);
  assert(run.id?.startsWith(prefix), `run ID ${run.id} doesn't start with ${prefix}`);
  console.log(`  ${DIM}→ found run ${run.id.slice(0, 8)} (${run.status})${RESET}`);
});

await test('get_run with invalid ID returns error', async () => {
  const r = await executeTool('get_run', { run_id: 'nonexistent-12345' }, 'test-3');
  assert(!r.isError, 'should not throw');
  const data = JSON.parse(r.content);
  assert(data.error === 'Run not found', `expected "Run not found", got ${JSON.stringify(data)}`);
});

await test('run_context_bundle with invalid ID returns error', async () => {
  const r = await executeTool('run_context_bundle', { run_id: 'nonexistent-12345' }, 'test-3b');
  assert(r.isError, 'expected isError=true');
  assert(r.content.includes('Run not found'), `expected "Run not found", got: ${r.content}`);
});

await test('get_slot with invalid slot returns error', async () => {
  const r = await executeTool('get_slot', { slot_id: 'fake-slot-999' }, 'test-4');
  assert(!r.isError, 'should not throw');
  const data = JSON.parse(r.content);
  assert(data.error === 'Slot not found', `expected "Slot not found", got ${JSON.stringify(data)}`);
});

await test('fleet_refresh returns summary', async () => {
  const r = await executeTool('fleet_refresh', {}, 'test-5');
  assert(!r.isError, `error: ${r.content}`);
  const data = JSON.parse(r.content);
  assert(typeof data.slots === 'number', `expected slots count, got ${JSON.stringify(data)}`);
  assert(data.summary !== undefined, 'missing summary');
  console.log(`  ${DIM}→ ${data.slots} slot(s), ${data.summary.working} working${RESET}`);
});

await test('list_pending_decisions returns array', async () => {
  const r = await executeTool('list_pending_decisions', {}, 'test-6');
  assert(!r.isError, `error: ${r.content}`);
  const data = JSON.parse(r.content);
  assert(data.source === 'decision.list', `expected source=decision.list, got ${data.source}`);
  assert(typeof data.checkedAt === 'string', 'missing checkedAt');
  assert(typeof data.count === 'number', `expected numeric count, got ${typeof data.count}`);
  assert(Array.isArray(data.decisions), `expected decisions array, got ${typeof data.decisions}`);
  assert(
    data.count === data.decisions.length,
    `count ${data.count} did not match decisions length ${data.decisions.length}`,
  );
  console.log(`  ${DIM}→ ${data.count} pending decision(s)${RESET}`);
  if (data.decisions.length > 0) {
    const d = data.decisions[0];
    assert(d.decisionId, 'missing decisionId');
    assert(d.actions?.length > 0, 'missing actions');
    console.log(`  ${DIM}→ first: ${d.type} on run ${d.runId} — "${d.title.slice(0, 60)}"${RESET}`);
  }
});

await test('operator_snapshot returns sourced counts', async () => {
  const r = await executeTool('operator_snapshot', {}, 'test-6b');
  assert(!r.isError, `error: ${r.content}`);
  const data = JSON.parse(r.content);
  assert(data.sources?.pendingDecisions === 'decision.list', 'missing decision source');
  assert(typeof data.counts?.activeRuns === 'number', 'missing activeRuns count');
  assert(Array.isArray(data.activeRuns), 'missing activeRuns array');
  assert(Array.isArray(data.pendingDecisions), 'missing pendingDecisions array');
  console.log(
    `  ${DIM}→ snapshot active=${data.counts.activeRuns}, decisions=${data.counts.pendingDecisions}, queue=${data.counts.queuedItems}${RESET}`,
  );
});

await test('chat_session_context returns session meter', async () => {
  const r = await executeTool('chat_session_context', {}, 'test-6b2');
  assert(!r.isError, `error: ${r.content}`);
  const data = JSON.parse(r.content);
  assert(data.sessionId === 'global', `unexpected session ${data.sessionId}`);
  assert(typeof data.messages?.total === 'number', 'missing message count');
  assert(data.compaction?.status === 'not-implemented', 'missing compaction status');
  assert('remainingInputTokens' in data.contextWindow, 'missing remaining token estimate field');
});

await test('resource_pressure_snapshot returns read-only pressure summary', async () => {
  const r = await executeTool('resource_pressure_snapshot', {}, 'test-6b3');
  assert(!r.isError, `error: ${r.content}`);
  const data = JSON.parse(r.content);
  assert(typeof data.checkedAt === 'string', 'missing checkedAt');
  assert(typeof data.watchAutoStartEnabled === 'boolean', 'missing watch state');
  assert(typeof data.summary?.machines === 'number', 'missing machine count');
  assert(Array.isArray(data.machines), 'missing machines array');
  assert(Array.isArray(data.cleanupCandidates), 'missing cleanup candidates array');
});

await test('read-only investigator guard rejects recursion and write tools', async () => {
  const recursive = await executeReadOnlyInvestigationTool(
    'investigate_gateway_issue',
    {},
    'test-investigator-recursion',
  );
  assert(recursive.isError, 'expected recursive investigator call to be rejected');
  assert(
    recursive.content.includes('not available'),
    `unexpected recursion error: ${recursive.content}`,
  );

  const write = await executeReadOnlyInvestigationTool(
    'send_terminal',
    { slot_id: 'slot', text: 'hi' },
    'test-investigator-write',
  );
  assert(write.isError, 'expected write tool to be rejected');
  assert(write.content.includes('not available'), `unexpected write-tool error: ${write.content}`);

  assert(
    INVESTIGATOR_MAX_TOOL_ROUNDS === 6,
    `unexpected investigator round limit ${INVESTIGATOR_MAX_TOOL_ROUNDS}`,
  );
});

await test('list_farmslot_logs returns array', async () => {
  const r = await executeTool('list_farmslot_logs', {}, 'test-6e');
  assert(!r.isError, `error: ${r.content}`);
  const data = JSON.parse(r.content);
  assert(Array.isArray(data), `expected array, got ${typeof data}`);
  const devLog = data.find((entry: { id?: string }) => entry.id === 'gateway-dev-log');
  assert(devLog, 'missing gateway-dev-log registry entry');
  assert(typeof devLog.displayPath === 'string', 'log entry missing displayPath');
  assert(typeof devLog.exists === 'boolean', 'log entry missing exists flag');
});

await test('registered extra logs are readable by id with redaction', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'farmslot-log-registry-test-'));
  const priorExtraDirs = process.env.FARMSLOT_EXTRA_LOG_DIRS;
  try {
    await writeFile(
      path.join(tempDir, 'gateway.log'),
      [
        'boot ok',
        'token=ghp_abcdefghijklmnopqrstuvwxyz123456',
        'github_pat_abcdefghijklmnopqrstuvwxyz123456',
        'ghv_abcdefghijklmnopqrstuvwxyz123456',
        'xoxe-abcdefghijklmnopqrstuvwxyz123456',
        'xapp-abcdefghijklmnopqrstuvwxyz123456',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(path.join(tempDir, 'prepare 1.log'), 'first collision candidate\n', 'utf-8');
    await writeFile(path.join(tempDir, 'prepare-1.log'), 'second collision candidate\n', 'utf-8');
    process.env.FARMSLOT_EXTRA_LOG_DIRS = tempDir;

    const listed = await executeTool('list_farmslot_logs', {}, 'test-6e-extra-list');
    assert(!listed.isError, `error: ${listed.content}`);
    const logs = JSON.parse(listed.content) as Array<{
      id: string;
      displayPath: string;
      exists: boolean;
    }>;
    const collisionCandidates = logs.filter(
      (entry) =>
        entry.displayPath === '<extra-log-dir-1>/prepare 1.log' ||
        entry.displayPath === '<extra-log-dir-1>/prepare-1.log',
    );
    assert(
      collisionCandidates.length === 2,
      `expected both collision candidate logs, got ${JSON.stringify(collisionCandidates)}`,
    );
    assert(
      new Set(collisionCandidates.map((entry) => entry.id)).size === 2,
      'sanitized log ids should not collide',
    );
    const extra = logs.find((entry) => entry.displayPath === '<extra-log-dir-1>/gateway.log');
    if (!extra) throw new Error(`missing extra log entry in ${listed.content}`);
    assert(extra.exists === true, 'extra log should exist');

    const read = await executeTool(
      'read_farmslot_file',
      { path: extra.id, max_chars: 2000 },
      'test-6e-extra-read',
    );
    assert(!read.isError, `error: ${read.content}`);
    const data = JSON.parse(read.content);
    assert(data.path === '<extra-log-dir-1>/gateway.log', `unexpected log path ${data.path}`);
    assert(data.redacted === true, 'registered log read should be marked redacted');
    assert(
      !data.content.includes('ghp_abcdefghijklmnopqrstuvwxyz123456'),
      'token was not redacted',
    );
    assert(
      !data.content.includes('github_pat_abcdefghijklmnopqrstuvwxyz123456'),
      'GitHub fine-grained token was not redacted',
    );
    assert(
      !data.content.includes('ghv_abcdefghijklmnopqrstuvwxyz123456'),
      'GitHub verifiable token was not redacted',
    );
    assert(
      !data.content.includes('xoxe-abcdefghijklmnopqrstuvwxyz123456'),
      'Slack xoxe token was not redacted',
    );
    assert(
      !data.content.includes('xapp-abcdefghijklmnopqrstuvwxyz123456'),
      'Slack xapp token was not redacted',
    );
    assert(
      data.content.includes('token=[REDACTED_GITHUB_TOKEN]'),
      `unexpected redacted content ${data.content}`,
    );
  } finally {
    if (priorExtraDirs === undefined) {
      delete process.env.FARMSLOT_EXTRA_LOG_DIRS;
    } else {
      process.env.FARMSLOT_EXTRA_LOG_DIRS = priorExtraDirs;
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

await test('duplicate registered log directories emit each real file once', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'farmslot-log-registry-dup-test-'));
  const priorLogDir = process.env.FARMSLOT_LOG_DIR;
  const priorExtraDirs = process.env.FARMSLOT_EXTRA_LOG_DIRS;
  try {
    const logPath = path.join(tempDir, 'gateway.log');
    await writeFile(logPath, 'duplicate dir check\n', 'utf-8');
    process.env.FARMSLOT_LOG_DIR = tempDir;
    process.env.FARMSLOT_EXTRA_LOG_DIRS = tempDir;
    const realLogPath = await realpath(logPath);

    const listed = await executeTool('list_farmslot_logs', {}, 'test-6e-duplicate-dirs');
    assert(!listed.isError, `error: ${listed.content}`);
    const logs = JSON.parse(listed.content) as Array<{ path: string; displayPath: string }>;
    const matches = logs.filter((entry) => entry.path === realLogPath);
    assert(
      matches.length === 1,
      `expected one registry entry for duplicate log path, got ${JSON.stringify(matches)}`,
    );
    assert(
      matches[0]?.displayPath === '<farmslot-logs>/gateway.log',
      `expected canonical production entry to win, got ${matches[0]?.displayPath}`,
    );
  } finally {
    if (priorLogDir === undefined) {
      delete process.env.FARMSLOT_LOG_DIR;
    } else {
      process.env.FARMSLOT_LOG_DIR = priorLogDir;
    }
    if (priorExtraDirs === undefined) {
      delete process.env.FARMSLOT_EXTRA_LOG_DIRS;
    } else {
      process.env.FARMSLOT_EXTRA_LOG_DIRS = priorExtraDirs;
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

await test('registered static /tmp log dedupes against extra /tmp scan', async () => {
  const devLogPath = '/tmp/farmslot-dev.log';
  const priorExtraDirs = process.env.FARMSLOT_EXTRA_LOG_DIRS;
  let createdDevLog = false;
  try {
    await stat(devLogPath).catch(async (err: unknown) => {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        await writeFile(devLogPath, 'static tmp dedupe check\n', 'utf-8');
        createdDevLog = true;
        return;
      }
      throw err;
    });
    process.env.FARMSLOT_EXTRA_LOG_DIRS = '/tmp';
    const realDevLogPath = await realpath(devLogPath);

    const listed = await executeTool('list_farmslot_logs', {}, 'test-6e-static-tmp-dedupe');
    assert(!listed.isError, `error: ${listed.content}`);
    const logs = JSON.parse(listed.content) as Array<{ id: string; path: string }>;
    const matches = logs.filter((entry) => entry.path === realDevLogPath);
    assert(
      matches.length === 1,
      `expected static /tmp dev log to dedupe with extra /tmp scan, got ${JSON.stringify(matches)}`,
    );
    assert(
      matches[0]?.id === 'gateway-dev-log',
      `expected static registry entry to win, got ${matches[0]?.id}`,
    );
  } finally {
    if (priorExtraDirs === undefined) {
      delete process.env.FARMSLOT_EXTRA_LOG_DIRS;
    } else {
      process.env.FARMSLOT_EXTRA_LOG_DIRS = priorExtraDirs;
    }
    if (createdDevLog) await rm(devLogPath, { force: true });
  }
});

await test('unreadable extra log directory does not hide production logs', async () => {
  const prodDir = await mkdtemp(path.join(tmpdir(), 'farmslot-log-registry-prod-test-'));
  const badDir = await mkdtemp(path.join(tmpdir(), 'farmslot-log-registry-bad-test-'));
  const priorLogDir = process.env.FARMSLOT_LOG_DIR;
  const priorExtraDirs = process.env.FARMSLOT_EXTRA_LOG_DIRS;
  try {
    const prodLogPath = path.join(prodDir, 'gateway.log');
    await writeFile(prodLogPath, 'prod survives bad extra dir\n', 'utf-8');
    await chmod(badDir, 0o000);
    process.env.FARMSLOT_LOG_DIR = prodDir;
    process.env.FARMSLOT_EXTRA_LOG_DIRS = badDir;

    const listed = await executeTool('list_farmslot_logs', {}, 'test-6e-unreadable-extra');
    assert(!listed.isError, `error: ${listed.content}`);
    const logs = JSON.parse(listed.content) as Array<{ path: string; displayPath: string }>;
    const realProdLogPath = await realpath(prodLogPath);
    assert(
      logs.some(
        (entry) =>
          entry.path === realProdLogPath && entry.displayPath === '<farmslot-logs>/gateway.log',
      ),
      `missing production log after unreadable extra dir: ${listed.content}`,
    );
  } finally {
    await chmod(badDir, 0o700).catch((err: unknown) => {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    });
    if (priorLogDir === undefined) {
      delete process.env.FARMSLOT_LOG_DIR;
    } else {
      process.env.FARMSLOT_LOG_DIR = priorLogDir;
    }
    if (priorExtraDirs === undefined) {
      delete process.env.FARMSLOT_EXTRA_LOG_DIRS;
    } else {
      process.env.FARMSLOT_EXTRA_LOG_DIRS = priorExtraDirs;
    }
    await rm(prodDir, { force: true, recursive: true });
    await rm(badDir, { force: true, recursive: true });
  }
});

if (process.env.FARMSLOT_SMOKE_INVESTIGATOR === '1') {
  await test('investigate_gateway_issue returns a bounded evidence report', async () => {
    const r = await executeTool(
      'investigate_gateway_issue',
      {
        question:
          'Summarize the current operator snapshot counts and explain whether pending decisions are live data or only static prompt context.',
        focus: 'operator snapshot evidence',
      },
      'test-6f',
    );
    assert(!r.isError, `error: ${r.content}`);
    const data = JSON.parse(r.content);
    assert(
      data.worker?.kind === 'gateway-readonly-investigator',
      'missing investigator worker kind',
    );
    assert(
      typeof data.report === 'string' && data.report.includes('Evidence'),
      'missing evidence report',
    );
    console.log(`  ${DIM}→ investigator report ${data.report.length} chars${RESET}`);
  });
}

await test('queue_list returns array', async () => {
  const r = await executeTool('queue_list', {}, 'test-7');
  assert(!r.isError, `error: ${r.content}`);
  const data = JSON.parse(r.content);
  assert(Array.isArray(data), `expected array, got ${typeof data}`);
  console.log(`  ${DIM}→ ${data.length} queued item(s)${RESET}`);
});

await test('unknown tool returns error', async () => {
  const r = await executeTool('nonexistent_tool', {}, 'test-8');
  assert(r.isError, 'expected isError=true');
  assert(r.content.includes('Unknown tool'), `expected "Unknown tool", got: ${r.content}`);
});

await test('toolCallId and toolName are preserved', async () => {
  const r = await executeTool('list_active_runs', {}, 'my-call-id-123');
  assert(r.toolCallId === 'my-call-id-123', `expected call ID preserved, got ${r.toolCallId}`);
  assert(r.toolName === 'list_active_runs', `expected tool name preserved, got ${r.toolName}`);
});

// ─── Summary ───

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
