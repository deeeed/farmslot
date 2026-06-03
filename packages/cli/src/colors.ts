const enabled = process.stdout.isTTY ?? false;

function wrap(code: string, text: string): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const green = (t: string) => wrap('0;32', t);
export const red = (t: string) => wrap('0;31', t);
export const yellow = (t: string) => wrap('0;33', t);
export const cyan = (t: string) => wrap('0;36', t);
export const dim = (t: string) => wrap('2', t);
export const bold = (t: string) => wrap('1', t);
export const boldRed = (t: string) => wrap('1;31', t);
export const boldGreen = (t: string) => wrap('1;32', t);

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// --- Status colorizers (port of lib/farm-status-display.py) ---

export function colorStatus(val: string, okVals = ['OK', 'LOCAL']): string {
  if (okVals.includes(val)) return green(val);
  if (val === 'FAIL') return red(val);
  if (val === 'OFF' || val === '-') return dim(val);
  if (val.includes(':')) {
    const [prefix, suffix] = val.split(':', 2);
    if (suffix === 'OK') return `${prefix}:${green(suffix)}`;
    if (suffix === 'OFF') return dim(val);
    if (suffix === 'FAIL') return `${prefix}:${red(suffix)}`;
    return `${prefix}:${yellow(suffix)}`;
  }
  return yellow(val);
}

export function colorCdp(val: string): string {
  if (val === 'Wallet') return green(val);
  if (val === 'FAIL') return red(val);
  if (val === 'OFF' || val === '-') return dim(val);
  return yellow(val);
}

export function colorAgent(val: string): string {
  if (val === 'idle') return green(val);
  if (val === 'working') return yellow(val);
  if (val === 'no-tmux' || val === '-') return dim(val);
  return val;
}

export function colorBranch(val: string): string {
  if (val === 'main' || val === 'master' || val === '-') return dim(val);
  return val;
}

export function colorLifecycle(val: string): string {
  if (val === 'ready') return green(val);
  if (val === 'busy') return yellow(val);
  if (val === 'held') return cyan(val);
  if (val === 'manual') return cyan(val);
  if (val === 'disabled') return dim(val);
  if (!val || val === '-') return dim('-');
  return val;
}
