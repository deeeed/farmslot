function normalizeRunnerId(runnerId?: string | null): string {
  return String(runnerId ?? '')
    .trim()
    .toLowerCase();
}

export interface PaneStateScriptResult {
  state: string;
  phase: string;
  confidence: string;
  launchBlocker: string | null;
  autoAction: string | null;
}

function detectGrokMcpInit(pane: string): string | null {
  const match = pane.match(/\bmcp\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)/i);
  if (!match) return null;
  const ready = Number(match[1]);
  const total = Number(match[2]);
  return total > 0 && ready < total ? 'mcp-init' : null;
}

function grokLiveStatusText(pane: string): string {
  const lines = pane.split('\n');
  let firstTranscript = -1;
  let afterLastTranscript = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*#\d+\s/.test(lines[i] ?? '')) {
      if (firstTranscript === -1) firstTranscript = i;
      afterLastTranscript = i + 1;
    }
  }
  if (firstTranscript === -1) return pane;

  const liveHeader = lines
    .slice(0, firstTranscript)
    .filter((line) => /\bmcp\s*\(/i.test(line) || /starting session/i.test(line));
  return [...liveHeader, ...lines.slice(afterLastTranscript)].join('\n');
}

function detectAuthRequired(pane: string): boolean {
  for (const line of pane.split('\n')) {
    const normalized = line.trim().toLowerCase();
    if (!normalized || /\bmcp\b/.test(normalized)) continue;
    if (lineHasAuthBlockerPhrase(normalized)) {
      return true;
    }
  }
  return false;
}

// Quota-banner shapes only, anchored to the line start (optionally behind
// box-drawing borders): mid-sentence prose about limits in code under
// discussion ("added handling for weekly limit reached errors", "you've
// reached your desired coverage limit in tests") must never classify.
const USAGE_LIMIT_BANNER_PATTERNS = [
  /^[│┃║\s]*(usage|rate|weekly|session|5-hour|five-hour) limits? (reached|hit|exceeded)\b/,
  /^[│┃║\s]*you'?ve (reached|hit|exceeded) your (usage|rate|weekly|session|5-hour|five-hour) limits?\b/,
  /^[│┃║\s]*(?:your )?limits? (resets?|will reset) (at|in) \d/,
];

function detectUsageLimit(pane: string): boolean {
  // Banner must sit in the last lines near the composer — a banner that
  // scrolled away is not blocking the current launch.
  const tail = pane
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-20);
  for (const rawLine of tail) {
    const normalized = rawLine.toLowerCase();
    if (USAGE_LIMIT_BANNER_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  }
  return false;
}

export function lineHasAuthBlockerPhrase(line: string): boolean {
  return (
    /\bauthentication\s+(expired|required|failed|needed)\b/.test(line) ||
    /\bauth\s+(is\s+)?(required|needed|failed)\b/.test(line) ||
    /\b(login|log in)\s+(required|needed|failed|to continue)\b/.test(line) ||
    /\b(oauth|api key|token|login|auth(?:entication)?)\s+(has\s+)?expired\b/.test(line) ||
    (/\bsession\s+(has\s+)?expired\b/.test(line) &&
      /\b(login|log in|auth|authenticate|reauthenticate)\b/.test(line)) ||
    /\bplease\s+run\s+\/?login\b/.test(line) ||
    /\brun\s+(codex|claude|cursor-agent)?\s*login\b/.test(line) ||
    /\brequires?\s+(login|log in|authentication|authenticate)\b/.test(line) ||
    /\bplease\s+(log in|login|authenticate)\b/.test(line) ||
    /\bnot\s+(authenticated|logged in)\b/.test(line) ||
    (/\bunauthorized\b/.test(line) &&
      /\b(login|log in|auth|authenticate|authentication|token|session)\b/.test(line))
  );
}

function detectLaunchBlocker(
  pane: string,
  runnerId?: string | null,
): { kind: string | null; autoAction: string | null } {
  const runner = normalizeRunnerId(runnerId);
  const lower = pane.toLowerCase();
  if (
    runner === 'cursor' &&
    lower.includes('[a] trust this workspace') &&
    lower.includes('[q] quit') &&
    lower.includes('use arrow keys to navigate')
  ) {
    return { kind: 'workspace-trust', autoAction: 'cursor-trust-workspace' };
  }
  if (
    runner === 'grok' &&
    lower.includes('run grok build in a project directory') &&
    lower.includes('(current)') &&
    lower.includes('enter:submit')
  ) {
    return { kind: 'project-directory', autoAction: 'grok-select-current-project' };
  }
  if (runner === 'grok') {
    const liveStatus = grokLiveStatusText(pane);
    const mcpInit = detectGrokMcpInit(liveStatus);
    if (mcpInit) return { kind: mcpInit, autoAction: null };
    if (/starting session/i.test(liveStatus)) return { kind: 'cold-start', autoAction: null };
  }
  if (runner && detectUsageLimit(pane)) return { kind: 'usage-limit', autoAction: null };
  if (runner && detectAuthRequired(pane)) return { kind: 'auth-required', autoAction: null };
  return { kind: null, autoAction: null };
}

/** Classify captured pane text in-process so gateway polling never blocks on child processes. */
export function readPaneStateFromCapture(
  pane: string,
  runnerId?: string | null,
): PaneStateScriptResult {
  const blocker = detectLaunchBlocker(pane, runnerId);
  return {
    state: 'unknown',
    phase: blocker.kind ? 'launch-blocker' : 'idle',
    confidence: 'low',
    launchBlocker: blocker.kind,
    autoAction: blocker.autoAction,
  };
}
