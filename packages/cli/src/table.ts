import { stripAnsi } from './colors.js';

interface Column {
  name: string;
  minWidth?: number;
  shrinkable?: boolean;
}

export class TableRenderer {
  private columns: Column[] = [];
  private rows: Array<{ plain: string[]; colored: string[] }> = [];

  addColumn(name: string, opts?: Omit<Column, 'name'>): this {
    this.columns.push({ name, ...opts });
    return this;
  }

  addRow(plain: string[], colored: string[]): this {
    this.rows.push({ plain, colored });
    return this;
  }

  render(): string {
    if (!this.columns.length) return '';

    const GAP = 2;
    const termWidth = process.stdout.columns || 120;
    const gapStr = ' '.repeat(GAP);

    // Compute widths from header names + plain data
    const widths = this.columns.map((c) => c.name.length);
    for (const { plain } of this.rows) {
      for (let i = 0; i < widths.length; i++) {
        widths[i] = Math.max(widths[i], (plain[i] ?? '').length);
      }
    }

    // Shrink overflowing shrinkable columns (rightmost first)
    let total = widths.reduce((a, b) => a + b, 0) + GAP * (widths.length - 1);
    for (let i = this.columns.length - 1; i >= 0 && total > termWidth; i--) {
      if (!this.columns[i].shrinkable) continue;
      const min = this.columns[i].minWidth ?? 8;
      const shrink = Math.min(total - termWidth, widths[i] - min);
      if (shrink > 0) {
        widths[i] -= shrink;
        total -= shrink;
      }
    }

    const lines: string[] = [];

    // Header
    lines.push(
      this.columns.map((c, i) => `\x1b[1m${c.name.padEnd(widths[i])}\x1b[0m`).join(gapStr),
    );

    // Rows
    for (const { plain, colored } of this.rows) {
      const parts: string[] = [];
      for (let i = 0; i < this.columns.length; i++) {
        const p = plain[i] ?? '';
        const c = colored[i] ?? p;
        const needsTruncate = p.length > widths[i];
        const displayPlain = needsTruncate ? p.slice(0, widths[i] - 2) + '..' : p;
        // When truncated, colored ANSI codes would be split — use plain truncated text
        const displayColored = needsTruncate ? displayPlain : c;
        const visLen = stripAnsi(displayColored).length;
        parts.push(displayColored + ' '.repeat(Math.max(0, widths[i] - visLen)));
      }
      lines.push(parts.join(gapStr));
    }

    return lines.join('\n') + '\n';
  }
}
