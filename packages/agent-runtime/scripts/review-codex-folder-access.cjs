// Codex (0.162+) asks "Folder access" on every interactive launch in a folder
// declared untrusted, and choosing "Open restricted" saves nothing, so no
// pre-launch config can skip it. A review terminal answers that one screen with
// option 1 (Open restricted) once. Any other prompt, or a changed screen, fails
// the launch instead of pressing keys blindly. The only key ever sent is Enter on
// the already-selected option 1, so Trust can't be chosen: keep it that way and
// don't add a path that moves the selection.

const BODY =
  'Config, hooks, and exec policies from untrusted folders stay disabled. ' +
  'Trusted project folders can still contribute settings. Skills still load, ' +
  'and tools follow your permission settings. Opening will not change saved trust.';
// Option 2 and the footer differ when Codex runs under its app-server daemon.
const ENDINGS = [
  '› 1. Open restricted 2. Quit enter continue · esc quit',
  '› 1. Open restricted 2. Back to Agent Command Center enter continue · esc back',
];
// Any Codex selection screen ends in an "enter …" / "esc …" footer, e.g. "Hooks
// need review" (enter confirm · esc skip); unknown ones must fail, not wait out.
const PROMPT_MARKERS =
  /folder access|open restricted|trust this folder|trust and continue|trust all|hooks need review|update available|enter continue|enter confirm|esc quit|esc back|esc skip|press enter|\(y\/n\)/i;
// Codex 0.165 paints its editable startup composer while folder consent is
// still pending. Neither an idle footer nor "esc to interrupt" completes this
// handshake: this untrusted review must observe and answer Open restricted.

const collapse = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * Classify a captured Codex pane: the exact Folder access screen for one of
 * `folders`, any other prompt, or starting. Composer text is not startup evidence.
 */
function classifyCodexLaunchScreen(pane, folders) {
  const text = collapse(pane);
  for (const ending of ENDINGS) {
    const tail = ` ${BODY} ${ending}`;
    if (!text.startsWith('Folder access ') || !text.endsWith(tail)) continue;
    // The folder line wraps at the pane width, so compare it without whitespace.
    const shown = text.slice('Folder access '.length, -tail.length).replace(/\s+/g, '');
    if (folders.some((folder) => folder.replace(/\s+/g, '') === shown))
      return { kind: 'folder-access' };
  }
  if (PROMPT_MARKERS.test(text)) return { kind: 'prompt' };
  return { kind: 'starting' };
}

const excerpt = (pane) =>
  pane
    .split('\n')
    .filter((line) => line.trim())
    .slice(-8)
    .join('\n');

/**
 * Watch this untrusted review launch until the exact Folder access screen has
 * been answered and disappeared. Other prompts, a dead terminal, or a deadline
 * before that handshake fail the launch. `claimAnswer` atomically claims its
 * single Enter; a replay may only wait for the already-claimed answer to settle.
 */
async function answerCodexFolderAccess({
  capture,
  sendEnter,
  claimAnswer = () => true,
  answerClaimed = () => false,
  folders,
  timeoutMs = 15_000,
  settleMs = 2_000,
  pollMs = 250,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const deadline = now() + timeoutMs;
  let answeredAt = null;
  while (now() < deadline) {
    await sleep(pollMs);
    const pane = capture();
    if (pane === null) throw new Error('Codex terminal exited before Folder access completed');
    const screen = classifyCodexLaunchScreen(pane, folders);
    if (answeredAt === null && answerClaimed()) answeredAt = now();
    if (screen.kind === 'prompt')
      throw new Error(`Codex showed an unexpected launch prompt:\n${excerpt(pane)}`);
    if (screen.kind !== 'folder-access') {
      if (answeredAt !== null && now() - answeredAt >= settleMs) return 'restricted';
      continue;
    }
    if (answeredAt === null) {
      if (claimAnswer()) sendEnter();
      answeredAt = now();
    } else if (now() - answeredAt >= settleMs) {
      throw new Error(
        `Codex still shows Folder access after Open restricted was chosen once:\n${excerpt(pane)}`,
      );
    }
  }
  throw new Error('Codex Folder access did not complete before the launch deadline');
}

module.exports = { answerCodexFolderAccess, classifyCodexLaunchScreen };
