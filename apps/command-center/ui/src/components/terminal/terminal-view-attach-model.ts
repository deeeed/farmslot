import type { TerminalMode } from './terminal-view-renderers.js';

/** UI attach lifecycle — drives overlay copy and when PTY output is shown. */
export type TerminalAttachPhase = 'idle' | 'connecting' | 'sizing' | 'live';

export function terminalAttachOverlay(params: {
  hasTarget: boolean;
  attachPhase: TerminalAttachPhase;
  reconnecting: boolean;
  recoveryMessage: string;
  mode: TerminalMode;
}): { show: boolean; message: string } {
  if (!params.hasTarget) return { show: false, message: '' };

  if (params.reconnecting && params.recoveryMessage) {
    return { show: true, message: params.recoveryMessage };
  }

  switch (params.attachPhase) {
    case 'connecting':
      return { show: true, message: 'Connecting to terminal…' };
    case 'sizing':
      return { show: true, message: 'Syncing terminal size…' };
    case 'live':
      return { show: false, message: '' };
    case 'idle':
    default:
      if (params.mode === 'none') {
        return {
          show: true,
          message: params.recoveryMessage || 'Connecting to terminal…',
        };
      }
      return { show: false, message: '' };
  }
}

/** LIVE badge only after attach is complete — avoids "live" over a sizing overlay. */
export function terminalShowsLiveBadge(
  mode: TerminalMode,
  attachPhase: TerminalAttachPhase,
): boolean {
  return mode === 'pty' && attachPhase === 'live';
}
