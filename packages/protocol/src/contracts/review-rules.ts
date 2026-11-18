/**
 * Review rule packs (ADR-0073 Amendment 1). Farmslot defines the contracts only;
 * every pack and its rules belong to the project that owns them.
 *
 * - A pack generalises a domain review skill's rule families: each family is a
 *   reference-file section whose anchor is its stable id, with the areas it
 *   covers, its status and class, and the cause of each rule.
 * - A selection accounts for every live family for one diff, each with a reason,
 *   so a deterministic or model selector can plug in and nothing leaves a review
 *   silently.
 * - A proposal is one curated rule change from a finding, a miss, an audit or a
 *   stale check, decided by a person.
 *
 * See apps/docs/docs/reference/review-rule-packs.md.
 */

import { isRelativeSafePath, onlyKeys, record, SKILL_NAME } from './skill-fields.js';

export const REVIEW_RULE_STATUSES = ['active', 'proposed', 'stale', 'retired'] as const;
export type ReviewRuleStatus = (typeof REVIEW_RULE_STATUSES)[number];

export const REVIEW_RULE_CLASSES = ['blocking', 'advisory'] as const;
export type ReviewRuleClass = (typeof REVIEW_RULE_CLASSES)[number];

/** A rule's cause: a run, PR, incident or decision ref, or `pre-0073` when none was recorded. */
export const REVIEW_RULE_UNRECORDED_CAUSE = 'pre-0073';

export interface ReviewRule {
  label: string;
  why: string;
}

/** `always` families are selected for every diff; otherwise path globs per client. */
export type ReviewRuleAreas = { always: true } | { paths: Record<string, string[]> };

export interface ReviewRuleFamily {
  /** The family's anchor in its reference file; stable and unique in the pack. */
  id: string;
  title: string;
  /** Skill-relative reference file holding the family, e.g. `references/shared.md`. */
  file: string;
  areas: ReviewRuleAreas;
  status: ReviewRuleStatus;
  class: ReviewRuleClass;
  /** The doc section the family checks against, as the family's `Docs:` line names it. */
  doc?: string;
  rules: ReviewRule[];
}

export interface ReviewRulePack {
  schemaVersion: 1;
  id: string;
  /** Where the canonical rules live, and the revision this pack was generated from. */
  source: { repository: string; revision: string };
  families: ReviewRuleFamily[];
}

export const REVIEW_RULE_SELECTOR_KINDS = ['deterministic', 'model'] as const;
export type ReviewRuleSelectorKind = (typeof REVIEW_RULE_SELECTOR_KINDS)[number];

export interface ReviewRuleSelectionEntry {
  id: string;
  selected: boolean;
  /** One line; a skipped family's reason becomes its `[OPTIONAL: ...]` step text. */
  reason: string;
}

export interface ReviewRuleSelection {
  schemaVersion: 1;
  pack: { id: string; sha256: string };
  selector: { kind: ReviewRuleSelectorKind; id: string; version: string };
  client: string;
  families: ReviewRuleSelectionEntry[];
}

export const REVIEW_RULE_PROPOSAL_KINDS = ['add', 'edit', 'merge', 'retire', 'stale'] as const;
export type ReviewRuleProposalKind = (typeof REVIEW_RULE_PROPOSAL_KINDS)[number];

export const REVIEW_RULE_PROPOSAL_SOURCES = ['finding', 'miss', 'audit', 'stale-check'] as const;
export type ReviewRuleProposalSource = (typeof REVIEW_RULE_PROPOSAL_SOURCES)[number];

export const REVIEW_RULE_CONFIRMATIONS = [
  'fix',
  'accepted-finding',
  'second-check',
  'stale-check',
] as const;
export type ReviewRuleConfirmation = (typeof REVIEW_RULE_CONFIRMATIONS)[number];

/** ADR-0073's recurrence bar: the same failure in two independent tasks, or blocker-class. */
export const REVIEW_RULE_RECURRENCES = ['recurring', 'blocker'] as const;
export type ReviewRuleRecurrence = (typeof REVIEW_RULE_RECURRENCES)[number];

export const REVIEW_RULE_DECISIONS = ['pending', 'approved', 'rejected'] as const;
export type ReviewRuleDecisionStatus = (typeof REVIEW_RULE_DECISIONS)[number];

export interface ReviewRuleProposal {
  schemaVersion: 1;
  pack: string;
  kind: ReviewRuleProposalKind;
  /** Required for every kind except `add`. */
  family?: string;
  rule?: string;
  source: ReviewRuleProposalSource;
  /** A run or PR ref, with `file:line` for a finding or a miss. */
  evidence: { ref: string; location?: string }[];
  confirmation: ReviewRuleConfirmation;
  /**
   * The inclusion bar, required for add, edit and merge: recurrence, and the
   * family ids examined to show the rule is not already covered.
   */
  bar?: { recurrence: ReviewRuleRecurrence; examined: string[] };
  change: string;
  /** Net change in the pack's rule count; tighten or merge before adding. */
  netRuleDelta: number;
  decision: { status: ReviewRuleDecisionStatus; reason?: string };
}

const ANCHOR = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** `path/to/file.ts:42` or `path/to/file.ts:42-48`. */
const FILE_LINE = /^\S+:\d+(?:-\d+)?$/;

function oneLine(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value))
    throw new Error(`${field} must be one non-empty line`);
  return value.trim();
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${field} must be a non-empty string`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
    throw new Error(`${field} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function areas(value: unknown, field: string): ReviewRuleAreas {
  const input = record(value, field);
  if (input.always === true) {
    onlyKeys(input, ['always'], field);
    return { always: true };
  }
  if (input.paths === undefined) throw new Error(`${field} needs always: true or paths`);
  onlyKeys(input, ['paths'], field);
  const paths = record(input.paths, `${field}.paths`);
  const clients = Object.keys(paths);
  if (clients.length === 0) throw new Error(`${field} needs always: true or paths`);
  const out: Record<string, string[]> = {};
  for (const client of clients) {
    const globs = paths[client];
    if (!SKILL_NAME.test(client))
      throw new Error(`${field}.paths key "${client}" must be a simple name`);
    if (
      !Array.isArray(globs) ||
      globs.length === 0 ||
      globs.some((glob) => typeof glob !== 'string' || !glob.trim())
    )
      throw new Error(`${field}.paths.${client} must be a non-empty array of path globs`);
    out[client] = globs as string[];
  }
  return { paths: out };
}

/** Validates a review rule pack; throws with the offending field. */
export function parseReviewRulePack(value: unknown, field = 'pack'): ReviewRulePack {
  const pack = record(value, field);
  onlyKeys(pack, ['schemaVersion', 'id', 'source', 'families'], field);
  if (pack.schemaVersion !== 1) throw new Error(`${field}.schemaVersion must be 1`);
  if (typeof pack.id !== 'string' || !SKILL_NAME.test(pack.id))
    throw new Error(`${field}.id must be a simple name`);
  const source = record(pack.source, `${field}.source`);
  onlyKeys(source, ['repository', 'revision'], `${field}.source`);
  const repository = text(source.repository, `${field}.source.repository`);
  const revision = text(source.revision, `${field}.source.revision`);
  if (!Array.isArray(pack.families) || pack.families.length === 0)
    throw new Error(`${field}.families must be a non-empty array`);
  const ids = new Set<string>();
  const families = pack.families.map((raw, index): ReviewRuleFamily => {
    const at = `${field}.families[${index}]`;
    const family = record(raw, at);
    onlyKeys(family, ['id', 'title', 'file', 'areas', 'status', 'class', 'doc', 'rules'], at);
    if (typeof family.id !== 'string' || !ANCHOR.test(family.id))
      throw new Error(`${at}.id must be a lowercase anchor`);
    if (ids.has(family.id)) throw new Error(`${field} has duplicate family id "${family.id}"`);
    ids.add(family.id);
    if (!isRelativeSafePath(family.file)) throw new Error(`${at}.file must be skill-relative`);
    if (!Array.isArray(family.rules)) throw new Error(`${at}.rules must be an array`);
    const rules = family.rules.map((rawRule, ruleIndex): ReviewRule => {
      const ruleAt = `${at}.rules[${ruleIndex}]`;
      const rule = record(rawRule, ruleAt);
      onlyKeys(rule, ['label', 'why'], ruleAt);
      return { label: text(rule.label, `${ruleAt}.label`), why: text(rule.why, `${ruleAt}.why`) };
    });
    return {
      id: family.id,
      title: text(family.title, `${at}.title`),
      file: family.file,
      areas: areas(family.areas, `${at}.areas`),
      status: oneOf(family.status, REVIEW_RULE_STATUSES, `${at}.status`),
      class: oneOf(family.class, REVIEW_RULE_CLASSES, `${at}.class`),
      ...(family.doc !== undefined ? { doc: text(family.doc, `${at}.doc`) } : {}),
      rules,
    };
  });
  return { schemaVersion: 1, id: pack.id, source: { repository, revision }, families };
}

/** The frozen review inputs a selection must have been computed for. */
export interface ReviewRuleSelectionBinding {
  /** Digest of the frozen pack file. */
  sha256: string;
  /** The client the review skill declared. */
  client: string;
}

/**
 * Validates a selection against its pack and the frozen review inputs: it was
 * computed for this pack digest and client, every family that is not retired is
 * named exactly once with a one-line reason, and `always` families are selected.
 */
export function parseReviewRuleSelection(
  value: unknown,
  pack: ReviewRulePack,
  binding: ReviewRuleSelectionBinding,
  field = 'selection',
): ReviewRuleSelection {
  const selection = record(value, field);
  onlyKeys(selection, ['schemaVersion', 'pack', 'selector', 'client', 'families'], field);
  if (selection.schemaVersion !== 1) throw new Error(`${field}.schemaVersion must be 1`);
  const packRef = record(selection.pack, `${field}.pack`);
  onlyKeys(packRef, ['id', 'sha256'], `${field}.pack`);
  if (packRef.id !== pack.id) throw new Error(`${field}.pack.id must be "${pack.id}"`);
  if (typeof packRef.sha256 !== 'string' || !SHA256.test(packRef.sha256))
    throw new Error(`${field}.pack.sha256 must be a sha256 hex digest`);
  if (packRef.sha256 !== binding.sha256)
    throw new Error(
      `${field} was computed for pack digest ${packRef.sha256}, not the frozen ${binding.sha256}`,
    );
  const selector = record(selection.selector, `${field}.selector`);
  onlyKeys(selector, ['kind', 'id', 'version'], `${field}.selector`);
  const kind = oneOf(selector.kind, REVIEW_RULE_SELECTOR_KINDS, `${field}.selector.kind`);
  const selectorId = text(selector.id, `${field}.selector.id`);
  const version = text(selector.version, `${field}.selector.version`);
  if (typeof selection.client !== 'string' || !SKILL_NAME.test(selection.client))
    throw new Error(`${field}.client must be a simple name`);
  if (selection.client !== binding.client)
    throw new Error(
      `${field} was computed for client ${selection.client}, not the declared ${binding.client}`,
    );
  if (!Array.isArray(selection.families)) throw new Error(`${field}.families must be an array`);

  const byId = new Map(pack.families.map((family) => [family.id, family]));
  const seen = new Set<string>();
  const families = selection.families.map((raw, index): ReviewRuleSelectionEntry => {
    const at = `${field}.families[${index}]`;
    const entry = record(raw, at);
    onlyKeys(entry, ['id', 'selected', 'reason'], at);
    if (typeof entry.id !== 'string') throw new Error(`${at}.id must be a family id`);
    const family = byId.get(entry.id);
    if (!family)
      throw new Error(`${field} names family "${entry.id}", which the pack does not have`);
    if (family.status === 'retired')
      throw new Error(`${field} names family "${entry.id}", which the pack retired`);
    if (seen.has(entry.id)) throw new Error(`${field} names family "${entry.id}" twice`);
    seen.add(entry.id);
    if (typeof entry.selected !== 'boolean') throw new Error(`${at}.selected must be a boolean`);
    if (
      typeof entry.reason !== 'string' ||
      !entry.reason.trim() ||
      /[\r\n]/.test(entry.reason) ||
      /[[\]]/.test(entry.reason)
    )
      throw new Error(`${at}.reason must be one non-empty line without square brackets`);
    if (!entry.selected && 'always' in family.areas)
      throw new Error(`${field}: family "${entry.id}" is always selected`);
    return { id: entry.id, selected: entry.selected, reason: entry.reason.trim() };
  });
  for (const family of pack.families)
    if (family.status !== 'retired' && !seen.has(family.id))
      throw new Error(`${field} omits family "${family.id}"`);
  return {
    schemaVersion: 1,
    pack: { id: pack.id, sha256: packRef.sha256 },
    selector: { kind, id: selectorId, version },
    client: selection.client,
    families,
  };
}

/** Validates one rule-change proposal; throws with the offending field. */
export function parseReviewRuleProposal(value: unknown, field = 'proposal'): ReviewRuleProposal {
  const proposal = record(value, field);
  onlyKeys(
    proposal,
    [
      'schemaVersion',
      'pack',
      'kind',
      'family',
      'rule',
      'source',
      'evidence',
      'confirmation',
      'bar',
      'change',
      'netRuleDelta',
      'decision',
    ],
    field,
  );
  if (proposal.schemaVersion !== 1) throw new Error(`${field}.schemaVersion must be 1`);
  if (typeof proposal.pack !== 'string' || !SKILL_NAME.test(proposal.pack))
    throw new Error(`${field}.pack must be a simple name`);
  const kind = oneOf(proposal.kind, REVIEW_RULE_PROPOSAL_KINDS, `${field}.kind`);
  if (proposal.family === undefined && kind !== 'add')
    throw new Error(`${field}.family is required for an ${kind}`);
  if (
    proposal.family !== undefined &&
    (typeof proposal.family !== 'string' || !ANCHOR.test(proposal.family))
  )
    throw new Error(`${field}.family must be a lowercase anchor`);
  const source = oneOf(proposal.source, REVIEW_RULE_PROPOSAL_SOURCES, `${field}.source`);
  if (!Array.isArray(proposal.evidence) || proposal.evidence.length === 0)
    throw new Error(`${field}.evidence must be a non-empty array`);
  const evidence = proposal.evidence.map((raw, index) => {
    const at = `${field}.evidence[${index}]`;
    const item = record(raw, at);
    onlyKeys(item, ['ref', 'location'], at);
    const ref = text(item.ref, `${at}.ref`);
    if (item.location === undefined && (source === 'finding' || source === 'miss'))
      throw new Error(`${at}.location (file:line) is required for a ${source}`);
    if (item.location === undefined) return { ref };
    if (typeof item.location !== 'string' || !FILE_LINE.test(item.location))
      throw new Error(`${at}.location must be file:line or file:start-end`);
    return { ref, location: item.location };
  });
  const confirmation = oneOf(
    proposal.confirmation,
    REVIEW_RULE_CONFIRMATIONS,
    `${field}.confirmation`,
  );
  let bar: ReviewRuleProposal['bar'];
  if (proposal.bar === undefined) {
    if (kind === 'add' || kind === 'edit' || kind === 'merge')
      throw new Error(`${field}.bar is required for an ${kind}`);
  } else {
    const input = record(proposal.bar, `${field}.bar`);
    onlyKeys(input, ['recurrence', 'examined'], `${field}.bar`);
    const examined = input.examined;
    if (
      !Array.isArray(examined) ||
      examined.length === 0 ||
      examined.some((id) => typeof id !== 'string' || !ANCHOR.test(id))
    )
      throw new Error(`${field}.bar.examined must list the family ids checked for coverage`);
    bar = {
      recurrence: oneOf(input.recurrence, REVIEW_RULE_RECURRENCES, `${field}.bar.recurrence`),
      examined: examined as string[],
    };
  }
  if (typeof proposal.netRuleDelta !== 'number' || !Number.isInteger(proposal.netRuleDelta))
    throw new Error(`${field}.netRuleDelta must be an integer`);
  const decision = record(proposal.decision, `${field}.decision`);
  onlyKeys(decision, ['status', 'reason'], `${field}.decision`);
  const status = oneOf(decision.status, REVIEW_RULE_DECISIONS, `${field}.decision.status`);
  if (status !== 'pending' && decision.reason === undefined)
    throw new Error(`${field}.decision.reason is required once decided`);
  const reason =
    decision.reason === undefined
      ? undefined
      : oneLine(decision.reason, `${field}.decision.reason`);
  return {
    schemaVersion: 1,
    pack: proposal.pack,
    kind,
    ...(proposal.family !== undefined ? { family: proposal.family as string } : {}),
    ...(proposal.rule !== undefined ? { rule: text(proposal.rule, `${field}.rule`) } : {}),
    source,
    evidence,
    confirmation,
    ...(bar ? { bar } : {}),
    change: text(proposal.change, `${field}.change`),
    netRuleDelta: proposal.netRuleDelta,
    decision: reason === undefined ? { status } : { status, reason },
  };
}
