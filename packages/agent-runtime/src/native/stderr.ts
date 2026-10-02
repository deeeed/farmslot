import { StringDecoder } from 'node:string_decoder';

const MAX_LINES = 50;
const MAX_LINE_LENGTH = 4096;

/** Diagnostic output only. Stderr never determines native session state. */
export class NativeStderrCapture {
  private readonly decoder = new StringDecoder('utf8');
  private readonly secrets: string[];
  private readonly lines: string[] = [];
  private pending = '';
  private oversized = false;

  constructor(env: NodeJS.ProcessEnv) {
    this.secrets = Object.entries(env)
      .filter(
        ([key, value]) => value && /token|secret|password|key|credential|auth|cookie/i.test(key),
      )
      .map(([, value]) => value!)
      .sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let value = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    value = value
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
      .replace(/\b((?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1[redacted]')
      .replace(
        /(["'](?:authorization|cookie|set-cookie)["']\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi,
        '$1"[redacted]"',
      )
      .replace(
        /\b((?:[\w-]*(?:token|secret|password|credential|api[_-]?key)[\w-]*)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
        '$1[redacted]',
      )
      .replace(
        /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
        '[redacted]',
      );
    for (const secret of this.secrets) value = value.replaceAll(secret, '[redacted]');
    return value;
  }

  write(chunk: Buffer): void {
    const parts = this.decoder.write(chunk).split('\n');
    for (let index = 0; index < parts.length; index++) {
      if (!this.oversized) {
        this.pending += parts[index];
        if (this.pending.length > MAX_LINE_LENGTH) {
          this.pending = '';
          this.oversized = true;
        }
      }
      if (index < parts.length - 1) this.finishLine();
    }
  }

  end(): void {
    this.pending += this.decoder.end();
    if (this.pending.length > MAX_LINE_LENGTH) {
      this.pending = '';
      this.oversized = true;
    }
    if (this.pending || this.oversized) this.finishLine();
  }

  snapshot(): string[] {
    return [...this.lines];
  }

  private finishLine(): void {
    // Omit oversized lines rather than retaining a possibly truncated secret.
    this.lines.push(
      this.oversized
        ? '[stderr line omitted: too long]'
        : this.redact(this.pending.replace(/\r$/, '')),
    );
    if (this.lines.length > MAX_LINES) this.lines.shift();
    this.pending = '';
    this.oversized = false;
  }
}
