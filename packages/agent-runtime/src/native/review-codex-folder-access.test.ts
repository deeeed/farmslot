import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { answerCodexFolderAccess, classifyCodexLaunchScreen } =
  require('../../scripts/review-codex-folder-access.cjs') as {
    answerCodexFolderAccess: (options: {
      capture: () => string | null;
      timeoutMs?: number;
      sendEnter: () => void;
      folders: string[];
      claimAnswer?: () => boolean;
      isAnswerClaimed?: () => boolean;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    }) => Promise<'restricted'>;
    classifyCodexLaunchScreen: (pane: string, folders: string[]) => { kind: string };
  };

const folder =
  '/Users/me/.farmslot-dev/review-workspaces/28955192fb17f53cc37733af48d9c67d842d1ef6f2e86557baa043b9383754f4/runs/275a3b1b-9871-4932-8f2d-81da2125f6cc/source';

// Captured from Codex 0.162 in a review workspace (run 4beceb83), path wrapped at the pane width.
const folderAccess = `
  Folder access

  /Users/me/.farmslot-dev/review-workspaces/28955192fb17f53cc37733af48d9c6
  7d842d1ef6f2e86557baa043b9383754f4/runs/275a3b1b-9871-4932-8f2d-81da2125f6cc
  /source

  Config, hooks, and exec policies from untrusted folders stay disabled.
  Trusted project folders can still contribute settings. Skills still load,
  and tools follow your permission settings. Opening will not change saved
  trust.

› 1. Open restricted
  2. Quit

  enter continue · esc quit
`;

const trustPrompt = `
  Trust this folder? Codex can read, edit, and run files here, subject to your
  permission settings. Folder settings can run code automatically, even
  without a model request. Continue only if you trust these files. Your trust
  decision will be saved.

› 1. Trust and continue
  2. Quit

  enter continue · esc quit
`;

const ready = `
• Working (9s • esc to interrupt)

› Ask Codex to do anything
  ? for shortcuts
`;

// Painted for ~50-100 ms between the splash and Folder access on every 0.162 launch.
const header = `
  >_ OpenAI Codex (v0.162.0)
     /Users/me/.farmslot-dev/review-workspaces/…/source

› Ask Codex to do anything
  ? for shortcuts
`;

const idle = `${header}  permissions: YOLO mode\n`;

const splash = `
  >_ OpenAI Codex (v0.162.0) loading

› Ask Codex to do anything
  ? for shortcuts
`;

/** Replays panes in order (the last one repeats) on a fake clock, counting Enter presses. */
function drive(panes: (string | null)[], claimAnswer = () => true, isAnswerClaimed = () => false) {
  let clock = 0;
  let index = 0;
  const sent: string[] = [];
  const result = answerCodexFolderAccess({
    capture: () => panes[Math.min(index++, panes.length - 1)] ?? null,
    sendEnter: () => {
      sent.push('Enter');
    },
    folders: [folder],
    claimAnswer,
    isAnswerClaimed,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { result, sent };
}

test('the exact Folder access screen for the launched folder is answered with Open restricted once', async () => {
  assert.equal(classifyCodexLaunchScreen(folderAccess, [folder]).kind, 'folder-access');
  const app = folderAccess
    .replace('2. Quit', '2. Back to Agent Command Center')
    .replace('esc quit', 'esc back');
  assert.equal(classifyCodexLaunchScreen(app, [folder]).kind, 'folder-access');

  assert.equal(classifyCodexLaunchScreen(splash, [folder]).kind, 'starting');
  assert.equal(classifyCodexLaunchScreen(header, [folder]).kind, 'starting');
  const answered = drive(['', splash, header, folderAccess, '', ready]);
  assert.equal(await answered.result, 'restricted');
  assert.deepEqual(answered.sent, ['Enter']);
});

// Actual macpro 0.165.0 terminal capture. Only its private fixture path is normalized.
const codex165Folder = readFileSync(
  new URL('./fixtures/codex-0.165-folder-access.txt', import.meta.url),
  'utf8',
).replace('/workspace/review', folder);
const codex165Startup = readFileSync(
  new URL('./fixtures/codex-0.165-startup.txt', import.meta.url),
  'utf8',
);

test('0.165 startup composer cannot complete consent before the actual restricted screen', async () => {
  assert.equal(classifyCodexLaunchScreen(codex165Folder, [folder]).kind, 'folder-access');
  // The real launch receipts returned in ~4s without any claim. Both former
  // shortcuts must keep watching while the actual folder lookup is pending.
  for (const provisional of [codex165Startup, idle, ready]) {
    const delayed = drive([...Array<string>(20).fill(provisional), codex165Folder, '', ready]);
    assert.equal(await delayed.result, 'restricted');
    assert.deepEqual(delayed.sent, ['Enter']);
  }
});

test('unanswered consent and a dead terminal fail instead of recording a completed handshake', async () => {
  for (const provisional of [codex165Startup, idle, ready, '']) {
    const missing = drive([provisional]);
    await assert.rejects(missing.result, /Folder access did not complete.*deadline/);
    assert.deepEqual(missing.sent, []);
  }
  const dead = drive([null]);
  await assert.rejects(dead.result, /terminal exited before Folder access completed/);
  assert.deepEqual(dead.sent, []);
});

test('Trust is never chosen: a trust prompt, another folder or option 2 selected fail without a key', async () => {
  const otherFolder = folderAccess.replace('/source', '/other');
  const secondSelected = folderAccess
    .replace('› 1. Open restricted', '  1. Open restricted')
    .replace('  2. Quit', '› 2. Quit');
  for (const pane of [trustPrompt, otherFolder, secondSelected]) {
    assert.equal(classifyCodexLaunchScreen(pane, [folder]).kind, 'prompt');
    const { result, sent } = drive([pane]);
    await assert.rejects(result, /unexpected launch prompt/);
    assert.deepEqual(sent, []);
  }
});

test('a changed or unknown screen fails the launch instead of pressing Enter blindly', async () => {
  const reworded = folderAccess.replace('stay disabled', 'are disabled');
  const update = '  ✨ Update available! 0.162.0 -> 0.163.0\n\n› 1. Update now\n  2. Skip\n';
  // Captured on macpro after Open restricted, from the node's own untrusted hooks.
  const hooksReview = [
    '  Hooks need review',
    '  6 hooks are new or changed.',
    '  Hooks can run outside the sandbox after you trust them.',
    '› 1. Review hooks',
    '  2. Trust all and continue',
    "  3. Continue without trusting (hooks won't run)",
    '  enter confirm · esc skip',
  ].join('\n');
  for (const pane of [reworded, update, hooksReview, `${folderAccess}\n  Trust and continue\n`]) {
    const { result, sent } = drive(['', pane]);
    await assert.rejects(result, /unexpected launch prompt/);
    assert.deepEqual(sent, []);
  }

  // Answered once, still there after the settle window: no second Enter.
  const stuck = drive([folderAccess]);
  await assert.rejects(stuck.result, /still shows Folder access after Open restricted/);
  assert.deepEqual(stuck.sent, ['Enter']);

  // A resumed launch whose answer was already claimed never sends a second one.
  const resumed = drive([folderAccess], () => false);
  await assert.rejects(resumed.result, /still shows Folder access after Open restricted/);
  assert.deepEqual(resumed.sent, []);
});

test('overlapping watchers of one launch send exactly one Enter between them', async () => {
  let claimed = false;
  const claimAnswer = () => (claimed ? false : (claimed = true));
  const first = drive(['', folderAccess, folderAccess, '', ready], claimAnswer);
  const second = drive(['', folderAccess, folderAccess, '', ready], claimAnswer);
  assert.deepEqual(await Promise.all([first.result, second.result]), ['restricted', 'restricted']);
  assert.deepEqual([...first.sent, ...second.sent], ['Enter']);
});

test('a replay with an already-claimed answer can finish after the modal disappeared', async () => {
  const replay = drive(
    [ready],
    () => {
      throw new Error('must not claim another answer');
    },
    () => true,
  );
  assert.equal(await replay.result, 'restricted');
  assert.deepEqual(replay.sent, []);
});

test('an overlapping watcher rechecks the answer claim even when its first capture misses the modal', async () => {
  let claimed = false;
  const claimAnswer = () => (claimed ? false : (claimed = true));
  const first = drive([folderAccess, '', ready], claimAnswer, () => claimed);
  const second = drive([ready], claimAnswer, () => claimed);
  assert.deepEqual(await Promise.all([first.result, second.result]), ['restricted', 'restricted']);
  assert.deepEqual([...first.sent, ...second.sent], ['Enter']);
});

test('consent arriving near the launch deadline keeps its full settle window', async () => {
  const delayed = drive([...Array<string>(55).fill(splash), codex165Folder, ready]);
  assert.equal(await delayed.result, 'restricted');
  assert.deepEqual(delayed.sent, ['Enter']);
});
