/**
 * Learnings v1 (ADR-026 Amendment 4): the one checked format for a run's
 * `artifacts/learnings.md`, and the rules that decide what a lesson may become.
 *
 * A file opts in with its first line, `# Learnings v1`; any other file is
 * legacy free text and is read as before. The terminal artifact contract warns
 * on a v1 file's issues at the mark step and never fails a finished run.
 *
 * ```md
 * # Learnings v1
 *
 * - edit: A price hook returned '$---' and a validator read it as a price.
 *   evidence: metamask-mobile app/components/UI/Perps/hooks/usePerpsLiquidationPrice.ts:102
 *   family: antipatterns.md#missing-numeric-data-stays-undefined
 *   confirmation: run 0f3c2a1b artifacts/review-ledger.md:40
 * ```
 *
 * See docs/adr/026-self-improvement-recursive-loop.md (Amendment 4) and
 * docs/reference/learning-curation.md.
 */

export const LEARNINGS_V1_HEADER = '# Learnings v1';

/** `add`, `edit` and `retire` are review rule proposal kinds; the rest route elsewhere. */
export const LEARNING_KINDS = [
  'add',
  'edit',
  'retire',
  'recipe-broken',
  'recipe-missing',
  'workflow',
] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];
export type LearningRuleKind = Extract<LearningKind, 'add' | 'edit' | 'retire'>;

const LEARNING_FIELDS = [
  'evidence',
  'family',
  'examined',
  'confirmation',
  'recipe',
  'failed',
  'criterion',
  'searched',
] as const;
type LearningField = (typeof LEARNING_FIELDS)[number];

/** The fields each kind requires; no other field belongs to it. */
export const LEARNING_KIND_FIELDS: Record<LearningKind, readonly LearningField[]> = {
  add: ['evidence', 'examined', 'confirmation'],
  edit: ['evidence', 'family', 'confirmation'],
  retire: ['evidence', 'family', 'confirmation'],
  'recipe-broken': ['recipe', 'failed'],
  'recipe-missing': ['criterion', 'searched'],
  workflow: [],
};

/** A rules file section: `antipatterns.md#missing-numeric-data-stays-undefined`. */
export interface LearningFamilyRef {
  file: string;
  anchor: string;
}
/** `<repo> <path>:<line>` or `<repo> <path>:<start>-<end>`. */
export interface LearningEvidenceRef {
  repo: string;
  path: string;
  line: number;
  end?: number;
}
/** `none`, `run <id> <path>[:<line>]` or `fix <owner/repo#n>`. */
export type LearningConfirmationRef =
  | { kind: 'none' }
  | { kind: 'run'; runId: string; path: string; line?: number }
  | { kind: 'fix'; ref: string };

export interface LearningV1Entry {
  kind: LearningKind;
  /** The one-line lesson after `- <kind>: `. */
  text: string;
  /** 1-based line of the entry's bullet. */
  line: number;
  /** The entry's lines as written, bullet and fields. */
  source: string;
  evidence?: LearningEvidenceRef[];
  family?: LearningFamilyRef;
  examined?: LearningFamilyRef[];
  confirmation?: LearningConfirmationRef;
  /** `<recipe file>#<node id>`. */
  recipe?: { file: string; node: string };
  /** The failed attempt's artifact, `artifacts/<path>[:<line>]`. */
  failed?: string;
  criterion?: string;
  searched?: string;
  /** Problems with this entry, each `line N: ...`. */
  issues: string[];
}

export type ParsedLearnings =
  | { version: 'legacy' }
  | {
      version: 1;
      /** The file says `- None`: nothing to report. */
      none: boolean;
      entries: LearningV1Entry[];
      /** Every problem in the file, entries' included, each `line N: ...`. */
      issues: string[];
    };

/** The format as a worker is asked to write it; the mark step prints it beside any issue. */
export const LEARNINGS_V1_FORMAT = `# Learnings v1

- None                      (when there is nothing to report), or one entry per lesson:

- <kind>: <one-line lesson>
  <field>: <value>          (two-space indent, one line per field)

add      evidence, examined, confirmation   a check no rule covers
edit     evidence, family, confirmation     a rule that missed or misfired
retire   evidence, family, confirmation     a rule that should go
recipe-broken   recipe, failed              a recipe defect, not a product defect
recipe-missing  criterion, searched         a criterion no recipe covers
workflow        (no fields)                 templates, tools, setup

evidence      <repo> <path>:<line>[, ...]
family        <rules file>.md#<section anchor>
examined      <rules file>.md#<section anchor>[, ...]   the families checked for coverage
confirmation  run <other run id> <path>[:<line>] | fix <owner/repo#n> | none
recipe        <recipe file>#<node id>
failed        artifacts/<path>[:<line>]
criterion, searched   one line each

A confirmation counts only when it points outside this run: another run's record, or a
merged PR other than this run's. Your own report or review is none.`;

const KIND = new Set<string>(LEARNING_KINDS);
const FIELD = new Set<string>(LEARNING_FIELDS);
const ANCHOR = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FAMILY = /^([\w.-]+\.md)#(\S+)$/;
const EVIDENCE = /^([\w.-]+) ([^\s:]+):([1-9]\d*)(?:-([1-9]\d*))?$/;
const RUN = /^run ([\w-]{8,}) ([^\s:]+)(?::([1-9]\d*))?$/;
const FIX = /^fix ([\w.-]+\/[\w.-]+#[1-9]\d*)$/;
const RECIPE = /^([^\s#]+)#([\w.-]+)$/;
const ARTIFACT = /^artifacts\/[^\s:]+(?::[1-9]\d*)?$/;

function family(value: string): LearningFamilyRef | undefined {
  const match = FAMILY.exec(value);
  // `data-flow--state` (a GitHub heading link) and `data-flow-state` name one section.
  const anchor = match ? learningSectionAnchor(match[2]!) : '';
  return match && ANCHOR.test(anchor) ? { file: match[1]!, anchor } : undefined;
}
const list = (value: string) => value.split(/,\s*/);

/** Reads one field value into the entry, or returns what is wrong with it. */
function readField(entry: LearningV1Entry, name: LearningField, value: string): string | undefined {
  switch (name) {
    case 'evidence': {
      const refs = list(value).map((item) => {
        const match = EVIDENCE.exec(item);
        if (!match || (match[4] && Number(match[4]) < Number(match[3]))) return undefined;
        return {
          repo: match[1]!,
          path: match[2]!,
          line: Number(match[3]),
          ...(match[4] ? { end: Number(match[4]) } : {}),
        };
      });
      if (refs.some((ref) => !ref))
        return 'evidence must be "<repo> <path>:<line>", comma-separated';
      entry.evidence = refs as LearningEvidenceRef[];
      return;
    }
    case 'family': {
      const ref = family(value);
      if (!ref) return 'family must be "<rules file>.md#<section anchor>"';
      entry.family = ref;
      return;
    }
    case 'examined': {
      const refs = list(value).map(family);
      if (refs.some((ref) => !ref))
        return 'examined must list "<rules file>.md#<section anchor>", comma-separated';
      entry.examined = refs as LearningFamilyRef[];
      return;
    }
    case 'confirmation': {
      if (value === 'none') entry.confirmation = { kind: 'none' };
      else if (RUN.test(value)) {
        const [, runId, path, line] = RUN.exec(value)!;
        entry.confirmation = {
          kind: 'run',
          runId: runId!,
          path: path!,
          ...(line ? { line: Number(line) } : {}),
        };
      } else if (FIX.test(value)) entry.confirmation = { kind: 'fix', ref: FIX.exec(value)![1]! };
      else return 'confirmation must be "run <id> <path>[:<line>]", "fix <owner/repo#n>" or "none"';
      return;
    }
    case 'recipe': {
      const match = RECIPE.exec(value);
      if (!match) return 'recipe must be "<recipe file>#<node id>"';
      entry.recipe = { file: match[1]!, node: match[2]! };
      return;
    }
    case 'failed':
      if (!ARTIFACT.test(value)) return 'failed must be "artifacts/<path>[:<line>]"';
      entry.failed = value;
      return;
    case 'criterion':
    case 'searched':
      entry[name] = value;
      return;
  }
}

/**
 * Parses a learnings file. A file whose first non-blank line is not
 * `# Learnings v1` is legacy and is not judged.
 */
export function parseLearnings(text: string): ParsedLearnings {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((line) => line.trim());
  if (first === -1 || lines[first]!.trim() !== LEARNINGS_V1_HEADER) return { version: 'legacy' };
  const issues: string[] = [];
  const entries: (LearningV1Entry & { seen: Set<string>; lines: string[] })[] = [];
  let none = 0;
  let current: (typeof entries)[number] | undefined;
  for (let index = first + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const at = `line ${index + 1}`;
    if (!line.trim()) continue;
    if (/^- None\.?$/i.test(line.trim())) {
      none += 1;
      current = undefined;
      continue;
    }
    const bullet = /^- ([a-z-]+): (\S.*)$/.exec(line);
    if (bullet) {
      current = {
        kind: bullet[1] as LearningKind,
        text: bullet[2]!.trim(),
        line: index + 1,
        source: '',
        issues: [],
        seen: new Set(),
        lines: [line],
      };
      if (!KIND.has(bullet[1]!))
        current.issues.push(`${at}: unknown kind "${bullet[1]}"; use ${LEARNING_KINDS.join(', ')}`);
      entries.push(current);
      continue;
    }
    const field = /^ {2}([a-z]+): (\S.*)$/.exec(line);
    if (!current || !field) {
      issues.push(
        `${at}: expected "- <kind>: <lesson>", an indented "<field>: <value>" or "- None"`,
      );
      current = undefined;
      continue;
    }
    current.lines.push(line);
    const name = field[1]!;
    const value = field[2]!;
    if (!FIELD.has(name)) current.issues.push(`${at}: unknown field "${name}"`);
    else if (current.seen.has(name)) current.issues.push(`${at}: duplicate field "${name}"`);
    else if (
      KIND.has(current.kind) &&
      !LEARNING_KIND_FIELDS[current.kind].includes(name as LearningField)
    )
      current.issues.push(`${at}: ${name} does not belong to a ${current.kind} entry`);
    else {
      current.seen.add(name);
      const problem = readField(current, name as LearningField, value.trim());
      if (problem) current.issues.push(`${at}: ${problem}`);
    }
  }
  const parsed = entries.map(({ seen, lines: entryLines, ...entry }) => {
    if (KIND.has(entry.kind))
      for (const name of LEARNING_KIND_FIELDS[entry.kind])
        if (!seen.has(name)) entry.issues.push(`line ${entry.line}: ${entry.kind} needs ${name}`);
    return { ...entry, source: entryLines.join('\n') };
  });
  for (const entry of parsed) issues.push(...entry.issues);
  if (none && parsed.length) issues.push('"- None" stands alone; remove it or the entries');
  if (!none && !parsed.length)
    issues.push('no entries; write "- None" when there is nothing to report');
  issues.sort((a, b) => Number(/\d+/.exec(a)?.[0] ?? 0) - Number(/\d+/.exec(b)?.[0] ?? 0));
  return { version: 1, none: none > 0, entries: parsed, issues };
}

export const isLearningRuleKind = (kind: LearningKind): kind is LearningRuleKind =>
  kind === 'add' || kind === 'edit' || kind === 'retire';

/**
 * A run never confirms its own lesson (Amendment 4, rule 4). A confirmation is
 * outside when it names another run, or a PR that is not the run's own. `own`
 * names the run's PRs as `owner/repo#n`, or `#n` when the repository is not
 * recorded, which then matches that number in any repository.
 */
export function learningConfirmationIsOutside(
  confirmation: LearningConfirmationRef | undefined,
  own: { runId: string; prs?: readonly string[] },
): boolean {
  if (!confirmation || confirmation.kind === 'none') return false;
  if (confirmation.kind === 'run') return !own.runId.startsWith(confirmation.runId);
  const ref = confirmation.ref.toLowerCase();
  return !(own.prs ?? []).some((pr) =>
    pr.startsWith('#') ? ref.endsWith(pr) : ref === pr.toLowerCase(),
  );
}

/** One review row of a run: a rule family's recorded outcome. */
export interface LearningRuleResult {
  runId: string;
  /** The family's section anchor. */
  family: string;
  outcome: 'PASS' | 'FINDING';
}

export type LearningKindDecision =
  /** The cited rule recorded a FINDING: it worked, so nothing is proposed. */
  | { kind: 'none'; reason: string }
  | { kind: LearningKind; basis: 'results' | 'claim'; reason: string };

/**
 * The agent's kind is a claim; run results decide (Amendment 4, rule 3). For
 * the rule kinds, the review rows of the lesson's run decide: a cited family
 * that recorded a FINDING worked, and one that recorded PASS while the problem
 * was confirmed elsewhere needs an edit. Without a row the claim stands. The
 * recipe kinds are decided by the recipe library's owner.
 */
export function decideLearningKind(
  entry: Pick<LearningV1Entry, 'kind' | 'family'>,
  results: readonly LearningRuleResult[],
): LearningKindDecision {
  if (!isLearningRuleKind(entry.kind) || entry.kind === 'add' || !entry.family)
    return { kind: entry.kind, basis: 'claim', reason: 'No run result decides this kind' };
  const ref = `${entry.family.file}#${entry.family.anchor}`;
  const rows = results.filter((row) => row.family === entry.family!.anchor);
  const finding = rows.find((row) => row.outcome === 'FINDING');
  if (finding)
    return {
      kind: 'none',
      reason: `${ref} recorded a FINDING in run ${finding.runId}: the rule worked`,
    };
  const pass = rows.find((row) => row.outcome === 'PASS');
  if (pass)
    return {
      kind: 'edit',
      basis: 'results',
      reason: `${ref} recorded PASS in run ${pass.runId} while the problem was confirmed elsewhere`,
    };
  return { kind: entry.kind, basis: 'claim', reason: `No review row records ${ref}` };
}

/** A section anchor as rules files derive it from a `## ` heading. */
export function learningSectionAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
