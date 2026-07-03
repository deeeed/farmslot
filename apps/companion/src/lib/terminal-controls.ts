export interface TerminalControlKey {
  label: string;
  data: string;
  danger: boolean;
}

export const TERMINAL_CONTROL_KEYS: readonly TerminalControlKey[] = [
  { label: '↑', data: '\x1b[A', danger: false },
  { label: '↓', data: '\x1b[B', danger: false },
  { label: '←', data: '\x1b[D', danger: false },
  { label: '→', data: '\x1b[C', danger: false },
  { label: 'Enter', data: '\r', danger: false },
  { label: 'Tab', data: '\x09', danger: false },
  { label: '⇧Tab', data: '\x1b[Z', danger: false },
  { label: 'Esc', data: '\x1b', danger: false },
  { label: '^C', data: '\x03', danger: true },
  { label: '^D', data: '\x04', danger: true },
  { label: '^U', data: '\x15', danger: false },
  { label: '^L', data: '\x0c', danger: false },
] as const;
