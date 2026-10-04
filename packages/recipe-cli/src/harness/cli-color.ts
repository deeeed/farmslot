/**
 * cli-color.ts — shared ANSI styling for recipe CLI human output.
 *
 * Honors NO_COLOR, RECIPE_NO_COLOR, FORCE_COLOR, RECIPE_COLOR, and TTY detection.
 */

type StyleName =
  | 'reset'
  | 'bold'
  | 'dim'
  | 'label'
  | 'cmd'
  | 'ok'
  | 'warn'
  | 'err'
  | 'info'
  | 'accent'
  | 'path'
  | 'comment'
  | 'active';

const STYLES: Record<StyleName, string> = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  label: '\x1b[1;36m',
  cmd: '\x1b[1m',
  ok: '\x1b[1;32m',
  warn: '\x1b[1;33m',
  err: '\x1b[1;31m',
  info: '\x1b[0;37m',
  accent: '\x1b[1;35m',
  path: '\x1b[2m',
  comment: '\x1b[2m',
  active: '\x1b[1m',
};

export function colorEnabled(stream: NodeJS.WriteStream = process.stderr): boolean {
  if (process.env.NO_COLOR != null && process.env.NO_COLOR !== '' && process.env.NO_COLOR !== '0') {
    return false;
  }
  if (process.env.RECIPE_NO_COLOR === '1') return false;
  if (process.env.RECIPE_COLOR === '1' || process.env.FORCE_COLOR === '1') return true;
  return Boolean((stream as NodeJS.WriteStream & { isTTY?: boolean })?.isTTY);
}

export function stripAnsi(text: string): string {
  return String(text).replace(/\x1b\[[0-9;]*m/gu, '');
}

export function color(
  style: string,
  text: string,
  { stream = process.stderr }: { stream?: NodeJS.WriteStream } = {},
): string {
  const value = String(text);
  if (!colorEnabled(stream)) return value;
  const code = STYLES[style as StyleName];
  if (!code) return value;
  return `${code}${value}${STYLES.reset}`;
}

export function colorKv(
  label: string,
  value: string,
  valueStyle = 'info',
  { stream = process.stderr }: { stream?: NodeJS.WriteStream } = {},
): string {
  return `${color('label', `${label}:`, { stream })} ${color(valueStyle, value, { stream })}`;
}

export function colorStatusWord(
  word: string,
  { stream = process.stderr }: { stream?: NodeJS.WriteStream } = {},
): string {
  const normalized = String(word || '').toLowerCase();
  if (['up', 'ready', 'yes', 'pass', 'running', 'present', 'healthy'].includes(normalized)) {
    return color('ok', word, { stream });
  }
  if (
    ['down', 'stopped', 'no', 'fail', 'failed', 'missing', 'blocked', 'unknown'].includes(
      normalized,
    )
  ) {
    return color('err', word, { stream });
  }
  if (['compiling', 'bundling', 'starting', 'waiting', 'warn'].includes(normalized)) {
    return color('warn', word, { stream });
  }
  return color('info', word, { stream });
}

export function colorHumanMessage(
  message: string,
  { stream = process.stderr }: { stream?: NodeJS.WriteStream } = {},
): string {
  return String(message)
    .split('\n')
    .map((line) => {
      const marker = /^(\s*)(→|✓|✗)\s?(.*)$/u.exec(line);
      if (marker) {
        const style = marker[2] === '✓' ? 'ok' : marker[2] === '✗' ? 'err' : 'accent';
        return `${marker[1]}${color(style, marker[2], { stream })}${marker[3] ? ` ${marker[3]}` : ''}`;
      }
      const next = /^(\s*)Next:\s*(.*)$/u.exec(line);
      if (next) {
        return `${next[1]}${color('label', 'Next:', { stream })}${next[2] ? ` ${color('cmd', next[2], { stream })}` : ''}`;
      }
      const warning = /^(\s*)(WARN(?:ING)?)(:?)[ \t]*(.*)$/iu.exec(line);
      if (warning) {
        return `${warning[1]}${color('warn', `${warning[2]}${warning[3]}`, { stream })}${warning[4] ? ` ${warning[4]}` : ''}`;
      }
      return line;
    })
    .join('\n');
}

export function classifyLogEvent(event: string): string {
  const text = String(event || '');
  if (/Module build failed|^ERROR in |BUILD FAILED|compiled with [1-9][0-9]* error/iu.test(text)) {
    return 'err';
  }
  if (
    /compiled successfully|compiled with [0-9]+ warning|PASS runtime-launch|launch pass|verify pass|build complete/iu.test(
      text,
    )
  ) {
    return 'ok';
  }
  if (
    /phase [0-9]\/[0-9]|prepare pipeline|snapshot|fixture:|dist-freshness|build-health/iu.test(text)
  ) {
    return 'label';
  }
  if (/webpack [0-9]+%|Bundl(ed|ing)|(iOS|Android).*%/iu.test(text)) {
    return 'warn';
  }
  return 'info';
}

export function colorLogEvent(
  event: string,
  {
    latest = false,
    stream = process.stderr,
  }: { latest?: boolean; stream?: NodeJS.WriteStream } = {},
): string {
  const style = classifyLogEvent(event);
  const painted = color(style === 'label' ? 'label' : style, event, { stream });
  return latest ? color('active', painted, { stream }) : painted;
}
