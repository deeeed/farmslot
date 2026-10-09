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
const WORKING = /esc to interrupt/;
const COMPOSER = /\? for shortcuts/;
// The boot splash, and a header frame right after it, already paint the composer
// footer before Folder access appears, so an idle composer only counts as ready
// once it has held this long.
const LOADING = /OpenAI Codex \(v[^)]*\) loading/;
const IDLE_READY_MS = 1_500;

const collapse = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * Classify a captured Codex pane: the exact Folder access screen for one of
 * `folders`, any other prompt, a working turn, an idle composer, or starting.
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
  if (WORKING.test(text)) return { kind: 'working' };
  if (!LOADING.test(text) && COMPOSER.test(text)) return { kind: 'idle' };
  return { kind: 'starting' };
}

const excerpt = (pane) =>
  pane
    .split('\n')
    .filter((line) => line.trim())
    .slice(-8)
    .join('\n');

/**
 * Watch a freshly launched Codex pane until it is working on the prompt, or idle
 * at its composer for IDLE_READY_MS. Returns 'restricted' when it answered the
 * Folder access screen, null otherwise. Throws on any other prompt, or when the
 * screen is still there after its one answer. `claimAnswer` must atomically claim
 * the launch's single answer (false when another watcher of the same launch, or
 * an earlier interrupted one, already holds it); without the claim Folder access
 * is only waited out.
 */
async function answerCodexFolderAccess({
  capture,
  sendEnter,
  claimAnswer = () => true,
  folders,
  timeoutMs = 15_000,
  settleMs = 2_000,
  pollMs = 250,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const deadline = now() + timeoutMs;
  let answeredAt = null;
  let idleSince = null;
  while (now() < deadline) {
    await sleep(pollMs);
    const pane = capture();
    // The session ended; the run monitor reports a dead reviewer.
    if (pane === null) break;
    const screen = classifyCodexLaunchScreen(pane, folders);
    if (screen.kind === 'working') break;
    if (screen.kind === 'idle') {
      idleSince ??= now();
      if (now() - idleSince >= IDLE_READY_MS) break;
      continue;
    }
    idleSince = null;
    if (screen.kind === 'prompt')
      throw new Error(`Codex showed an unexpected launch prompt:\n${excerpt(pane)}`);
    if (screen.kind !== 'folder-access') continue;
    if (answeredAt === null) {
      if (claimAnswer()) sendEnter();
      answeredAt = now();
    } else if (now() - answeredAt >= settleMs) {
      throw new Error(
        `Codex still shows Folder access after Open restricted was chosen once:\n${excerpt(pane)}`,
      );
    }
  }
  return answeredAt === null ? null : 'restricted';
}

module.exports = { answerCodexFolderAccess, classifyCodexLaunchScreen };
