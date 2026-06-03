// self-inspection-tools.test.ts — Bounded Farmslot self-inspection tool checks
// Usage: tsx services/gateway/src/chat/self-inspection-tools.test.ts

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { farmslotRoot } from '../fleet/state.js';

import { executeTool } from './chat-tools.js';
import { resolveTaskFileReadPath } from './self-inspection-tools.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

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

function assertThrows(fn: () => unknown, expectedMessage: string) {
  try {
    fn();
  } catch (err) {
    assert(
      (err as Error).message.includes(expectedMessage),
      `expected "${expectedMessage}", got "${(err as Error).message}"`,
    );
    return;
  }
  throw new Error(`expected throw containing "${expectedMessage}"`);
}

await test('read_farmslot_file reads gateway source within scope', async () => {
  const r = await executeTool(
    'read_farmslot_file',
    { path: 'services/gateway/src/chat/tool-definitions.ts', max_chars: 3000 },
    'test-6c',
  );
  assert(!r.isError, `error: ${r.content}`);
  const data = JSON.parse(r.content);
  assert(
    data.path === 'services/gateway/src/chat/tool-definitions.ts',
    `unexpected path ${data.path}`,
  );
  assert(data.content.includes('FLEET_TOOLS'), 'missing expected source content');
});

await test('read_farmslot_file bounds content before returning it', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'farmslot-bounded-log-test-'));
  const priorExtraDirs = process.env.FARMSLOT_EXTRA_LOG_DIRS;
  try {
    await writeFile(path.join(tempDir, 'gateway.log'), 'gateway dev log fixture\n'.repeat(10));
    process.env.FARMSLOT_EXTRA_LOG_DIRS = tempDir;

    const listed = await executeTool('list_farmslot_logs', {}, 'test-6c1-list');
    assert(!listed.isError, `error: ${listed.content}`);
    const logs = JSON.parse(listed.content) as Array<{ id: string; displayPath: string }>;
    const tempLog = logs.find((entry) => entry.displayPath === '<extra-log-dir-1>/gateway.log');
    if (!tempLog) throw new Error(`missing temp log in registry: ${listed.content}`);

    const r = await executeTool(
      'read_farmslot_file',
      { path: tempLog.id, max_chars: 25 },
      'test-6c1',
    );
    assert(!r.isError, `error: ${r.content}`);
    const data = JSON.parse(r.content);
    assert(data.path === '<extra-log-dir-1>/gateway.log', `unexpected display path ${data.path}`);
    assert(typeof data.content === 'string', 'missing content');
    assert(data.content.length <= 25, `content exceeded max_chars: ${data.content.length}`);
  } finally {
    if (priorExtraDirs === undefined) {
      delete process.env.FARMSLOT_EXTRA_LOG_DIRS;
    } else {
      process.env.FARMSLOT_EXTRA_LOG_DIRS = priorExtraDirs;
    }
    await rm(tempDir, { force: true, recursive: true });
  }
});

await test('read_farmslot_file rejects parent symlink scope bypasses', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'farmslot-scope-test-'));
  const linkParent = path.resolve(farmslotRoot, 'services/gateway/src/chat');
  const linkPath = path.join(linkParent, `scope-test-${process.pid}-${Date.now()}`);
  try {
    await mkdir(linkParent, { recursive: true });
    await writeFile(path.join(tempDir, 'secret.txt'), 'outside readable roots', 'utf-8');
    await symlink(tempDir, linkPath, 'dir');
    const r = await executeTool(
      'read_farmslot_file',
      { path: `${linkPath}/secret.txt` },
      'test-6c1b',
    );
    assert(r.isError, 'expected symlinked parent read to be rejected');
    assert(
      r.content.includes('outside approved read scope'),
      `unexpected symlink error: ${r.content}`,
    );
  } finally {
    await rm(linkPath, { force: true, recursive: true });
    await rm(tempDir, { force: true, recursive: true });
  }
});

await test('read_farmslot_file rejects paths outside self-inspection scope', async () => {
  const r = await executeTool('read_farmslot_file', { path: 'pool/example.json' }, 'test-6c2');
  assert(r.isError, 'expected isError=true');
  assert(
    r.content.includes('outside approved self-inspection scope'),
    `unexpected error: ${r.content}`,
  );
});

await test('read_task_file path resolver rejects traversal and non-task direct paths', async () => {
  const directTraversal = () =>
    resolveTaskFileReadPath({ directPath: '../farmslot-evil/secret.json' });
  assertThrows(directTraversal, 'Path outside farmslotRoot');

  const broadDirectRead = () => resolveTaskFileReadPath({ directPath: 'pool/example.json' });
  assertThrows(broadDirectRead, 'must be under a task directory');

  const taskFileTraversal = () =>
    resolveTaskFileReadPath({
      taskFile: `${process.cwd()}/../tasks/run-1/TASK.md`,
      fileSuffix: '../../../farmslot-evil/secret.json',
    });
  assertThrows(taskFileTraversal, 'Path outside run task directory');

  const badStoredTaskFile = () =>
    resolveTaskFileReadPath({
      taskFile: `${farmslotRoot}/pool/example.json`,
      fileSuffix: 'TASK.md',
    });
  assertThrows(badStoredTaskFile, 'must be under a task directory');

  const allowed = resolveTaskFileReadPath({ directPath: 'projects/demo/tasks/run-1/TASK.md' });
  assert(
    allowed.endsWith('projects/demo/tasks/run-1/TASK.md'),
    `unexpected allowed path ${allowed}`,
  );
});

await test('search_farmslot_files searches approved source roots', async () => {
  const r = await executeTool(
    'search_farmslot_files',
    {
      pattern: 'operator_snapshot',
      path_prefix: 'services/gateway/src/chat',
      max_results: 5,
    },
    'test-6d',
  );
  assert(!r.isError, `error: ${r.content}`);
  const data = JSON.parse(r.content);
  assert(Array.isArray(data.matches), 'missing matches array');
  assert(data.matches.length > 0, 'expected at least one match');
});

await test('search_farmslot_files rejects invalid regex patterns', async () => {
  const r = await executeTool(
    'search_farmslot_files',
    {
      pattern: '[unterminated',
      path_prefix: 'services/gateway/src/chat',
      max_results: 5,
    },
    'test-6d2',
  );
  assert(r.isError, 'expected invalid regex to return an error');
  assert(r.content.includes('Invalid search regex'), `unexpected regex error: ${r.content}`);
});

await test('search_farmslot_files rejects nested quantifier regex patterns', async () => {
  const r = await executeTool(
    'search_farmslot_files',
    {
      pattern: '(a+a+)+b',
      path_prefix: 'services/gateway/src/chat',
      max_results: 5,
    },
    'test-6d3',
  );
  assert(r.isError, 'expected ReDoS-prone regex to return an error');
  assert(
    r.content.includes('nested or ambiguous quantifiers'),
    `unexpected regex error: ${r.content}`,
  );
});

await test('search_farmslot_files rejects ambiguous alternation regex patterns', async () => {
  const r = await executeTool(
    'search_farmslot_files',
    {
      pattern: '(a|a)*b',
      path_prefix: 'services/gateway/src/chat',
      max_results: 5,
    },
    'test-6d4',
  );
  assert(r.isError, 'expected ambiguous alternation regex to return an error');
  assert(
    r.content.includes('nested or ambiguous quantifiers'),
    `unexpected regex error: ${r.content}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
