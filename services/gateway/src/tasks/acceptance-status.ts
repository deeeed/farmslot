// The acceptance-criteria ledger (ADR-060 phase 5) as the gateway sees it: one
// JSON artifact beside a task directory's checklist, written only by
// `farmslot-agent ac`. The gateway observes it — it never records a verdict.
//
// This module is the single read layer. The watcher uses it to know which file to
// watch, `taskProgress` to put the ledger on the progress result every client
// already receives, and the gate/PR-body path to render coverage from structure
// instead of parsing a worker's markdown table.

import path from 'node:path';

import {
  ACCEPTANCE_STATUS_ARTIFACT,
  acceptanceCriterionId,
  type AcceptanceCriterionRef,
  type AcceptanceStatusLedger,
  renderAcceptanceCoverage,
  validateAcceptanceStatusLedger,
} from '@farmslot/protocol';

import { slotFileExists, type SlotLocality, slotReadFile } from '../core/slot-io.js';

/** Absolute path of a task directory's acceptance ledger. */
export function acceptanceStatusPathFor(taskDir: string): string {
  return path.join(taskDir, ACCEPTANCE_STATUS_ARTIFACT);
}

/**
 * Parse a ledger file. Throws on any deviation from the contract: `ac` is the
 * only writer and validates before writing, so a malformed ledger is a real
 * failure an operator must see, never a reason to report a run with no verdicts.
 */
export function parseAcceptanceStatusLedger(
  text: string,
  source = ACCEPTANCE_STATUS_ARTIFACT,
): AcceptanceStatusLedger {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid ${source}: ${(err as Error).message}`);
  }
  const issues = validateAcceptanceStatusLedger(raw);
  if (issues.length > 0) throw new Error(`invalid ${source}: ${issues.join('; ')}`);
  return raw as AcceptanceStatusLedger;
}

/**
 * The ledger beside a task directory, or null when the run has not written one.
 * A missing file means "no verdicts recorded yet"; a present one that does not
 * parse throws.
 */
export async function readAcceptanceStatusLedger(
  ctx: SlotLocality,
  taskDir: string,
): Promise<AcceptanceStatusLedger | null> {
  const ledgerPath = acceptanceStatusPathFor(taskDir);
  if (!(await slotFileExists(ctx, ledgerPath))) return null;
  return parseAcceptanceStatusLedger(await slotReadFile(ctx, ledgerPath), ledgerPath);
}

/**
 * A handoff or ledger the gateway could not read. Every caller must choose: the
 * terminal check fails the signal on it (completion cannot be proven when the
 * criteria list is unreadable), rendering surfaces it to the operator. Nothing
 * may treat it as "no criteria" — that would silently drop the requirement.
 */
export class AcceptanceReadError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(message);
    this.name = 'AcceptanceReadError';
  }
}

function handoffPathFor(taskDir: string): string {
  return path.posix.join(taskDir, 'inputs', 'handoff.json');
}

/**
 * The criteria task init registered, with their positional `AC-<N>` ids.
 *
 * A missing handoff means no criteria, the same way the mark engine's `readJson`
 * treats ENOENT. Anything else — unreadable file, invalid JSON — throws
 * {@link AcceptanceReadError}: a task whose criteria cannot be read has not
 * proven them.
 */
export async function readHandoffAcceptanceCriteria(
  ctx: SlotLocality,
  taskDir: string,
): Promise<AcceptanceCriterionRef[]> {
  const handoffPath = handoffPathFor(taskDir);
  let text: string;
  try {
    if (!(await slotFileExists(ctx, handoffPath))) return [];
    text = await slotReadFile(ctx, handoffPath);
  } catch (err) {
    throw new AcceptanceReadError(
      handoffPath,
      `cannot read ${handoffPath}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AcceptanceReadError(handoffPath, `invalid ${handoffPath}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new AcceptanceReadError(handoffPath, `invalid ${handoffPath}: expected an object`);
  }
  const task = (parsed as { task?: unknown }).task;
  if (!task || typeof task !== 'object') return [];
  const criteria = (task as { acceptanceCriteria?: unknown }).acceptanceCriteria;
  if (criteria === undefined) return [];
  if (!Array.isArray(criteria)) {
    throw new AcceptanceReadError(
      handoffPath,
      `invalid ${handoffPath}: task.acceptanceCriteria must be an array`,
    );
  }
  return criteria
    .map((text, index) => ({ id: acceptanceCriterionId(index), text: String(text) }))
    .filter((criterion) => criterion.text.trim().length > 0);
}

/**
 * Does this task directory's handoff list acceptance criteria? Throws
 * {@link AcceptanceReadError} when the handoff cannot be read, so a terminal check
 * fails closed instead of skipping the ledger requirement.
 */
export async function handoffListsAcceptanceCriteria(
  ctx: SlotLocality,
  taskDir: string,
): Promise<boolean> {
  return (await readHandoffAcceptanceCriteria(ctx, taskDir)).length > 0;
}

export interface AcceptanceStatusRead {
  /** Registered criteria; empty when the task has none or when the read failed. */
  criteria: AcceptanceCriterionRef[];
  /** Recorded verdicts, or null when none are recorded or the read failed. */
  ledger: AcceptanceStatusLedger | null;
  /** Why the ledger or the criteria could not be read; clients show this. */
  error?: string;
}

/**
 * Both halves for a display surface. A read failure is returned, never thrown and
 * never swallowed: progress and gate rendering must still describe the run, and a
 * client that shows nothing would hide a broken proof record. The terminal check
 * uses the throwing readers above instead.
 */
export async function readAcceptanceStatusForDisplay(
  ctx: SlotLocality,
  taskDir: string,
): Promise<AcceptanceStatusRead> {
  let criteria: AcceptanceCriterionRef[] = [];
  try {
    criteria = await readHandoffAcceptanceCriteria(ctx, taskDir);
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[acceptance] ${message}`);
    return { criteria: [], ledger: null, error: message };
  }
  try {
    return { criteria, ledger: await readAcceptanceStatusLedger(ctx, taskDir) };
  } catch (err) {
    const message = (err as Error).message;
    console.warn(`[acceptance] ${message}`);
    return { criteria, ledger: null, error: message };
  }
}

/** Ledger basename, for the `readTaskArtifactText(taskFile, name)` readers. */
export const ACCEPTANCE_STATUS_FILENAME = 'acceptance-status.json';

/**
 * Parse ledger text a caller already read from the orchestrator copy of a task
 * directory. Invalid content is reported and dropped: the gate must still open,
 * and the terminal contract check is what refuses to close the run on it.
 */
export function ledgerFromArtifactText(
  text: string | null | undefined,
): AcceptanceStatusLedger | null {
  if (!text?.trim()) return null;
  try {
    return parseAcceptanceStatusLedger(text);
  } catch (err) {
    console.warn(`[acceptance] ignoring unreadable ledger: ${(err as Error).message}`);
    return null;
  }
}

/**
 * The registered criteria from handoff text a caller already read on the
 * orchestrator copy. Unreadable content yields no criteria and an error string,
 * never a silent empty list, so the caller can say why the count is missing.
 */
export function handoffCriteriaFromText(text: string | null | undefined): {
  criteria: AcceptanceCriterionRef[];
  error?: string;
} {
  if (!text?.trim()) return { criteria: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { criteria: [], error: `invalid inputs/handoff.json: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { criteria: [], error: 'invalid inputs/handoff.json: expected an object' };
  }
  const task = (parsed as { task?: unknown }).task;
  if (!task || typeof task !== 'object') return { criteria: [] };
  const criteria = (task as { acceptanceCriteria?: unknown }).acceptanceCriteria;
  if (criteria === undefined) return { criteria: [] };
  if (!Array.isArray(criteria)) {
    return {
      criteria: [],
      error: 'invalid inputs/handoff.json: task.acceptanceCriteria must be an array',
    };
  }
  return {
    criteria: criteria
      .map((entry, index) => ({ id: acceptanceCriterionId(index), text: String(entry) }))
      .filter((criterion) => criterion.text.trim().length > 0),
  };
}

/**
 * Coverage markdown for the gate summary and the PR body: the ledger rendered
 * through the protocol renderer, or null when the run has no verdicts, so the
 * caller keeps its existing `recipe-coverage.md` behaviour. Farm templates still
 * write that file until they move onto `ac` (phase 4), so this is a preference,
 * never a replacement.
 */
export function acceptanceCoverageMarkdown(
  ledger: AcceptanceStatusLedger | null,
  criteria: ReadonlyArray<AcceptanceCriterionRef> = ledger?.criteria ?? [],
): string | null {
  if (!ledger || ledger.criteria.length === 0) return null;
  return renderAcceptanceCoverage(ledger, criteria.length > 0 ? criteria : ledger.criteria);
}
