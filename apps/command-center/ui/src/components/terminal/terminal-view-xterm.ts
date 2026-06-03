import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

import { colors, fonts } from '../../styles/theme-tokens.js';

export interface TerminalRuntime {
  terminal: Terminal;
  fitAddon: FitAddon;
  resizeObserver: ResizeObserver;
}

export function createTerminalRuntime(
  container: HTMLElement,
  scheduleResize: () => void,
): TerminalRuntime {
  const terminal = new Terminal({
    theme: {
      background: colors.bgSurface,
      foreground: colors.textPrimary,
      cursor: colors.accent,
      selectionBackground: '#6366f144',
      black: '#0a0a0f',
      red: colors.statusFail,
      green: colors.statusOk,
      yellow: colors.statusWarn,
      blue: colors.accent,
      magenta: '#8b5cf6',
      cyan: '#06b6d4',
      white: colors.textPrimary,
    },
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    convertEol: true,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();

  const resizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(() => {
      fitAddon.fit();
      // Debounce resize — layout settles over multiple frames.
      scheduleResize();
    });
  });
  resizeObserver.observe(container);

  return { terminal, fitAddon, resizeObserver };
}
