// Codex (0.162+) asks "Folder access" on every interactive launch in a folder
// declared untrusted, and choosing "Open restricted" saves nothing, so no
// pre-launch config can skip it. A review terminal answers that one screen with
// option 1 (Open restricted) once. Any other prompt, or a changed screen, fails
// the launch instead of pressing keys blindly; Trust is never chosen.

const BODY =
  'Config, hooks, and exec policies from untrusted folders stay disabled. ' +
  'Trusted project folders can still contribute settings. Skills still load, ' +
  'and tools follow your permission settings. Opening will not change saved trust.';
// Option 2 and the footer differ when Codex runs under its app-server daemon.
const ENDINGS = [
  '› 1. Open restricted 2. Quit enter continue · esc quit',
  '› 1. Open restricted 2. Back to Agent Command Center enter continue · esc back',
];
const PROMPT_MARKERS =
  /folder access|open restricted|trust this folder|trust and continue|update available|enter continue|esc quit|esc back|press enter|\(y\/n\)/i;
const READY_MARKERS = /esc to interrupt|\? for shortcuts/;
// The boot splash already paints the composer footer, before any prompt.
const LOADING = /OpenAI Codex \(v[^)]*\) loading/;

const collapse = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * Classify a captured Codex pane: the exact Folder access screen for one of
 * `folders`, any other prompt, a ready composer, or still starting.
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
  if (!LOADING.test(text) && READY_MARKERS.test(text)) return { kind: 'ready' };
  return { kind: 'starting' };
}

const excerpt = (pane) =>
  pane
    .split('\n')
    .filter((line) => line.trim())
    .slice(-8)
    .join('\n');

/**
 * Watch a freshly launched Codex pane until it is ready. Returns 'restricted'
 * when it answered the Folder access screen, null otherwise. Throws on any other
 * prompt, or when the screen is still there after its one answer.
 */
async function answerCodexFolderAccess({
  capture,
  sendEnter,
  folders,
  timeoutMs = 15_000,
  settleMs = 3_000,
  pollMs = 250,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const deadline = now() + timeoutMs;
  let answeredAt = null;
  while (now() < deadline) {
    await sleep(pollMs);
    const pane = capture();
    // The session ended; the run monitor reports a dead reviewer.
    if (pane === null) break;
    const screen = classifyCodexLaunchScreen(pane, folders);
    if (screen.kind === 'ready') break;
    if (screen.kind === 'prompt')
      throw new Error(`Codex showed an unexpected launch prompt:\n${excerpt(pane)}`);
    if (screen.kind !== 'folder-access') continue;
    if (answeredAt === null) {
      sendEnter();
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
