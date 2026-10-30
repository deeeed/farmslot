import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendNativePage,
  NATIVE_FOLLOW_LATEST,
  nativeCommandLockSettled,
  nativeDeliveryLabel,
  nativeEntryPreview,
  nativeFollowGrew,
  nativeFollowLabel,
  nativeFollowScrolled,
  nativeMessagePreview,
  nativeMessageToggleLabel,
  nativeTimeline,
  nativeWork,
  nativeWorkLabel,
} from '../../src/client-cache/native-history.js';
import type { NativeSessionEvent, NativeSessionReadResult } from '../../src/rpc/native-session.js';

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
