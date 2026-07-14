// score-file.ts — read/merge/write the projects/<name>/scores/<key>.json score
// files the bug pipeline maintains. IO edge for the pure protocol cores; the
// score-file shape is tooling state, not a protocol wire contract.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { BugInput, BugScore, BugValidation, FinalScore, LlmGrade } from '@farmslot/protocol';

export interface ScoreFile {
  issue_ref?: string;
  scored_at?: string;
  bug_input?: BugInput;
  heuristic?: BugScore;
  llm?: LlmGrade;
  final?: FinalScore;
  validation?: BugValidation & { validated_at?: string };
  [key: string]: unknown;
}

/** UTC timestamp in the `%Y-%m-%dT%H:%M:%SZ` shape the scripts wrote (no millis). */
export function isoTimestamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Read a score file. Returns null when the file does not exist (a fresh triage);
 * a corrupt file throws loudly rather than being silently reset — a malformed
 * score file is a real problem the operator must see, not swallow.
 */
export async function readScoreFile(file: string): Promise<ScoreFile | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as ScoreFile;
  } catch (err) {
    throw Object.assign(new Error(`corrupt score file ${file}: ${(err as Error).message}`), {
      code: 'CORRUPT_SCORE_FILE',
      userAction: `Inspect ${file} and delete it to re-triage from scratch.`,
    });
  }
}

/** Write a score file (pretty-printed, no trailing newline — json.dump parity), creating its directory. */
export async function writeScoreFile(file: string, score: ScoreFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(score, null, 2));
}
