import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { answerCodexFolderAccess, classifyCodexLaunchScreen } =
  require('../../scripts/review-codex-folder-access.cjs') as {
    answerCodexFolderAccess: (options: {
      capture: () => string | null;
      sendEnter: () => void;
      folders: string[];
      mayAnswer?: boolean;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    }) => Promise<'restricted' | null>;
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
function drive(panes: string[], mayAnswer = true) {
  let clock = 0;
  let index = 0;
  const sent: string[] = [];
  const result = answerCodexFolderAccess({
    capture: () => panes[Math.min(index++, panes.length - 1)]!,
    sendEnter: () => {
      sent.push('Enter');
    },
    folders: [folder],
    mayAnswer,
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
  assert.equal(classifyCodexLaunchScreen(header, [folder]).kind, 'idle');
  const answered = drive(['', splash, header, folderAccess, '', ready]);
  assert.equal(await answered.result, 'restricted');
  assert.deepEqual(answered.sent, ['Enter']);

  const noPrompt = drive(['', ready]);
  assert.equal(await noPrompt.result, null);
  assert.deepEqual(noPrompt.sent, []);

  // An idle composer that holds counts as ready without a prompt.
  const idleOnly = drive(['', idle]);
  assert.equal(await idleOnly.result, null);
  assert.deepEqual(idleOnly.sent, []);
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
  for (const pane of [reworded, update, `${folderAccess}\n  Trust and continue\n`]) {
    const { result, sent } = drive(['', pane]);
    await assert.rejects(result, /unexpected launch prompt/);
    assert.deepEqual(sent, []);
  }

  // Answered once, still there after the settle window: no second Enter.
  const stuck = drive([folderAccess]);
  await assert.rejects(stuck.result, /still shows Folder access after Open restricted/);
  assert.deepEqual(stuck.sent, ['Enter']);

  // A resumed launch whose answer was already sent never sends a second one.
  const resumed = drive([folderAccess], false);
  await assert.rejects(resumed.result, /still shows Folder access after Open restricted/);
  assert.deepEqual(resumed.sent, []);
  const resumedClear = drive(['', ready], false);
  assert.equal(await resumedClear.result, null);
  assert.deepEqual(resumedClear.sent, []);
});
