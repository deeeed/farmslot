// learnings-router.ts — split a run's learnings into SYSTEM findings vs DOMAIN
// knowledge before the improvement engine sees them (MANUAL-000075).
//
// SYSTEM findings (template/checklist/flow/harness-usage problems) continue to
// the existing improvement path — the engine's projects/<project>/ applier.
// DOMAIN knowledge (product behavior, measurement methodology, environment
// gotchas) becomes a human-gated skill-antipattern DRAFT: exact text plus the
// target path in the external recipe-pr-qa-review skill; farmslot never writes
// to that repo. Ambiguous or unroutable entries become visible teaching holds —
// never both arms for one entry, never a silent drop. Every route terminates at
// a human gate.
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  Events,
  type LearningsAntipatternDraft,
  type LearningsDraftPayload,
  type LearningsDraftReceipt,
  type LearningsHold,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';
import { loadProjectVars } from '@farmslot/slot-config';

import { getLLMConfig } from '../llm/config.js';
import { callLLM } from '../llm/index.js';
import { pendingDecisionForRun } from '../run-engine/decision-projection.js';
import { getRun, updateRun } from '../runs/store.js';

import { improvementBroadcast } from './improvement-engine.js';

export const LEARNINGS_DRAFT_DECISION_TYPE = 'engine_learnings_draft';
const ANTIPATTERN_SKILL_BASE = 'domains/agentic/skills/recipe-pr-qa-review/references/antipatterns';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,60}$/;

export type LearningsEntryKind = 'system' | 'domain' | 'unclassified';

export interface LearningsEntry {
  /** `## …` section heading the entry appeared under, when any. */
  section: string | null;
  text: string;
}

// ─── Splitting ───

/**
 * Split a (possibly family-composed, multi-section) learnings blob into
 * routable entries. Entries are top-level `- ` bullets with their continuation
 * lines; a section with prose but no bullets becomes one whole-block entry so
 * malformed content is held, not dropped.
 */
export function splitLearningsEntries(blob: string): LearningsEntry[] {
  const entries: LearningsEntry[] = [];
  let section: string | null = null;
  let current: string[] | null = null;
  let prose: string[] = [];

  const flushCurrent = () => {
    if (current) entries.push({ section, text: current.join('\n').trimEnd() });
    current = null;
  };
  const flushProse = () => {
    const text = prose.join('\n').trim();
    if (text) entries.push({ section, text });
    prose = [];
  };

  for (const line of blob.split('\n')) {
    if (/^##\s/.test(line)) {
      flushCurrent();
      flushProse();
      section = line.replace(/^##\s+/, '').trim();
      continue;
    }
    if (/^#\s/.test(line)) {
      flushCurrent();
      flushProse();
      continue;
    }
    if (/^- /.test(line)) {
      flushCurrent();
      flushProse();
      current = [line];
      continue;
    }
    if (current) {
      if (line.trim() === '') {
        flushCurrent();
      } else {
        current.push(line);
      }
      continue;
    }
    prose.push(line);
  }
  flushCurrent();
  flushProse();
  return entries;
}

// ─── Classification ───

// Conservative fast path: only unmistakable orchestration/template/tooling
// language classifies as SYSTEM without an LLM round; everything else is the
// model's call, and anything the model fumbles lands in the teaching hold.
const SYSTEM_HEURISTIC_RE =
  /\b(task template|worker template|task file|TASK\.md|checklist step|recipe schema|schema_version|farmslot|gateway dispatch|artifact contract|learnings\.md)\b/i;

function heuristicKind(entry: LearningsEntry): LearningsEntryKind | null {
  return SYSTEM_HEURISTIC_RE.test(entry.text) ? 'system' : null;
}

const CLASSIFY_SYSTEM_PROMPT = `You route learning entries from completed agent runs into exactly one bucket each:

- "system": a problem or lesson about OUR run orchestration — task templates, checklists, flow steps, harness/CLI usage contracts, artifact expectations, stale tool instructions.
- "domain": reusable product/QA knowledge — application behavior, measurement methodology, seeding traps, precision quirks, flaky surfaces, environment gotchas.
- "unclassified": you are not confident it is one of the above.

Respond with ONLY a JSON array of bucket tokens, one per numbered entry, in order. Example: ["domain","system"]`;

type LearningsClassifier = (entries: LearningsEntry[]) => Promise<LearningsEntryKind[]>;

async function classifyViaLLM(entries: LearningsEntry[]): Promise<LearningsEntryKind[]> {
  const cfg = getLLMConfig();
  const userPrompt = entries
    .map((entry, index) => `${index + 1}. ${entry.text.replace(/\s+/g, ' ').slice(0, 600)}`)
    .join('\n');
  const result = await callLLM({
    provider: cfg.defaultProvider,
    model: cfg.intelligenceModel,
    systemPrompt: CLASSIFY_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 400,
    allowCliFallback: false,
  });
  const match = result.text.match(/\[[\s\S]*?\]/);
  if (!match) throw new Error('learnings classifier returned no JSON array');
  const parsed: unknown = JSON.parse(match[0]);
  if (!Array.isArray(parsed) || parsed.length !== entries.length) {
    throw new Error(
      `learnings classifier returned ${Array.isArray(parsed) ? parsed.length : 'non-array'} tokens for ${entries.length} entries`,
    );
  }
  return parsed.map((token) =>
    token === 'system' || token === 'domain' ? token : ('unclassified' as const),
  );
}

let classifierOverride: LearningsClassifier | null = null;
/** @internal Test seam only. */
export function __setLearningsClassifierForTest(fn: LearningsClassifier | null): void {
  classifierOverride = fn;
}

export interface ClassifiedLearnings {
  system: LearningsEntry[];
  domain: LearningsEntry[];
  unclassified: LearningsEntry[];
}

export async function classifyLearningsEntries(
  entries: LearningsEntry[],
): Promise<ClassifiedLearnings> {
  const buckets: ClassifiedLearnings = { system: [], domain: [], unclassified: [] };
  const undecided: LearningsEntry[] = [];
  for (const entry of entries) {
    const fast = heuristicKind(entry);
    if (fast) buckets[fast].push(entry);
    else undecided.push(entry);
  }
  if (undecided.length === 0) return buckets;

  let kinds: LearningsEntryKind[];
  try {
    kinds = await (classifierOverride ?? classifyViaLLM)(undecided);
  } catch (err) {
    // Classification failure must not drop or mis-route entries: everything
    // undecided becomes a visible hold for the human gate.
    console.warn(`[learnings-router] classification failed: ${(err as Error).message}`);
    kinds = undecided.map(() => 'unclassified' as const);
  }
  undecided.forEach((entry, index) => buckets[kinds[index] ?? 'unclassified'].push(entry));
  return buckets;
}

// ─── Domain drafts ───

type AntipatternDrafter = (
  entries: LearningsEntry[],
) => Promise<Array<{ id: string; symptom: string; cause: string; action: string } | null>>;

const DRAFT_SYSTEM_PROMPT = `You convert QA/product learning entries into skill antipattern drafts. For EACH numbered entry produce one object:
{"id": "<kebab-case-slug, 3-60 chars>", "symptom": "<what the operator observes>", "cause": "<why it happens>", "action": "<what to do instead>"}

Respond with ONLY a JSON array, one object per entry, in order. Use null for an entry you cannot convert faithfully.`;

async function draftViaLLM(entries: LearningsEntry[]): ReturnType<AntipatternDrafter> {
  const cfg = getLLMConfig();
  const userPrompt = entries
    .map((entry, index) => `${index + 1}. ${entry.text.replace(/\s+/g, ' ').slice(0, 900)}`)
    .join('\n');
  const result = await callLLM({
    provider: cfg.defaultProvider,
    model: cfg.improvementModel,
    systemPrompt: DRAFT_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 1800,
    allowCliFallback: false,
  });
  const match = result.text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('antipattern drafter returned no JSON array');
  const parsed: unknown = JSON.parse(match[0]);
  if (!Array.isArray(parsed) || parsed.length !== entries.length) {
    throw new Error(
      `antipattern drafter returned ${Array.isArray(parsed) ? parsed.length : 'non-array'} drafts for ${entries.length} entries`,
    );
  }
  return parsed.map((raw) => validAntipatternDraft(raw));
}

/** Shape/slug gate for generated drafts — authoritative in routeLearnings so
 * an injected or misbehaving drafter can never smuggle an invalid draft. */
function validAntipatternDraft(
  raw: unknown,
): { id: string; symptom: string; cause: string; action: string } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const symptom = typeof candidate.symptom === 'string' ? candidate.symptom.trim() : '';
  const cause = typeof candidate.cause === 'string' ? candidate.cause.trim() : '';
  const action = typeof candidate.action === 'string' ? candidate.action.trim() : '';
  if (!SLUG_RE.test(id) || !symptom || !cause || !action) return null;
  return { id, symptom, cause, action };
}

let drafterOverride: AntipatternDrafter | null = null;
/** @internal Test seam only. */
export function __setAntipatternDrafterForTest(fn: AntipatternDrafter | null): void {
  drafterOverride = fn;
}

/** The skills-repo path a repo-key routes to. Exported for tests. */
export function antipatternTargetPath(repoKey: string, slug: string): string {
  return `${ANTIPATTERN_SKILL_BASE}/${repoKey}/${slug}.md`;
}

/** Repo-key comes from pack configuration, never guessed (AC2): projects
 * declare vars.antipattern_repo_key in project.json. */
export async function resolveAntipatternRepoKey(project: string): Promise<string | null> {
  try {
    const vars = await loadProjectVars(project);
    const raw = (vars.projectJson as { vars?: Record<string, unknown> }).vars?.antipattern_repo_key;
    return typeof raw === 'string' && /^[\w.-]+$/.test(raw.trim()) ? raw.trim() : null;
  } catch (err) {
    console.warn(
      `[learnings-router] loadProjectVars(${project}) failed: ${(err as Error).message}`,
    );
    return null;
  }
}

// ─── Receipts (inbox processed.jsonl) ───

interface InboxCorrelation {
  packageId: string;
}

function learningsInboxRoot(): { root: string } | { skipped: string } {
  const fromEnv = process.env.FARMSLOT_LEARNINGS_INBOX?.trim();
  if (fromEnv) return { root: fromEnv };
  return { skipped: 'no learnings inbox configured (set FARMSLOT_LEARNINGS_INBOX)' };
}

async function findCapturedPackage(inboxRoot: string, run: Run): Promise<InboxCorrelation | null> {
  const ticket = run.ticketOrPr?.trim().toLowerCase();
  if (!ticket) return null;
  const indexPath = path.join(inboxRoot, 'indexes', 'by-ticket', `${ticket}.jsonl`);
  const raw = await readFile(indexPath, 'utf-8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!raw) return null;
  const lines = raw.split('\n').filter((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const record = JSON.parse(lines[i]!) as { packageId?: string };
      if (record.packageId) return { packageId: record.packageId };
    } catch {
      // A malformed index line is the inbox repo's problem; keep scanning for
      // the newest parseable record rather than failing the whole receipt.
      continue;
    }
  }
  return null;
}

/** Append exactly one processed.jsonl receipt per captured package (AC5). */
export async function appendProcessedReceipt(
  run: Run,
  decisionId: string,
): Promise<LearningsDraftReceipt> {
  const inbox = learningsInboxRoot();
  if ('skipped' in inbox) return { status: 'skipped', reason: inbox.skipped };

  const correlation = await findCapturedPackage(inbox.root, run).catch((err: Error) => {
    console.warn(`[learnings-router] inbox correlation failed: ${err.message}`);
    return null;
  });
  if (!correlation) {
    return {
      status: 'skipped',
      reason: `no captured package found for ticket "${run.ticketOrPr ?? ''}" in ${inbox.root}`,
    };
  }

  const processedPath = path.join(inbox.root, 'indexes', 'processed.jsonl');
  const existing = await readFile(processedPath, 'utf-8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
  for (const line of existing.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { packageId?: string };
      if (record.packageId === correlation.packageId) {
        return { status: 'already-processed', packageId: correlation.packageId };
      }
    } catch {
      // Malformed receipt lines cannot be matched; the append below stays
      // exactly-once for every parseable record.
      continue;
    }
  }

  const appendedAt = new Date().toISOString();
  const receiptLine = {
    packageId: correlation.packageId,
    processedAt: appendedAt,
    by: 'farmslot-gateway',
    outcome: 'proposal',
    link: `run:${run.id} decision:${decisionId}`,
    note: 'learnings router emitted a skill-antipattern draft for this package',
  };
  await mkdir(path.dirname(processedPath), { recursive: true });
  await appendFile(processedPath, `${JSON.stringify(receiptLine)}\n`, 'utf-8');
  return { status: 'appended', packageId: correlation.packageId, appendedAt };
}

// ─── Routing + card emission ───

export interface RoutedLearnings {
  buckets: ClassifiedLearnings;
  drafts: LearningsAntipatternDraft[];
  holds: LearningsHold[];
  /** System-only learnings reconstructed for the improvement engine; null when
   * no entry classified system. */
  systemContent: string | null;
}

function reconstructSections(entries: LearningsEntry[]): string {
  const parts: string[] = [];
  let lastSection: string | null = null;
  for (const entry of entries) {
    if (entry.section !== lastSection && entry.section) {
      parts.push(`## ${entry.section}`);
    }
    lastSection = entry.section;
    parts.push(entry.text);
  }
  return parts.join('\n\n');
}

export async function routeLearnings(project: string, learnings: string): Promise<RoutedLearnings> {
  const entries = splitLearningsEntries(learnings);
  const buckets = await classifyLearningsEntries(entries);

  const holds: LearningsHold[] = buckets.unclassified.map((entry) => ({
    entry: entry.text,
    reason:
      'unclassified — the router could not confidently pick system vs domain; reword the entry or route it manually',
  }));

  const drafts: LearningsAntipatternDraft[] = [];
  if (buckets.domain.length > 0) {
    const repoKey = await resolveAntipatternRepoKey(project);
    if (!repoKey) {
      for (const entry of buckets.domain) {
        holds.push({
          entry: entry.text,
          reason: `no antipattern repo-key configured for project "${project}" — set vars.antipattern_repo_key in its project.json`,
        });
      }
    } else {
      let generated: Awaited<ReturnType<AntipatternDrafter>>;
      try {
        generated = await (drafterOverride ?? draftViaLLM)(buckets.domain);
      } catch (err) {
        console.warn(`[learnings-router] draft generation failed: ${(err as Error).message}`);
        generated = buckets.domain.map(() => null);
      }
      buckets.domain.forEach((entry, index) => {
        const draft = validAntipatternDraft(generated[index]);
        if (!draft) {
          holds.push({
            entry: entry.text,
            reason: 'antipattern draft generation failed for this entry — draft it manually',
          });
          return;
        }
        drafts.push({
          ...draft,
          targetPath: antipatternTargetPath(repoKey, draft.id),
          sourceEntry: entry.text,
        });
      });
    }
  }

  return {
    buckets,
    drafts,
    holds,
    systemContent: buckets.system.length > 0 ? reconstructSections(buckets.system) : null,
  };
}

/**
 * Emit the human-gated learnings-draft decision card (drafts + holds) and, when
 * a draft exists for a captured inbox package, append the exactly-once
 * processed.jsonl receipt. Returns the decision id, or null when there was
 * nothing to surface or the run vanished.
 */
export async function emitLearningsDraftDecision(
  runId: string,
  routed: RoutedLearnings,
): Promise<string | null> {
  if (routed.drafts.length === 0 && routed.holds.length === 0) return null;
  const run = getRun(runId);
  if (!run) return null;

  const decisionId = `lrn-${runId}-${randomUUID()}`;
  const receipt: LearningsDraftReceipt | undefined =
    routed.drafts.length > 0 ? await appendProcessedReceipt(run, decisionId) : undefined;

  const payload: LearningsDraftPayload = {
    kind: 'learnings-draft',
    project: run.project,
    sourceRunId: runId,
    drafts: routed.drafts,
    holds: routed.holds,
    ...(receipt ? { receipt } : {}),
  };
  const parts: string[] = [];
  if (routed.drafts.length > 0) {
    parts.push(
      `${routed.drafts.length} domain antipattern draft(s) for the recipe-pr-qa-review skill — open a PR on the skills repo to land them`,
    );
  }
  if (routed.holds.length > 0) {
    parts.push(`${routed.holds.length} entr(ies) held for teaching — nothing was dropped`);
  }
  const decision: RunDecision = {
    id: decisionId,
    type: LEARNINGS_DRAFT_DECISION_TYPE,
    title: 'Learnings routed: domain drafts & holds',
    description: `${parts.join('; ')}. Farmslot never writes to the skills repo — this card is the human gate.`,
    actions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
    createdAt: new Date().toISOString(),
    payload,
  };
  const decisions = [...(run.decisions ?? []), decision];
  updateRun(runId, { decisions });
  improvementBroadcast(Events.RUN_DECISION_NEW, {
    runId,
    decision: pendingDecisionForRun(run, decision),
    slotId: run.slotId,
  });
  return decisionId;
}

/** Default inbox home hint used in docs/errors; receipts only activate via env. */
export function defaultInboxHint(): string {
  return path.join(homedir(), 'dev', 'experimental-distributed-learnings');
}
