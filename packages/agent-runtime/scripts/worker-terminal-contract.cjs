/** @typedef {'complete' | 'no-change' | 'blocked'} WorkerTerminalCommand */

/**
 * @typedef {object} WorkerTerminalCommandSpec
 * @property {string} [report]
 * @property {string[]} artifacts
 */

/**
 * @typedef {object} WorkerTerminalWhenPresentRule
 * @property {string} path
 * @property {string[]} alsoRequire
 * @property {boolean} [requireRecipeQuality]
 * @property {boolean} [requireRecipeCoverage]
 */

/**
 * @typedef {object} WorkerTerminalProjectConfig
 * @property {boolean} [requireSignal]
 * @property {Partial<Record<WorkerTerminalCommand, WorkerTerminalCommandSpec>>} [complete]
 * @property {Partial<Record<WorkerTerminalCommand, WorkerTerminalCommandSpec>>} [no-change]
 * @property {Partial<Record<WorkerTerminalCommand, WorkerTerminalCommandSpec>>} [blocked]
 * @property {Record<string, Partial<Record<WorkerTerminalCommand, WorkerTerminalCommandSpec>>>} [flows]
 * @property {WorkerTerminalWhenPresentRule[]} [whenPresent]
 */

/**
 * @typedef {object} WorkerTerminalContractDocument
 * @property {1} schemaVersion
 * @property {string} flowType
 * @property {string} [mode]
 * @property {boolean} requireSignal
 * @property {Record<WorkerTerminalCommand, WorkerTerminalCommandSpec>} commands
 * @property {WorkerTerminalWhenPresentRule[]} whenPresent
 * @property {string} resolvedAt
 * @property {'builtin' | 'project'} source
 */

const TERMINAL_MARK_PATTERN =
  String.raw`(?:\.\/|\{\{TASK_DIR\}\}\/)mark\b(?:\s+--(?:checklist|signal)\s+\S+)*\s+` +
  String.raw`(complete|no-change|blocked)\b`;
const TERMINAL_MARK_RE = new RegExp(TERMINAL_MARK_PATTERN);
const TERMINAL_MARK_GLOBAL_RE = new RegExp(TERMINAL_MARK_PATTERN, 'g');
const TERMINAL_COMMANDS = /** @type {const} */ (['complete', 'no-change', 'blocked']);

const LEARNINGS = 'artifacts/learnings.md';

const PR_DESCRIPTION = 'artifacts/pr-description.md';

/** @type {Record<string, Record<WorkerTerminalCommand, WorkerTerminalCommandSpec>>} */
const BUILTIN_FLOW_COMMANDS = {
  dev: {
    complete: { report: PR_DESCRIPTION, artifacts: [LEARNINGS, PR_DESCRIPTION] },
    'no-change': {
      report: 'artifacts/no-change-report.md',
      artifacts: [LEARNINGS, 'artifacts/no-change-report.md'],
    },
    blocked: { artifacts: [] },
  },
  'fix-bug': {
    complete: { report: PR_DESCRIPTION, artifacts: [LEARNINGS, PR_DESCRIPTION] },
    'no-change': {
      report: 'artifacts/no-change-report.md',
      artifacts: [LEARNINGS, 'artifacts/no-change-report.md'],
    },
    blocked: { artifacts: [] },
  },
  'review-pr': {
    complete: {
      report: 'artifacts/review.md',
      artifacts: [LEARNINGS, 'artifacts/review.md', 'artifacts/line-comments.json'],
    },
    'no-change': {
      report: 'artifacts/no-change-report.md',
      artifacts: [LEARNINGS, 'artifacts/no-change-report.md'],
    },
    blocked: { artifacts: [] },
  },
  'pr-complete': {
    complete: {
      report: 'artifacts/comments-report.md',
      artifacts: [LEARNINGS, 'artifacts/comments-report.md'],
    },
    'no-change': {
      report: 'artifacts/no-change-report.md',
      artifacts: [LEARNINGS, 'artifacts/no-change-report.md'],
    },
    blocked: { artifacts: [] },
  },
  'update-branch': {
    complete: {
      report: 'artifacts/report.md',
      artifacts: [LEARNINGS, 'artifacts/report.md'],
    },
    'no-change': {
      report: 'artifacts/no-change-report.md',
      artifacts: [LEARNINGS, 'artifacts/no-change-report.md'],
    },
    blocked: { artifacts: [] },
  },
  'ci-fix': {
    complete: { report: 'artifacts/report.md', artifacts: [LEARNINGS, 'artifacts/report.md'] },
    'no-change': {
      report: 'artifacts/no-change-report.md',
      artifacts: [LEARNINGS, 'artifacts/no-change-report.md'],
    },
    blocked: { artifacts: [] },
  },
  // Reviewer flows produce feedback/report artifacts, not learnings.md — the
  // reviewer evaluates someone else's work, so the learnings requirement that
  // applies to contribution flows does not apply here (matches the templates
  // and the runtime FLOW_REPORT_ARTIFACTS mapping).
  'self-review': {
    complete: {
      report: 'artifacts/review-feedback.md',
      artifacts: ['artifacts/review-feedback.md'],
    },
    'no-change': {
      report: 'artifacts/review-feedback.md',
      artifacts: ['artifacts/review-feedback.md'],
    },
    blocked: { artifacts: [] },
  },
  'self-review-fix': {
    complete: { report: 'artifacts/report.md', artifacts: ['artifacts/report.md'] },
    'no-change': {
      report: 'artifacts/no-change-report.md',
      artifacts: ['artifacts/no-change-report.md'],
    },
    blocked: { artifacts: [] },
  },
  'validate-dep': {
    complete: { report: 'artifacts/report.md', artifacts: [LEARNINGS, 'artifacts/report.md'] },
    'no-change': {
      report: 'artifacts/no-change-report.md',
      artifacts: [LEARNINGS, 'artifacts/no-change-report.md'],
    },
    blocked: { artifacts: [] },
  },
};

const DEFAULT_WHEN_PRESENT = [
  {
    path: 'artifacts/recipe.json',
    alsoRequire: ['artifacts/recipe-coverage.md', 'artifacts/evidence-manifest.json'],
    requireRecipeQuality: true,
    requireRecipeCoverage: true,
  },
];

const DEFAULT_BLOCKED = { artifacts: [] };
const DEFAULT_NO_CHANGE = {
  report: 'artifacts/no-change-report.md',
  artifacts: [LEARNINGS, 'artifacts/no-change-report.md'],
};
const DEFAULT_COMPLETE = {
  report: 'artifacts/report.md',
  artifacts: [LEARNINGS, 'artifacts/report.md'],
};

/** @param {WorkerTerminalCommandSpec | undefined} spec */
function normalizeCommandSpec(spec) {
  if (!spec) return { artifacts: [] };
  const artifacts = [...new Set((spec.artifacts ?? []).filter(Boolean))];
  if (spec.report && !artifacts.includes(spec.report)) artifacts.unshift(spec.report);
  return {
    ...(spec.report ? { report: spec.report } : {}),
    artifacts,
  };
}

/** @param {Partial<Record<WorkerTerminalCommand, WorkerTerminalCommandSpec>> | undefined} layer */
function normalizeCommandLayer(layer) {
  /** @type {Record<WorkerTerminalCommand, WorkerTerminalCommandSpec>} */
  const out = {
    complete: normalizeCommandSpec(layer?.complete ?? DEFAULT_COMPLETE),
    'no-change': normalizeCommandSpec(layer?.['no-change'] ?? DEFAULT_NO_CHANGE),
    blocked: normalizeCommandSpec(layer?.blocked ?? DEFAULT_BLOCKED),
  };
  return out;
}

/**
 * @param {WorkerTerminalProjectConfig | null | undefined} projectConfig
 * @param {string} flowType
 * @param {{ mode?: string | null, now?: string }} [options]
 * @returns {WorkerTerminalContractDocument}
 */
function resolveWorkerTerminalContract(projectConfig, flowType, options = {}) {
  const mode = options.mode ?? undefined;
  const now = options.now ?? new Date().toISOString();
  const flowKey = String(flowType || '').trim() || 'unknown';

  const defaultsLayer = normalizeCommandLayer({
    complete: projectConfig?.complete,
    'no-change': projectConfig?.['no-change'],
    blocked: projectConfig?.blocked,
  });

  const builtin = BUILTIN_FLOW_COMMANDS[flowKey];
  const flowLayer = projectConfig?.flows?.[flowKey];
  /** @type {Record<WorkerTerminalCommand, WorkerTerminalCommandSpec>} */
  const commands = {
    complete: normalizeCommandSpec(
      flowLayer?.complete ?? builtin?.complete ?? defaultsLayer.complete,
    ),
    'no-change': normalizeCommandSpec(
      flowLayer?.['no-change'] ?? builtin?.['no-change'] ?? defaultsLayer['no-change'],
    ),
    blocked: normalizeCommandSpec(flowLayer?.blocked ?? builtin?.blocked ?? defaultsLayer.blocked),
  };

  let requireSignal = projectConfig?.requireSignal ?? true;
  if (flowKey === 'pr-complete' && mode === 'interactive') {
    requireSignal = false;
  }

  const whenPresent = Array.isArray(projectConfig?.whenPresent)
    ? projectConfig.whenPresent.map((rule) => ({
        path: rule.path,
        alsoRequire: [...(rule.alsoRequire ?? [])],
        ...(rule.requireRecipeQuality ? { requireRecipeQuality: true } : {}),
        ...(rule.requireRecipeCoverage ? { requireRecipeCoverage: true } : {}),
      }))
    : DEFAULT_WHEN_PRESENT.map((rule) => ({ ...rule, alsoRequire: [...rule.alsoRequire] }));

  return {
    schemaVersion: 1,
    flowType: flowKey,
    ...(mode ? { mode } : {}),
    requireSignal,
    commands,
    whenPresent,
    resolvedAt: now,
    source: projectConfig ? 'project' : 'builtin',
  };
}

/** @param {string} content */
function templateUsesTerminalMark(content) {
  return (
    TERMINAL_MARK_RE.test(content) ||
    /mark-checklist-step\.cjs[\s\S]{0,400}?\bcomplete\b/.test(content)
  );
}

/** @param {string} content */
function templateTerminalCommands(content) {
  let scope = content;
  const checklistIdx = content.indexOf('## Checklist');
  if (checklistIdx >= 0) {
    scope = content.slice(checklistIdx);
  } else {
    const completionIdx = content.indexOf('## Completion signal');
    if (completionIdx >= 0) scope = content.slice(completionIdx);
    else {
      const taskIdx = content.indexOf('## Task');
      if (taskIdx >= 0) scope = content.slice(taskIdx);
    }
  }
  const commands = new Set();
  for (const match of scope.matchAll(TERMINAL_MARK_GLOBAL_RE)) {
    commands.add(match[1]);
  }
  if (commands.size === 0 && /mark-checklist-step\.cjs[\s\S]{0,400}?\bcomplete\b/.test(scope)) {
    commands.add('complete');
  }
  return [...commands];
}

/**
 * @param {string} templateContent
 * @param {WorkerTerminalContractDocument} contract
 */
/** @param {string} content */
function templateBodyScope(content) {
  const checklistIdx = content.indexOf('## Checklist');
  if (checklistIdx >= 0) return content.slice(checklistIdx);
  const completionIdx = content.indexOf('## Completion signal');
  if (completionIdx >= 0) return content.slice(completionIdx);
  const taskIdx = content.indexOf('## Task');
  if (taskIdx >= 0) return content.slice(taskIdx);
  return content;
}

/**
 * Deterministic structure checks beyond terminal artifact contract.
 * @param {string} templateContent
 */
function lintWorkerTemplateStructure(templateContent) {
  /** @type {string[]} */
  const issues = [];
  if (/(?<!\{)\{TASK_DIR\}(?!\})/.test(templateContent)) {
    issues.push('uses `{TASK_DIR}` — must be `{{TASK_DIR}}` (double braces)');
  }

  if (
    templateUsesTerminalMark(templateContent) &&
    !templateContent.includes('## Checklist') &&
    !templateContent.includes('## Completion signal')
  ) {
    issues.push('terminal template missing `## Checklist` or `## Completion signal` section');
  }

  if (!templateContent.includes('## Task') && !templateContent.includes('TASK_DIR:')) {
    issues.push('missing `## Task` block or `TASK_DIR:` metadata');
  }

  const scope = templateBodyScope(templateContent);
  const steps = [...scope.matchAll(/\*\*(\d+)\./g)].map((match) => match[1]);
  const duplicateSteps = [...new Set(steps.filter((step, index) => steps.indexOf(step) !== index))];
  if (duplicateSteps.length > 0) {
    issues.push(`duplicate checklist step number(s): ${duplicateSteps.join(', ')}`);
  }

  return issues;
}

function lintWorkerTemplateAgainstContract(templateContent, contract) {
  /** @type {string[]} */
  const issues = [];
  if (!templateUsesTerminalMark(templateContent)) {
    // Omitting `./mark` entirely is only acceptable when the resolved contract
    // does not require a terminal signal (e.g. pr-complete interactive).
    if (contract.requireSignal) {
      issues.push(
        'requireSignal is true but template has no terminal `./mark` or mark-checklist-step command',
      );
    }
    return issues;
  }

  const commands = templateTerminalCommands(templateContent);
  const commandSet = new Set(commands.length > 0 ? commands : ['complete']);
  for (const command of commandSet) {
    const spec = contract.commands[/** @type {WorkerTerminalCommand} */ (command)];
    if (!spec) continue;
    for (const artifactPath of spec.artifacts) {
      if (!templateContent.includes(artifactPath)) {
        issues.push(
          `missing checklist/reference to required artifact \`${artifactPath}\` for \`${command}\``,
        );
      }
    }
  }

  return issues;
}

/**
 * @param {WorkerTerminalContractDocument} contract
 * @param {WorkerTerminalCommand} command
 * @param {(relPath: string) => boolean} fileExists
 */
function expandedArtifactsForCommand(contract, command, fileExists) {
  const spec = contract.commands[command] ?? { artifacts: [] };
  const required = new Set(spec.artifacts);
  for (const rule of contract.whenPresent ?? []) {
    if (!rule.path || !fileExists(rule.path)) continue;
    for (const path of rule.alsoRequire ?? []) required.add(path);
  }
  return {
    report: spec.report,
    artifacts: [...required],
    requireRecipeQuality: (contract.whenPresent ?? []).some(
      (rule) => rule.path && fileExists(rule.path) && rule.requireRecipeQuality,
    ),
    requireRecipeCoverage: (contract.whenPresent ?? []).some(
      (rule) => rule.path && fileExists(rule.path) && rule.requireRecipeCoverage,
    ),
  };
}

module.exports = {
  TERMINAL_COMMANDS,
  BUILTIN_FLOW_COMMANDS,
  resolveWorkerTerminalContract,
  lintWorkerTemplateAgainstContract,
  lintWorkerTemplateStructure,
  templateUsesTerminalMark,
  templateTerminalCommands,
  templateBodyScope,
  expandedArtifactsForCommand,
};
