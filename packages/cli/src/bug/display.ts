// display.ts — batch triage results table (port of scripts/lib/batch-triage-display.py).
// Reads score files, sorts by one-shot probability, and renders a colored table.

import { bold, boldRed, cyan, dim, green, red, stripAnsi, yellow } from '../colors.js';

import { readScoreFile } from './score-file.js';

export interface BatchRow {
  num: string;
  difficulty: string;
  prob: number;
  category: string;
  title: string;
  valid: boolean | null;
  validConf: number;
  validReason: string;
}

/** Read score files for the given keys and build display rows sorted by probability. */
export async function collectBatchRows(scoresDir: string, keys: string[]): Promise<BatchRow[]> {
  const rows: BatchRow[] = [];
  for (const key of [...new Set(keys)].sort()) {
    const score = await readScoreFile(`${scoresDir}/${key}.json`);
    if (!score) continue;
    const h = score.heuristic;
    const v = score.validation;
    const issueRef = score.issue_ref ?? key;
    const num = issueRef.includes('#') ? issueRef.split('#').pop()! : issueRef;
    rows.push({
      num,
      difficulty: h?.difficulty ?? '?',
      prob: typeof h?.one_shot_probability === 'number' ? h.one_shot_probability : 0,
      category: typeof h?.category === 'string' ? h.category : '?',
      title: score.bug_input?.title ?? '',
      valid: v ? v.still_valid : null,
      validConf: v?.confidence ?? 0,
      validReason: v?.reason ?? '',
    });
  }
  rows.sort((a, b) => b.prob - a.prob);
  return rows;
}

function colorDifficulty(d: string): string {
  if (d === 'low') return green(d);
  if (d === 'medium') return yellow(d);
  if (d === 'high') return red(d);
  if (d === 'extreme') return boldRed(d);
  return d;
}

function colorProb(p: number): string {
  const s = p.toFixed(2);
  if (p >= 0.7) return green(s);
  if (p >= 0.4) return yellow(s);
  return red(s);
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/** Pad colored text to a fixed visual width based on the raw (uncolored) length. */
function pad(text: string, width: number): string {
  const gap = width - stripAnsi(text).length;
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

/** Render the batch report (header + table + summary) as a string for stdout. */
export function renderBatchReport(
  rows: BatchRow[],
  opts: { repo: string; displayLabels?: string; termWidth?: number },
): string {
  const termWidth = opts.termWidth ?? 120;
  const out: string[] = [];
  let header = `Batch triage: ${bold(opts.repo)}`;
  if (opts.displayLabels) header += ` (${cyan(opts.displayLabels)})`;
  out.push(header);
  out.push(`Scored: ${bold(String(rows.length))} issues`);
  out.push('');

  if (rows.length === 0) {
    out.push(dim('No scored results.'));
    return `${out.join('\n')}\n`;
  }

  const hasValidation = rows.some((r) => r.valid !== null);
  const colNum = 7;
  const colDiff = 8;
  const colProb = 7;
  const colValid = 9;
  const colCat = 16;
  const fixed = hasValidation
    ? colNum + colDiff + colProb + colValid + colCat + 14
    : colNum + colDiff + colProb + colCat + 11;
  const colTitle = Math.max(20, termWidth - fixed);
  const sep = dim(' | ');

  const headerCells = [
    bold('#'.padEnd(colNum)),
    bold('Difficulty'.padEnd(colDiff)),
    bold('P(1-sh)'.padEnd(colProb)),
    ...(hasValidation ? [bold('Valid?'.padEnd(colValid))] : []),
    bold('Category'.padEnd(colCat)),
    bold('Title'),
  ];
  out.push(headerCells.join(sep));
  out.push(dim('-'.repeat(Math.min(termWidth, 120))));

  for (const r of rows) {
    const title = r.title.slice(0, colTitle);
    let num: string;
    let diff: string;
    let prob: string;
    let cat: string;
    let titleCell: string;
    if (r.valid === false) {
      num = pad(dim(r.num), colNum);
      diff = pad(dim(r.difficulty), colDiff);
      prob = pad(dim(r.prob.toFixed(2)), colProb);
      cat = pad(dim(r.category), colCat);
      titleCell = dim(title);
    } else {
      num = r.num.padEnd(colNum);
      diff = pad(colorDifficulty(r.difficulty), colDiff);
      prob = pad(colorProb(r.prob), colProb);
      cat = r.category.padEnd(colCat);
      titleCell = title;
    }
    const cells = [num, diff, prob];
    if (hasValidation) {
      const validText =
        r.valid === null
          ? dim('--')
          : r.valid
            ? `${green('yes')} ${dim(pct(r.validConf))}`
            : `${red('NO')}  ${dim(pct(r.validConf))}`;
      cells.push(pad(validText, colValid));
    }
    cells.push(cat, titleCell);
    out.push(cells.join(sep));
  }

  out.push('');
  const validRows = rows.filter((r) => r.valid !== false);
  const lowWins = validRows.filter((r) => r.difficulty === 'low' && r.prob >= 0.7).length;
  const expired = rows.filter((r) => r.valid === false).length;
  out.push(
    lowWins > 0
      ? green(`Low-effort wins (low + p>=0.7): ${lowWins}`)
      : dim('Low-effort wins (low + p>=0.7): 0'),
  );
  if (expired) out.push(red(`Likely fixed/expired: ${expired}`));

  if (hasValidation) {
    const invalid = rows.filter((r) => r.valid === false && r.validReason);
    if (invalid.length) {
      out.push('');
      out.push(bold('Likely fixed:'));
      for (const r of invalid) out.push(`  ${dim(`#${r.num}`)} ${r.validReason}`);
    }
  }

  return `${out.join('\n')}\n`;
}
