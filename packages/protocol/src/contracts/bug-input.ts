// bug-input.ts — Pure parsing/validation for bug-input.json (ported from
// triage-bug.sh, score-bug.sh, download-github-images.sh, and
// download-jira-images.sh). No IO — callers own network and file operations.

export type BugInputSource = 'github' | 'jira';

export const BUG_SCORE_DIFFICULTIES = ['low', 'medium', 'high', 'extreme'] as const;
export type BugScoreDifficulty = (typeof BUG_SCORE_DIFFICULTIES)[number];

export interface BugInput {
  source: BugInputSource;
  /** "owner/repo#123" for GitHub issues, empty string for Jira */
  github_issue: string;
  /** Jira key (e.g. "PROJ-2236"), empty string for GitHub */
  jira_key: string;
  title: string;
  /** Flattened plain text of the issue description (ADF flattened for Jira) */
  description: string;
  acceptance_criteria: string[];
  /** Always empty — present for schema compatibility with existing tooling */
  affected_area: string;
  steps_to_reproduce: string[];
  labels: string[];
  components: string[];
  /** Image filenames (basename, ≤50 chars each) extracted from the description */
  screenshots: string[];
  state: string;
  linked_prs: string[];
  /** Full image URLs extracted from the description, for download scripts */
  image_urls: string[];
}

export interface BugScore {
  issue_ref?: string;
  difficulty: BugScoreDifficulty;
  one_shot_probability: number;
  category: string;
  [key: string]: unknown;
}

/**
 * Extract image URLs from a GitHub issue body (markdown / HTML / bare
 * GitHub user-content links). Shared helper for both GitHub markdown bodies
 * and Jira ADF descriptions that happen to contain inline HTML.
 *
 * Returns full URLs filtered to image-like extensions or GitHub content hosts.
 * Results are deduplicated and sorted for stable output.
 */
export function extractImageUrls(body: string): string[] {
  const urls = new Set<string>();

  // ![alt](url) markdown images
  for (const m of body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    urls.add(m[1]);
  }

  // <img src="url"> or <img src='url'>
  for (const m of body.matchAll(/<img[^>]+src=["']([^"'>]+)["']/g)) {
    urls.add(m[1]);
  }

  // Bare GitHub user-content URLs (user-images.githubusercontent.com and
  // github.com/user-attachments/assets paths used for drag-and-drop uploads)
  for (const m of body.matchAll(
    /(https:\/\/(?:user-images\.githubusercontent\.com|github\.com\/user-attachments\/assets)\/[^\s)"'>]+)/g,
  )) {
    urls.add(m[1]);
  }

  const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
  return [...urls].sort().filter((url) => {
    const lower = url.toLowerCase();
    const isImage = IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
    const isGhContent =
      lower.includes('githubusercontent.com') || lower.includes('github.com/user-attachments');
    return isImage || isGhContent;
  });
}

/**
 * Recursively flatten an Atlassian Document Format (ADF) node to plain text.
 * ADF is the JSON rich-text format used by Jira REST API v3 description fields.
 */
export function flattenAdf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flattenAdf).join(' ');
  if (node !== null && typeof node === 'object') {
    const n = node as Record<string, unknown>;
    if (n['type'] === 'text') return typeof n['text'] === 'string' ? n['text'] : '';
    if (Array.isArray(n['content'])) return n['content'].map(flattenAdf).join(' ');
  }
  return '';
}

/**
 * Derive the score-file key from a BugInput.
 *
 * GitHub issues become "gh-{number}" (e.g. "gh-12345").
 * Jira keys are lowercased (e.g. "proj-2236").
 */
export function deriveScoreKey(bug: BugInput): string {
  if (bug.github_issue) {
    const num = bug.github_issue.includes('#')
      ? bug.github_issue.split('#').pop()!
      : bug.github_issue;
    return `gh-${num}`;
  }
  if (bug.jira_key) {
    return bug.jira_key.toLowerCase();
  }
  throw new Error('BugInput has neither github_issue nor jira_key — cannot derive score key');
}

/**
 * Parse a raw GitHub issue JSON response (from `gh issue view --json
 * title,body,labels,state,url`) into a BugInput.
 *
 * Extracts: AC sections, reproduction steps, screenshot basenames,
 * image URLs, and linked PR references from the issue body.
 * Derives repo+number from the `url` field.
 */
export function parseBugInput(source: 'github' | 'jira', raw: unknown): BugInput {
  if (source === 'github') return parseGitHubIssue(raw);
  return parseJiraIssue(raw);
}

// ── Private helpers ──────────────────────────────────────────────────────────

function parseGitHubIssue(raw: unknown): BugInput {
  const gh = (raw ?? {}) as Record<string, unknown>;

  const url = typeof gh['url'] === 'string' ? gh['url'] : '';
  const urlMatch = url.match(/https?:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/);
  if (!urlMatch) {
    throw Object.assign(new Error(`Cannot parse GitHub issue URL from raw JSON: "${url}"`), {
      code: 'PARSE_ERROR',
      userAction:
        'Ensure the raw JSON comes from `gh issue view --json title,body,labels,state,url`.',
    });
  }
  const repo = urlMatch[1];
  const number = urlMatch[2];

  const body = typeof gh['body'] === 'string' ? gh['body'] : '';
  const title = typeof gh['title'] === 'string' ? gh['title'] : '';
  const state = typeof gh['state'] === 'string' ? gh['state'].toLowerCase() : 'open';

  const labels = parseLabels(gh['labels']);

  const ac = parseMarkdownSection(
    body,
    /##\s*(?:Acceptance Criteria|Expected Behavior)\s*\n([\s\S]*?)(?=\n##|$)/,
  );
  const steps = parseMarkdownSection(
    body,
    /##\s*(?:Steps to Reproduce|Repro Steps)\s*\n([\s\S]*?)(?=\n##|$)/,
    true,
  );

  // Screenshots: basenames (≤50 chars) from markdown images and <img> tags,
  // matching the shape triage-bug.sh's Python produced.
  const screenshotUrls: string[] = [];
  for (const m of body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    screenshotUrls.push(m[1]);
  }
  for (const m of body.matchAll(/<img[^>]+src=["']([^"'>]+)["']/g)) {
    screenshotUrls.push(m[1]);
  }
  const screenshots = screenshotUrls.map((u) => {
    const basename = u.split('/').pop() ?? u;
    return basename.slice(0, 50);
  });

  // Linked PRs: #N or repo#N in body, excluding the current issue number.
  const escapedRepo = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linkPattern = new RegExp(`(?:${escapedRepo})?#(\\d+)`, 'g');
  const linkedPrSet = new Set<string>();
  for (const m of body.matchAll(linkPattern)) {
    if (m[1] !== number) linkedPrSet.add(`${repo}#${m[1]}`);
  }
  const linked_prs = [...linkedPrSet];

  const image_urls = extractImageUrls(body);

  return {
    source: 'github',
    github_issue: `${repo}#${number}`,
    jira_key: '',
    title,
    description: body,
    acceptance_criteria: ac,
    affected_area: '',
    steps_to_reproduce: steps,
    labels,
    components: [],
    screenshots,
    state,
    linked_prs,
    image_urls,
  };
}

function parseJiraIssue(raw: unknown): BugInput {
  const jira = (raw ?? {}) as Record<string, unknown>;

  if ('errorMessages' in jira) {
    const msgs = jira['errorMessages'];
    throw Object.assign(new Error(`Jira API error: ${JSON.stringify(msgs)}`), {
      code: 'JIRA_API_ERROR',
      userAction: 'Check JIRA_EMAIL, JIRA_TOKEN, and the Jira base URL in project.json.',
    });
  }

  const key = typeof jira['key'] === 'string' ? jira['key'] : '';
  const fields = (jira['fields'] ?? {}) as Record<string, unknown>;

  const title = typeof fields['summary'] === 'string' ? fields['summary'] : '';

  // Description: ADF object → flatten to text, or plain string fallback.
  const descRaw = fields['description'];
  const body =
    typeof descRaw === 'object' && descRaw !== null
      ? flattenAdf(descRaw)
      : typeof descRaw === 'string'
        ? descRaw
        : '';

  const state = (() => {
    const s = fields['status'];
    if (s !== null && typeof s === 'object') {
      const name = (s as Record<string, unknown>)['name'];
      return typeof name === 'string' ? name.toLowerCase() : 'open';
    }
    return typeof s === 'string' ? s.toLowerCase() : 'open';
  })();

  const rawLabels: unknown = fields['labels'];
  const labels = Array.isArray(rawLabels)
    ? rawLabels.filter((l): l is string => typeof l === 'string')
    : [];

  const components = (() => {
    const raw = fields['components'];
    if (!Array.isArray(raw)) return [];
    return raw
      .map((c: unknown) => {
        if (c !== null && typeof c === 'object') {
          const name = (c as Record<string, unknown>)['name'];
          return typeof name === 'string' ? name : '';
        }
        return typeof c === 'string' ? c : '';
      })
      .filter(Boolean);
  })();

  const ac = parseJiraSection(
    body,
    /(?:Acceptance Criteria|Expected Behavior)[:\s]*\n([\s\S]*?)(?=\n[A-Z]|$)/,
  );
  const steps = parseJiraSection(
    body,
    /(?:Steps to Reproduce|Repro Steps)[:\s]*\n([\s\S]*?)(?=\n[A-Z]|$)/,
    true,
  );

  // Jira attachments are downloaded separately via the attachment API;
  // image_urls from the description text is available for embedded images.
  const image_urls = extractImageUrls(body);

  return {
    source: 'jira',
    github_issue: '',
    jira_key: key,
    title,
    description: body,
    acceptance_criteria: ac,
    affected_area: '',
    steps_to_reproduce: steps,
    labels,
    components,
    screenshots: [],
    state,
    linked_prs: [],
    image_urls,
  };
}

/**
 * Parse a markdown `## Section` into trimmed non-empty lines.
 * When `isSteps` is true, also strips leading ordered-list markers (e.g. "1. ")
 * matching the Python `re.sub(r'^[\s\d.*-]+', '', line)` used for steps sections.
 * For other sections (e.g. AC), only list bullets (`*`, `-`) and whitespace are stripped.
 */
function parseMarkdownSection(body: string, pattern: RegExp, isSteps = false): string[] {
  const match = body.match(pattern);
  if (!match?.[1]) return [];
  const stripPattern = isSteps ? /^[\s\d.*-]+/ : /^[\s*-]+/;
  return match[1]
    .trim()
    .split('\n')
    .map((line) => line.replace(stripPattern, '').trim())
    .filter(Boolean);
}

/** Parse a Jira section header (no `##` prefix) into trimmed non-empty lines. */
function parseJiraSection(body: string, pattern: RegExp, isSteps = false): string[] {
  const match = body.match(pattern);
  if (!match?.[1]) return [];
  const stripPattern = isSteps ? /^[\s\d.*-]+/ : /^[\s*-]+/;
  return match[1]
    .trim()
    .split('\n')
    .map((line) => line.replace(stripPattern, '').trim())
    .filter(Boolean);
}

function parseLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l: unknown) => {
      if (l !== null && typeof l === 'object') {
        const name = (l as Record<string, unknown>)['name'];
        return typeof name === 'string' ? name : '';
      }
      return typeof l === 'string' ? l : '';
    })
    .filter(Boolean);
}

/**
 * Validate a scorer output object against the score-bug.sh contract.
 * Throws with a teaching error message on any violation.
 * On success, the value is narrowed to BugScore.
 */
export function validateBugScore(value: unknown): asserts value is BugScore {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('scorer output must be a JSON object'), {
      code: 'INVALID_SCORE',
      userAction: 'Ensure the scoring script emits a JSON object to stdout.',
    });
  }
  const d = value as Record<string, unknown>;

  const required = ['difficulty', 'one_shot_probability', 'category'];
  const missing = required.filter((f) => !(f in d));
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`scorer output is missing required fields: ${JSON.stringify(missing)}`),
      {
        code: 'INVALID_SCORE',
        userAction: `Add the missing fields to your scoring script output: ${missing.join(', ')}.`,
      },
    );
  }

  if (!BUG_SCORE_DIFFICULTIES.includes(d['difficulty'] as BugScoreDifficulty)) {
    throw Object.assign(
      new Error(
        `difficulty must be one of ${JSON.stringify([...BUG_SCORE_DIFFICULTIES])}, got: ${JSON.stringify(d['difficulty'])}`,
      ),
      {
        code: 'INVALID_SCORE',
        userAction: `Set difficulty to one of: ${BUG_SCORE_DIFFICULTIES.join(', ')}.`,
      },
    );
  }

  const prob = d['one_shot_probability'];
  if (typeof prob !== 'number' || isNaN(prob) || prob < 0 || prob > 1) {
    throw Object.assign(
      new Error(`one_shot_probability must be a number in [0, 1], got: ${JSON.stringify(prob)}`),
      {
        code: 'INVALID_SCORE',
        userAction: 'Set one_shot_probability to a decimal between 0 and 1 (e.g. 0.4).',
      },
    );
  }
}
