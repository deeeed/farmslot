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
 * Same read, but a broken ledger is reported and skipped instead of failing the
 * caller. Progress and gate rendering must still describe the run when one
 * artifact is unreadable; the terminal contract check is what refuses the run.
 */
export async function readAcceptanceStatusLedgerOrWarn(
  ctx: SlotLocality,
  taskDir: string,
): Promise<AcceptanceStatusLedger | null> {
  try {
    return await readAcceptanceStatusLedger(ctx, taskDir);
  } catch (err) {
    console.warn(
      `[acceptance] ignoring unreadable ledger in ${taskDir}: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * The criteria task init registered, with their positional `AC-<N>` ids. Empty when
 * the task had none, or when the handoff cannot be read — the artifact contract check
 * reports a missing input; this reader must not invent a criterion or a gate.
 */
export async function readHandoffAcceptanceCriteria(
  ctx: SlotLocality,
  taskDir: string,
): Promise<AcceptanceCriterionRef[]> {
  const handoffPath = path.posix.join(taskDir, 'inputs', 'handoff.json');
  try {
    if (!(await slotFileExists(ctx, handoffPath))) return [];
    const parsed: unknown = JSON.parse(await slotReadFile(ctx, handoffPath));
    if (!parsed || typeof parsed !== 'object') return [];
    const task = (parsed as { task?: unknown }).task;
    if (!task || typeof task !== 'object') return [];
    const criteria = (task as { acceptanceCriteria?: unknown }).acceptanceCriteria;
    if (!Array.isArray(criteria)) return [];
    return criteria
      .map((text, index) => ({ id: acceptanceCriterionId(index), text: String(text) }))
      .filter((criterion) => criterion.text.trim().length > 0);
  } catch (err) {
    console.warn(`[acceptance] could not read ${handoffPath}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Does this task directory's handoff list acceptance criteria? The gateway asks
 * before enforcing the ledger on a terminal signal, so a run whose task had no
 * criteria is unaffected.
 */
export async function handoffListsAcceptanceCriteria(
  ctx: SlotLocality,
  taskDir: string,
): Promise<boolean> {
  return (await readHandoffAcceptanceCriteria(ctx, taskDir)).length > 0;
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
 * Coverage markdown for the gate summary and the PR body: the ledger rendered
 * through the protocol renderer, or null when the run has no verdicts, so the
 * caller keeps its existing `recipe-coverage.md` behaviour. Farm templates still
 * write that file until they move onto `ac` (phase 4), so this is a preference,
 * never a replacement.
 */
export function acceptanceCoverageMarkdown(ledger: AcceptanceStatusLedger | null): string | null {
  if (!ledger || ledger.criteria.length === 0) return null;
  return renderAcceptanceCoverage(ledger);
}
