import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendNativePage,
  NATIVE_FOLLOW_LATEST,
  nativeCommandLockSettled,
  nativeCommandText,
  nativeDeliveryLabel,
  nativeEntryPreview,
  nativeFoldWatched,
  nativeFollowGrew,
  nativeFollowLabel,
  nativeFollowScrolled,
  nativeMessageCancelable,
  nativeMessageDropped,
  nativeMessagePreview,
  nativeMessageShown,
  nativeMessageToggleLabel,
  nativePlanCopyLabel,
  nativePlanOpen,
  nativePlanStepMark,
  nativeSendLabel,
  nativeTimeline,
  type NativeTimelineRow,
  nativeTimelineRows,
  nativeToolLabel,
  nativeWatchTools,
  nativeWork,
  nativeWorkLabel,
  retainNativeMessages,
} from '../../src/client-cache/native-history.js';
import type {
  NativeCommandReceipt,
  NativeSessionEvent,
  NativeSessionPlan,
  NativeSessionReadResult,
} from '../../src/rpc/native-session.js';

function event(
  sequence: number,
  type: NativeSessionEvent['type'],
  text?: string,
): NativeSessionEvent {
  return {
    sessionId: 'session',
    generation: 'generation',
    sequence,
    type,
    commandId: 'command',
    at: '2026-09-12T00:00:00Z',
    text,
  };
}
function page(events: NativeSessionEvent[]): NativeSessionReadResult {
  return {
    session: {
      id: 'session',
      generation: 'generation',
      hostPid: 0,
      runner: 'fixture',
      nativeSessionId: 'conversation',
      ownerPrincipalId: 'owner',
      executionNodeId: 'local',
      accountContextId: 'owner',
      cwd: '/fixture',
      executable: '',
      version: 'fixture',
      mode: 'default',
      accountMode: 'native',
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
    },
    events,
    cursor: events.at(-1)?.sequence ?? 0,
    hasMore: false,
    commands: [],
    pendingRequests: [],
  };
}

test('task replay starts at an absolute lease boundary and empty histories preserve that cursor', () => {
  const first = appendNativePage(
    { events: [], cursor: 40 },
    page([event(41, 'text.delta', 'owned')]),
  );
  assert.equal(first.cursor, 41);
  assert.deepEqual(
    first.events.map((item) => item.sequence),
    [41],
  );
  assert.equal(
    appendNativePage({ events: [], cursor: 40 }, { ...page([]), cursor: 40 }).cursor,
    40,
  );
  assert.throws(
    () => appendNativePage({ events: [], cursor: 40 }, page([event(42, 'text.delta')])),
    /gap/,
  );
});

test('replay ignores duplicate pages and refuses gaps or other session events', () => {
  const first = appendNativePage(
    { events: [], cursor: 0 },
    page([event(1, 'command.submitted', 'task')]),
  );
  const next = appendNativePage(
    first,
    page([event(1, 'command.submitted', 'task'), event(2, 'text.delta', 'answer')]),
  );
  assert.equal(next.events.length, 2);
  assert.equal(next.cursor, 2);
  assert.throws(() => appendNativePage(first, page([event(3, 'text.delta')])), /gap/);
  assert.throws(
    () => appendNativePage(first, page([{ ...event(2, 'text.delta'), sessionId: 'other' }])),
    /changed session/,
  );
});

test('transcript restores old accepted-only prompts and deduplicates submitted prompts', () => {
  assert.equal(nativeTimeline([event(1, 'command.accepted', 'old prompt')])[0].text, 'old prompt');
  const timeline = nativeTimeline([
    event(1, 'command.submitted', 'task'),
    event(2, 'command.accepted', 'task'),
    event(3, 'text.delta', 'first '),
    event(4, 'text.delta', 'second'),
  ]);
  assert.deepEqual(
    timeline.map((entry) => [entry.kind, entry.text]),
    [
      ['user', 'task'],
      ['assistant', 'first second'],
    ],
  );
  assert.equal(nativeDeliveryLabel(), 'Delivery unknown');
  assert.equal(
    nativeDeliveryLabel({
      commandId: 'c',
      generation: 'g',
      state: 'unknown',
      submitted: true,
      accepted: false,
    }),
    'Awaiting runner acceptance',
  );
});

test('explicit generation replacement releases an old unknown delivery without replay', () => {
  const receipt = {
    commandId: 'command',
    generation: 'old',
    state: 'unknown' as const,
    submitted: true,
    accepted: false,
  };
  assert.equal(nativeCommandLockSettled(receipt, 'old', receipt), false);
  assert.equal(nativeCommandLockSettled(receipt, 'new', receipt), true);
  assert.equal(nativeCommandLockSettled({ commandId: 'command', generation: 'new' }, 'new'), false);
});

test('terminal replay releases an aged-out receipt only for the same command and generation', () => {
  const command = { commandId: 'command', generation: 'generation' };
  const terminal = event(1, 'turn.completed');
  assert.equal(nativeCommandLockSettled(command, 'generation', undefined, [terminal]), true);
  assert.equal(
    nativeCommandLockSettled(command, 'generation', undefined, [
      { ...terminal, commandId: 'different' },
    ]),
    false,
  );
  assert.equal(
    nativeCommandLockSettled(command, 'generation', undefined, [
      { ...terminal, generation: 'different' },
    ]),
    false,
  );
  assert.equal(
    nativeCommandLockSettled(command, 'generation', undefined, [event(1, 'command.accepted')]),
    false,
  );
  assert.equal(nativeCommandLockSettled(command, 'generation'), false);
});

test('an error without display text never renders as successful completion', () => {
  assert.equal(nativeTimeline([event(1, 'error')])[0].text, 'Runner error');
});

test('interleaved tool results preserve names and inputs without crossing generations', () => {
  const start = (sequence: number, id: string): NativeSessionEvent => ({
    ...event(sequence, 'tool.started'),
    nativeId: id,
    tool: { name: id, input: { path: id } },
  });
  const complete = (sequence: number, id: string): NativeSessionEvent => ({
    ...event(sequence, 'tool.completed'),
    nativeId: id,
    tool: { name: 'Generic tool', output: id, status: 'completed' },
  });
  const timeline = nativeTimeline([
    start(1, 'Read'),
    start(2, 'Edit'),
    complete(3, 'Edit'),
    complete(4, 'Read'),
    { ...start(5, 'Read'), generation: 'next' },
  ]);
  assert.equal(timeline.length, 3);
  assert.deepEqual(timeline[0].event.tool, {
    name: 'Read',
    input: { path: 'Read' },
    output: 'Read',
    status: 'completed',
  });
  assert.equal(timeline[1].event.tool?.output, 'Edit');
  assert.equal(timeline[2].event.type, 'tool.started');
  assert.equal(timeline[2].event.tool?.output, undefined);
});

test('a typed tool reads as what it does; an untyped one keeps the runner name', () => {
  assert.equal(
    nativeToolLabel({ name: 'commandExecution', kind: 'command', command: 'npm test\n--watch' }),
    'Run npm test',
  );
  assert.equal(
    nativeToolLabel({ name: 'Edit', kind: 'file-edit', paths: ['src/a.ts', 'src/b.ts'] }),
    'Change a.ts, b.ts',
  );
  assert.equal(
    nativeToolLabel({ name: 'fileChange', kind: 'file-edit', paths: ['a', 'b', 'c', 'd', 'e'] }),
    'Change a, b, c and 2 more',
  );
  assert.equal(
    nativeToolLabel({ name: 'Read', kind: 'file-read', paths: ['/w/x.md'] }),
    'Read x.md',
  );
  assert.equal(nativeToolLabel({ name: 'Grep', kind: 'search', paths: ['src'] }), 'Search src');
  assert.equal(nativeToolLabel({ name: 'Glob', kind: 'search', paths: ['/w/src/'] }), 'Search src');
  // No subject, no kind, or a kind without a verb: the runner's own name.
  assert.equal(nativeToolLabel({ name: 'Bash', kind: 'command' }), 'Bash');
  assert.equal(nativeToolLabel({ name: 'WebFetch', kind: 'web' }), 'WebFetch');
  assert.equal(nativeToolLabel({ name: 'mcp__x', kind: 'other', paths: ['a'] }), 'mcp__x');
  assert.equal(nativeToolLabel({ name: 'commandExecution' }), 'commandExecution');
  assert.equal(
    nativeToolLabel({ name: 'Bash', kind: 'command', command: 'x'.repeat(200) }).length,
    121,
  );

  const started = { ...event(1, 'tool.started'), nativeId: 'tool' };
  const command = { name: 'Bash', kind: 'command' as const, command: 'npm test' };
  assert.equal(nativeTimeline([{ ...started, tool: command }])[0].text, 'Run npm test');
  // The command arrives only with the completion (Cursor): the row reads it then, same key.
  const late = nativeTimeline([
    { ...started, tool: { name: 'Run command', kind: 'command' } },
    { ...event(2, 'tool.completed'), nativeId: 'tool', tool: { ...command, name: 'Run command' } },
  ]);
  assert.deepEqual(
    late.map(({ key, text }) => [key, text]),
    [[1, 'Run npm test']],
  );
  const work = nativeWork([event(0, 'turn.started'), { ...started, tool: command }]);
  assert.equal(
    work && nativeWorkLabel(work, Date.parse('2026-09-12T00:00:05Z')),
    'Working · 5s · Run npm test',
  );
});

test('a command card shows what it ran and the end of its output', () => {
  const lines = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join('\n');
  const text = nativeCommandText({
    name: 'Bash',
    kind: 'command',
    command: 'npm test',
    output: `${lines}\n`,
  });
  assert.equal(text?.split('\n').slice(0, 3).join('|'), '$ npm test|… 35 earlier lines|line 36');
  assert.equal(text?.split('\n').at(-1), 'line 45');
  // Text blocks, as Claude and ACP return them.
  assert.equal(
    nativeCommandText({
      name: 'Bash',
      kind: 'command',
      command: 'pwd',
      output: [{ type: 'text', text: '/w' }],
    }),
    '$ pwd\n/w',
  );
  assert.equal(
    nativeCommandText({
      name: 'x',
      kind: 'command',
      command: 'ls',
      output: [{ content: { text: 'a' } }],
    }),
    '$ ls\na',
  );
  assert.equal(nativeCommandText({ name: 'Bash', kind: 'command', command: 'true' }), '$ true');
  // A process result, as Cursor returns it.
  assert.equal(
    nativeCommandText({
      name: 'Run npm test',
      kind: 'command',
      command: 'npm test',
      output: { exitCode: 1, stdout: 'ran 3\n', stderr: '1 failed\n' },
    }),
    '$ npm test\nran 3\n1 failed',
  );
  assert.equal(
    nativeCommandText({
      name: 'Bash',
      kind: 'command',
      command: 'npm test',
      output: '\x1b]0;title\x07\x1b[32m✔ passed\x1b[0m',
    }),
    '$ npm test\n✔ passed',
  );
  // A progress meter's carriage returns start lines, as on the terminal screen.
  assert.equal(
    nativeCommandText({
      name: 'Bash',
      kind: 'command',
      command: 'curl -o a.tgz x',
      output: ' 10%\r 60%\r100%\r\n',
    }),
    '$ curl -o a.tgz x\n 10%\n 60%\n100%',
  );
  // A heredoc shows its first line; the whole command is in the raw card.
  assert.equal(
    nativeCommandText({
      name: 'Bash',
      kind: 'command',
      command: "cat <<'EOF'\nhi\nEOF",
      output: 'hi',
    }),
    "$ cat <<'EOF' …\nhi",
  );
  // Output that is not text keeps the raw card, rather than looking like no output.
  assert.equal(
    nativeCommandText({ name: 'x', kind: 'command', command: 'ls', output: [{ type: 'image' }] }),
    undefined,
  );
  assert.equal(
    nativeCommandText({
      name: 'x',
      kind: 'command',
      command: 'ls',
      output: { stdout: '', stderr: '' },
    }),
    '$ ls',
  );
  // Any other tool keeps its raw card.
  assert.equal(nativeCommandText({ name: 'Edit', kind: 'file-edit', paths: ['a'] }), undefined);
  assert.equal(nativeCommandText({ name: 'Bash', kind: 'command' }), undefined);
});

test('a resolved request stays in the conversation with its decision or answers', () => {
  const approval = { id: 'approval', title: 'Allow runner action?', detail: 'rm -r build' };
  const question = {
    id: 'question',
    title: 'Answer runner questions',
    questions: [
      { id: 'file', prompt: 'Which file?', options: [{ label: 'a.ts' }, { label: 'b.ts' }] },
    ],
  };
  const resolved = (
    sequence: number,
    request?: NativeSessionEvent['request'],
    response?: NativeSessionEvent['response'],
  ): NativeSessionEvent => ({ ...event(sequence, 'approval.resolved'), request, response });
  const timeline = nativeTimeline([
    { ...event(1, 'tool.started'), nativeId: 'tool', tool: { name: 'Bash' } },
    resolved(2, approval, { decision: 'approve' }),
    resolved(3, approval, { decision: 'deny' }),
    resolved(4, question, { answers: { file: ['a.ts', 'b.ts'] } }),
    resolved(5, approval),
    resolved(6, question),
    // A runner's own notice for a request already resolved here carries no request.
    resolved(7),
    { ...event(8, 'turn.completed'), status: 'completed' },
  ]);
  assert.deepEqual(
    timeline.filter((entry) => entry.kind === 'resolution').map((entry) => entry.text),
    [
      'Approved: rm -r build',
      'Declined: rm -r build',
      'Answered: Which file? → a.ts, b.ts',
      'Resolved: rm -r build',
      'Resolved: Which file?',
    ],
  );
  // Not a tool call: folding the finished turn leaves it in view.
  const rows = nativeTimelineRows(timeline);
  assert.deepEqual(
    rows.flatMap((row) =>
      row.kind === 'entry' && row.entry.kind === 'resolution' ? [row.fold] : [],
    ),
    [undefined, undefined, undefined, undefined, undefined],
  );
});

test('a busy session queues the message for its next turn; a closed one takes none', () => {
  assert.equal(nativeSendLabel('idle'), 'Send');
  assert.equal(nativeSendLabel('running'), 'Queue message');
  assert.equal(nativeSendLabel('waiting'), 'Queue message');
  for (const state of ['starting', 'closing', 'closed', 'failed', undefined] as const)
    assert.equal(nativeSendLabel(state), undefined);
});

test('a sent message shows itself until the conversation shows it', () => {
  const cases: [NativeSessionEvent[], boolean][] = [
    [[], false],
    [[event(1, 'text.delta', 'answer')], false],
    [[event(1, 'command.submitted')], false],
    [[{ ...event(1, 'command.submitted', 'other task'), commandId: 'other' }], false],
    [[event(1, 'command.submitted', 'task')], true],
    [[event(1, 'text.delta', 'answer'), event(2, 'command.accepted', 'task')], true],
  ];
  for (const [events, shown] of cases) {
    assert.equal(nativeMessageShown(events, 'command'), shown);
    assert.equal(
      nativeTimeline(events).some(
        (entry) => entry.kind === 'user' && entry.event.commandId === 'command',
      ),
      shown,
    );
  }
});

test('a message the host failed without submitting it is dropped; a delivered one is not', () => {
  const receipt = (
    state: 'pending' | 'failed' | 'completed',
    submitted: boolean,
    queued = false,
  ) => ({
    commandId: 'command',
    generation: 'generation',
    state,
    queued,
    submitted,
    accepted: submitted,
  });
  // Closed or re-leased while queued: failed, never submitted.
  assert.equal(nativeMessageDropped(receipt('failed', false)), true);
  // Interrupted after delivery, its prompt evicted from the retained history by a long turn.
  const longTurn: NativeSessionEvent[] = [event(1, 'command.submitted', 'task')];
  for (let i = 0; i < 201; i++)
    longTurn.push(
      { ...event(2 + i * 2, 'tool.started'), tool: { name: 'Bash' } },
      event(3 + i * 2, 'text.delta', `step ${i}`),
    );
  assert.equal(nativeMessageShown(retainNativeMessages(longTurn), 'command'), false);
  assert.equal(nativeMessageDropped(receipt('failed', true)), false);
  assert.equal(nativeMessageDropped(receipt('pending', false, true)), false);
  assert.equal(nativeMessageDropped(receipt('completed', true)), false);
  // No receipt for this generation: the host may still send it after a resume.
  assert.equal(nativeMessageDropped(), false);
});

test('a queued message can be taken back while its host removes queued messages', () => {
  const session = page([]).session;
  const host = { ...session, capabilities: { ...session.capabilities, cancelQueued: true } };
  const queued: NativeCommandReceipt = {
    commandId: 'command',
    generation: 'generation',
    state: 'pending',
    queued: true,
    submitted: false,
    accepted: false,
  };
  assert.equal(nativeMessageCancelable(host, queued), true);
  // An older host does not report the capability, so its session offers no Edit.
  assert.equal(nativeMessageCancelable(session, queued), false);
  assert.equal(nativeMessageCancelable(undefined, queued), false);
  assert.equal(nativeMessageCancelable(host), false);
  // Submitted, or queued in another generation: only Stop applies.
  const submitted = { ...queued, queued: false, state: 'unknown' as const, submitted: true };
  assert.equal(nativeMessageCancelable(host, submitted), false);
  assert.equal(nativeMessageCancelable(host, { ...queued, generation: 'previous' }), false);
  // Removed: failed and never submitted, so its text goes back to the composer.
  const removed = {
    ...queued,
    queued: false,
    state: 'failed' as const,
    outcome: 'cancelled' as const,
  };
  assert.equal(nativeMessageCancelable(host, removed), false);
  assert.equal(nativeMessageDropped(removed), true);
  assert.equal(nativeDeliveryLabel(removed), 'Removed');
});

test('late acceptance restores the user prompt before its assistant response', () => {
  const timeline = nativeTimeline([
    event(1, 'text.delta', 'answer'),
    event(2, 'command.accepted', 'question'),
  ]);
  assert.deepEqual(
    timeline.map(({ kind, text }) => [kind, text]),
    [
      ['user', 'question'],
      ['assistant', 'answer'],
    ],
  );
});

test('a reader who scrolls up keeps their place and counts new entries until they jump back', () => {
  let follow = NATIVE_FOLLOW_LATEST;
  assert.equal(nativeFollowLabel(follow), undefined);
  assert.equal(nativeFollowGrew(follow, 3), follow, 'a following reader stays caught up');
  follow = nativeFollowScrolled(follow, 79);
  assert.deepEqual(follow, NATIVE_FOLLOW_LATEST, 'within the slack still follows');
  follow = nativeFollowScrolled(follow, 400);
  assert.deepEqual(follow, { following: false, unseen: 0 });
  assert.equal(nativeFollowLabel(follow), 'Latest');
  follow = nativeFollowGrew(nativeFollowGrew(follow, 2), 1);
  assert.equal(nativeFollowLabel(follow), 'Latest · 3 new');
  assert.equal(nativeFollowScrolled(follow, 300), follow, 'scrolling elsewhere keeps the count');
  assert.equal(nativeFollowGrew(follow, 0), follow);
  assert.deepEqual(nativeFollowScrolled(follow, 10), NATIVE_FOLLOW_LATEST, 'back at the end');
});

test('a long message shows its first lines until expanded; short ones show in full', () => {
  const lines = (count: number) =>
    Array.from({ length: count }, (_, i) => `- step ${i}`).join('\n');
  assert.equal(nativeMessagePreview('Fix the flaky test.'), undefined);
  // Collapsing would hide only a few lines or characters.
  assert.equal(nativeMessagePreview(lines(12)), undefined);
  assert.equal(nativeMessagePreview('x'.repeat(900)), undefined);
  // A prompt read from a file ends in a newline; it is not a hidden line.
  assert.equal(nativeMessagePreview(`${lines(12)}\n`), undefined);
  assert.equal(nativeMessagePreview(lines(13))?.lines, 13);
  const preview = nativeMessagePreview(`${lines(200)}\n`);
  assert(preview);
  assert.equal(preview.lines, 200);
  // Cut at a line end: the label carries the count, no ellipsis.
  assert.equal(preview.text, lines(8));
  assert.equal(nativeMessageToggleLabel(preview, false), 'Show all · 200 lines');
  assert.equal(nativeMessageToggleLabel(preview, true), 'Show less');
  const wide = nativeMessagePreview('x'.repeat(5000));
  assert(wide);
  assert.equal(wide.lines, 1);
  assert.equal(wide.text, `${'x'.repeat(600)}…`);
  assert.equal(nativeMessageToggleLabel(wide, false), 'Show all · 1 line');
  // A cut never splits an emoji.
  assert.equal(
    nativeMessagePreview(`${'x'.repeat(599)}😀${'x'.repeat(400)}`)?.text,
    `${'x'.repeat(599)}…`,
  );
});

test('only user messages collapse', () => {
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const [user, assistant] = nativeTimeline([
    event(1, 'command.submitted', long),
    event(2, 'text.delta', long),
  ]);
  assert(user?.kind === 'user' && assistant?.kind === 'assistant');
  assert.equal(nativeEntryPreview(user)?.lines, 200);
  assert.equal(nativeEntryPreview(assistant), undefined);
});

test('a running turn reports when it started and the tool it runs now', () => {
  const at = (sequence: number, type: NativeSessionEvent['type'], extra = {}) => ({
    ...event(sequence, type),
    at: new Date(Date.UTC(2026, 9, 30, 10, 0, sequence)).toISOString(),
    ...extra,
  });
  const bash = { nativeId: 'tool-1', tool: { name: 'Bash' } };
  const read = { nativeId: 'tool-2', tool: { name: 'Read' } };
  const started = Date.UTC(2026, 9, 30, 10, 0, 2);
  const events = [at(1, 'command.accepted'), at(2, 'turn.started'), at(3, 'tool.started', bash)];
  assert.equal(nativeWork(events.slice(0, 1)), undefined, 'no turn yet');
  assert.deepEqual(nativeWork(events), { since: started, tool: 'Bash' });
  events.push(at(4, 'tool.started', read), at(5, 'tool.completed', read));
  assert.deepEqual(nativeWork(events), { since: started, tool: 'Bash' }, 'the open tool stays');
  events.push(at(6, 'tool.completed', bash));
  assert.deepEqual(nativeWork(events), { since: started, tool: undefined });
  events.push(at(7, 'turn.completed'));
  assert.equal(nativeWork(events), undefined);
  events.push(at(8, 'turn.started'));
  assert.deepEqual(nativeWork(events), { since: Date.UTC(2026, 9, 30, 10, 0, 8), tool: undefined });
  events.push(at(9, 'session.closed'));
  assert.equal(nativeWork(events), undefined);

  assert.equal(nativeWorkLabel({ since: 0 }, 0), 'Working · 0s');
  assert.equal(nativeWorkLabel({ since: 0 }, 59_999), 'Working · 59s');
  assert.equal(nativeWorkLabel({ since: 0, tool: 'Bash' }, 72_000), 'Working · 1m 12s · Bash');
  assert.equal(nativeWorkLabel({ since: 0 }, 3_780_000), 'Working · 1h 3m');
  assert.equal(nativeWorkLabel({ since: 10_000 }, 0), 'Working · 0s', 'a clock behind the gateway');
});

test('a finished turn gets one summary row below its tools; nothing above it moves', () => {
  const at = (
    sequence: number,
    type: NativeSessionEvent['type'],
    extra: Partial<NativeSessionEvent> = {},
  ) => ({
    ...event(sequence, type),
    commandId: sequence < 9 ? 'first' : 'second',
    at: new Date(Date.UTC(2026, 9, 30, 10, 0, sequence * 10)).toISOString(),
    ...extra,
  });
  const tool = (id: string, name: string) => ({ nativeId: id, tool: { name } });
  const show = (rows: NativeTimelineRow[]) =>
    rows.map((row) =>
      row.kind === 'work'
        ? `[${row.label}: ${row.tools}]`
        : `${row.entry.text}${row.fold === undefined ? '' : ` (in ${row.fold})`}`,
    );
  const running = [
    at(1, 'command.submitted', { text: 'Fix the test.' }),
    at(2, 'tool.started', tool('a', 'Read')),
    at(3, 'tool.completed', tool('a', 'Read')),
    at(4, 'text.delta', { text: 'Found it.' }),
    at(5, 'tool.started', tool('b', 'Edit')),
  ];
  assert.deepEqual(show(nativeTimelineRows(nativeTimeline(running))), [
    'Fix the test.',
    'Read',
    'Found it.',
    'Edit',
  ]);
  const done = nativeTimelineRows(
    nativeTimeline([
      ...running,
      at(6, 'tool.completed', tool('b', 'Edit')),
      at(7, 'text.delta', { text: 'Fixed.' }),
      at(8, 'turn.completed', { status: 'completed' }),
      at(9, 'command.submitted', { text: 'Run it.' }),
      at(10, 'tool.started', tool('c', 'Bash')),
    ]),
  );
  assert.deepEqual(show(done), [
    'Fix the test.',
    'Read (in 8)',
    'Found it.',
    'Edit (in 8)',
    'Fixed.',
    '[Worked for 1m 10s · 2 tools: 2,5]',
    'Turn completed',
    'Run it.',
    'Bash',
  ]);
  // Tools keep their keys, so a reader's open card survives the turn finishing.
  assert.deepEqual(
    done.slice(0, 5).map((row) => row.key),
    [1, 2, 4, 5, 7],
  );

  // A host that stops mid-turn ends that turn; the resumed turn is its own.
  const resumed = nativeTimelineRows(
    nativeTimeline([
      at(1, 'command.submitted', { text: 'Task A.' }),
      at(2, 'tool.started', tool('a', 'Bash')),
      at(4, 'session.closed', { status: 'failed', text: 'Native host stopped' }),
      at(9, 'command.submitted', { text: 'Continue.' }),
      at(10, 'tool.started', tool('b', 'Edit')),
      at(12, 'turn.completed', { status: 'completed' }),
    ]),
  );
  assert.deepEqual(show(resumed), [
    'Task A.',
    'Bash (in 4)',
    '[Stopped after 30s · 1 tool: 2]',
    'Native host stopped',
    'Continue.',
    'Edit (in 12)',
    '[Worked for 30s · 1 tool: 10]',
    'Turn completed',
  ]);
  const failed = nativeTimelineRows(
    nativeTimeline([
      at(1, 'command.submitted', { text: 'Go.' }),
      at(2, 'tool.started', tool('a', 'Read')),
      at(3, 'turn.completed', { status: 'failed' }),
    ]),
  );
  assert.equal(failed[2].kind === 'work' && failed[2].label, 'Failed after 20s · 1 tool');
  const talk = nativeTimeline([
    at(1, 'command.submitted', { text: 'Hi.' }),
    at(2, 'text.delta', { text: 'Hello.' }),
    at(3, 'turn.completed'),
  ]);
  assert.deepEqual(
    nativeTimelineRows(talk).map((row) => row.kind),
    ['entry', 'entry', 'entry'],
  );

  // Only a live read marks tools as watched; a stored snapshot does not.
  const watched = new Set<number>();
  nativeWatchTools(nativeTimelineRows(nativeTimeline(running)), watched, false);
  assert.equal(watched.size, 0);
  nativeWatchTools(nativeTimelineRows(nativeTimeline(running)), watched, true);
  assert.deepEqual([...watched], [2, 5]);
  const fold = done.find((row) => row.kind === 'work');
  assert(fold?.kind === 'work');
  assert.equal(nativeFoldWatched(fold, watched), true);
  assert.equal(nativeFoldWatched(fold, new Set()), false);
});

test('a plan updates in place in its turn, folds to its progress when the turn ends', () => {
  const plan = (sequence: number, value: NativeSessionPlan, commandId = 'first') => ({
    ...event(sequence, 'plan.updated'),
    commandId,
    plan: value,
  });
  const steps = (...status: Array<'pending' | 'in-progress' | 'completed'>): NativeSessionPlan => ({
    kind: 'checklist',
    steps: status.map((value, index) => ({ text: `Step ${index + 1}`, status: value })),
  });
  const running = [
    { ...event(1, 'command.submitted', 'Fix the test.'), commandId: 'first' },
    plan(2, steps('in-progress', 'pending', 'pending')),
    { ...event(3, 'text.delta', 'Reading.'), commandId: 'first' },
    plan(4, steps('completed', 'in-progress', 'pending')),
    plan(5, { kind: 'proposal', text: '1. Read.\n2. Fix.' }),
  ];
  const entries = nativeTimeline(running);
  // One checklist entry, at the place and key of its first update, holding the latest steps.
  assert.deepEqual(
    entries.map((entry) => [entry.kind, entry.key, entry.text]),
    [
      ['user', 1, 'Fix the test.'],
      ['plan', 2, '1 of 3 steps'],
      ['assistant', 3, 'Reading.'],
      ['plan', 5, '1. Read.\n2. Fix.'],
    ],
  );
  assert.deepEqual(entries[1].event.plan, steps('completed', 'in-progress', 'pending'));
  assert.equal(entries[1].event.sequence, 2);
  // Cached history keeps only the latest checklist, under the same key.
  const kept = retainNativeMessages(running);
  assert.deepEqual(
    kept.filter((item) => item.type === 'plan.updated').map((item) => item.sequence),
    [2, 5],
  );
  assert.deepEqual(
    nativeTimeline(kept)[1].event.plan,
    steps('completed', 'in-progress', 'pending'),
  );
  // Another turn's checklist is its own entry.
  assert.equal(
    nativeTimeline([...running, plan(6, steps('pending'), 'second')]).at(-1)?.text,
    '0 of 1 step',
  );

  const open = (rows: NativeTimelineRow[], watched: Set<number>) =>
    rows.flatMap((row) =>
      row.kind === 'entry' && row.entry.kind === 'plan' ? [nativePlanOpen(row, watched)] : [],
    );
  const ended = [...running, { ...event(9, 'turn.completed'), commandId: 'first' }];
  // While its turn runs a checklist shows its steps; once it ended, a stored read folds it.
  assert.deepEqual(open(nativeTimelineRows(nativeTimeline(running)), new Set()), [true, true]);
  assert.deepEqual(open(nativeTimelineRows(nativeTimeline(ended)), new Set()), [false, false]);
  // A plan the reader watched run stays open, so it does not fold away under them.
  const watched = new Set<number>();
  nativeWatchTools(nativeTimelineRows(nativeTimeline(running)), watched, true);
  assert.deepEqual(open(nativeTimelineRows(nativeTimeline(ended)), watched), [true, true]);

  // A later page's update merges into the plan cached from an earlier page, under its first key.
  const paged = retainNativeMessages([
    ...retainNativeMessages(running.slice(0, 2)),
    ...running.slice(2),
  ]);
  assert.deepEqual(
    nativeTimeline(paged)
      .filter((entry) => entry.kind === 'plan')
      .map((entry) => [entry.key, entry.text]),
    [
      [2, '1 of 3 steps'],
      [5, '1. Read.\n2. Fix.'],
    ],
  );
  // A resumed generation's plan with the same command ID is its own entry; proposals merge too.
  const resumed = nativeTimeline([
    plan(1, steps('completed')),
    { ...plan(2, steps('pending')), generation: 'next' },
    plan(3, { kind: 'proposal', text: 'First.' }),
    plan(4, { kind: 'proposal', text: 'Second.' }),
  ]);
  assert.deepEqual(
    resumed.map((entry) => [entry.key, entry.text]),
    [
      [1, '1 of 1 step'],
      [2, '0 of 1 step'],
      [3, 'Second.'],
    ],
  );
  assert.deepEqual((['completed', 'in-progress', 'pending'] as const).map(nativePlanStepMark), [
    '✓',
    '●',
    '○',
  ]);
  assert.deepEqual([undefined, true, false].map(nativePlanCopyLabel), [
    'Copy plan',
    'Copied',
    'Copy failed',
  ]);

  // A long proposal collapses like a long message.
  const long = Array.from({ length: 40 }, (_, index) => `${index + 1}. Step.`).join('\n');
  assert.ok(nativeEntryPreview(nativeTimeline([plan(1, { kind: 'proposal', text: long })])[0]));
  assert.equal(nativeEntryPreview(entries[1]), undefined);
});
