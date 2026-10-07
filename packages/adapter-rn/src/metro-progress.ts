// Metro's bundle progress as a setup stage reports it. Metro and the Expo CLI
// print `iOS ./index.js ▓▓▓▓░░ 61.3% (4210/6900)` while bundling, and
// coalesce-metro-log keeps those lines in the Metro log; a caller tailing that
// log passes each line here and hands the result to its stage handle.

const BUNDLE_PROGRESS =
  /^\s*(?:iOS|Android)\b.*?(\d{1,3}(?:\.\d+)?)%(?:\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\))?/u;

export interface MetroBundleProgress {
  message: 'bundling';
  percent: number;
  current?: number;
  total?: number;
  unit?: 'modules';
}

/** The progress a Metro bundle line shows, or null for any other line. */
export function metroBundleProgress(line: string): MetroBundleProgress | null {
  const match = BUNDLE_PROGRESS.exec(line);
  if (!match) return null;
  const percent = Number(match[1]);
  if (match[2] === undefined || match[3] === undefined) return { message: 'bundling', percent };
  return {
    message: 'bundling',
    percent,
    current: Number(match[2]),
    total: Number(match[3]),
    unit: 'modules',
  };
}
