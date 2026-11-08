import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { NativeSessionEvent, NativeSessionInfo } from '@farmslot/protocol';

import { captureProcessSources, type ProcessCaptureRequest } from './process-capture.js';

const at = (second: number) => new Date(Date.UTC(2026, 10, 8, 0, 0, second)).toISOString();

interface JournalFixtureEntry {
  info?: NativeSessionInfo;
  event?: NativeSessionEvent;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'process-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const commit = (subject: string, authored: string) => {
    git('add', '.');
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '-qm',
        subject,
      ],
      { env: { ...process.env, GIT_AUTHOR_DATE: authored, GIT_COMMITTER_DATE: at(50) } },
    );
    return git('rev-parse', 'HEAD');
  };
  await writeFile(path.join(repo, 'src/value.ts'), 'PRIVATE_TOOL_PAYLOAD\n');
  const base = commit('test: seed', at(0));
  await writeFile(path.join(repo, 'src/value.ts'), 'fixed\n');
  const fixed = commit('fix: value', at(20));
  const request: ProcessCaptureRequest = {
    contextId: 'worker',
    executionNodeId: 'node',
    repo,
    taskDir: path.join(repo, '.task/current'),
    excludedRoots: [path.join(repo, '.task')],
    baseSha: base,
    verifiedMarkerShas: [],
    endAtMs: Date.parse(at(40)),
  };
  return { root, repo, base, fixed, git, commit, request };
}

function nativeInfo(repo: string): NativeSessionInfo {
  return {
    id: 'session',
    generation: 'generation',
    hostPid: 1,
    runner: 'codex',
    nativeSessionId: 'conversation',
    ownerPrincipalId: 'owner',
    executionNodeId: 'node',
    accountContextId: 'account',
    cwd: repo,
    executable: '/bin/false',
    version: 'fixture',
    mode: 'default',
    accountMode: 'native',
    workerManaged: true,
    workerLeaseId: 'original-lease',
    state: 'idle',
    capabilities: {
      modes: ['default'],
      streaming: true,
      tools: true,
      approvals: true,
      questions: true,
      interrupt: true,
      resume: true,
    },
  };
}

test('native capture reads only its lease and command without repairing an incomplete journal', async (t) => {
  const f = await fixture(t);
  const state = path.join(f.root, 'native');
  await mkdir(path.join(state, 'sessions'), { recursive: true });
  const info = nativeInfo(f.repo);
  const event = (
    sequence: number,
    type: NativeSessionEvent['type'],
    commandId: string,
  ): NativeSessionEvent => ({
    sessionId: info.id,
    generation: info.generation,
    sequence,
    type,
    commandId,
    at: at(sequence),
  });
  const rows: JournalFixtureEntry[] = [
    { info },
    { event: event(1, 'command.accepted', 'original-command') },
    {
      event: {
        ...event(2, 'tool.started', 'original-command'),
        nativeId: 'edit',
        tool: {
          name: 'Edit',
          kind: 'file-edit',
          paths: [path.join(f.repo, 'src/value.ts')],
          input: { old_string: 'PRIVATE_TOOL_PAYLOAD\n', new_string: 'fixed\n' },
        },
      },
    },
    {
      event: {
        ...event(3, 'tool.completed', 'original-command'),
        nativeId: 'edit',
        tool: { name: 'Edit', status: 'completed' },
      },
    },
    { info: { ...info, workerLeaseId: 'successor-lease' } },
    { event: event(4, 'command.accepted', 'successor-command') },
  ];
  const journal = path.join(state, 'sessions/session.journal');
  await writeFile(journal, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await appendFile(journal, '{"event":');
  const before = await readFile(journal);
  await utimes(path.join(f.repo, 'src/value.ts'), 1, 1);
  const indexBefore = await readFile(path.join(f.repo, '.git/index'));
  const result = await captureProcessSources({
    ...f.request,
    nativeSession: {
      sessionId: info.id,
      generation: info.generation,
      executionNodeId: 'node',
      ownerPrincipalId: 'owner',
      leaseId: 'original-lease',
      commandId: 'original-command',
      stateDirectory: path.join(state, 'workers/profile/worker'),
    },
  });
  assert.deepEqual(await readFile(journal), before);
  assert.deepEqual(await readFile(path.join(f.repo, '.git/index')), indexBefore);
  assert.equal(result.historyCoverage.status, 'partial');
  assert.equal(result.edits?.length, 1);
  assert.equal(result.edits?.[0].status, 'observed');
  assert.equal(result.sources.find((source) => source.id === 'history')?.endAt, 3);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOOL_PAYLOAD|successor-command/);
});

test('a pinned historical head never reads the recycled working tree or sorts commits by author time', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, 'README.md'), 'later work\n');
  const later = f.commit('docs: later', '2025-01-01T00:00:00.000Z');
  const first = await captureProcessSources({ ...f.request, headSha: f.fixed });
  assert.deepEqual(
    first.commits?.map((commit) => commit.sha),
    [f.fixed],
  );
  assert.equal(first.sources.find((source) => source.id === 'git')?.headSha, f.fixed);
  assert.deepEqual(first.productPaths, ['src/value.ts']);
  assert.equal(f.git('rev-parse', 'HEAD'), later);
  const all = await captureProcessSources({ ...f.request, headSha: later });
  assert.deepEqual(
    all.commits?.map((commit) => commit.sha),
    [f.fixed, later],
  );
  assert.ok(Date.parse(all.commits![0].authoredAt) > Date.parse(all.commits![1].authoredAt));
  assert.equal(all.markCalls, null, 'missing history is not an observed zero');
});

test('a fresh legacy task request supplies its own clock boundary; a reused conversation stays unattributed', async (t) => {
  const f = await fixture(t);
  const session = path.join(f.root, 'conversation.jsonl');
  const rows = [
    { type: 'session', id: 'conversation', cwd: f.repo },
    {
      type: 'message',
      timestamp: at(1),
      message: {
        role: 'user',
        content: [{ type: 'text', text: `Read ${f.request.taskDir}/TASK.md` }],
      },
    },
    {
      type: 'message',
      timestamp: at(2),
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'mark',
            name: 'bash',
            arguments: { command: `${f.request.taskDir}/mark 14` },
          },
        ],
      },
    },
    {
      type: 'message',
      timestamp: at(3),
      message: { role: 'toolResult', toolCallId: 'mark', isError: false, content: [] },
    },
  ];
  await writeFile(session, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const request = {
    ...f.request,
    format: 'pi-jsonl' as const,
    sessionId: 'conversation',
    sessionPath: session,
    allowInitialTaskPrompt: true,
  };
  const result = await captureProcessSources(request);
  assert.equal(result.historyCoverage.status, 'complete');
  assert.equal(result.markCalls?.[0].status, 'succeeded');
  assert.deepEqual(result.markCalls?.[0].target, { action: 'step', stepNumber: 14 });
  assert.equal(result.sources.find((source) => source.id === 'history')?.notBefore, at(1));
  rows[1].message!.content = [{ type: 'text', text: 'An unrelated earlier task' }];
  await writeFile(session, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const reused = await captureProcessSources(request);
  assert.equal(reused.markCalls, null);
  assert.equal(reused.historyCoverage.status, 'unavailable');
});
