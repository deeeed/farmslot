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
    if (
      /\b(login|log in|authenticate|authentication|auth)\b/.test(normalized) &&
      /\b(expired|required|failed|please|needed|unauthorized|not authenticated|not logged in)\b/.test(
        normalized,
      )
    ) {
      return true;
    }
  }
  return false;
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
