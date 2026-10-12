const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  enumerateChecklistCheckboxes,
  terminalContractInputForChecklist,
  resolveChecklistTarget,
} = require('./checklist-target.cjs');
const { atomicWrite } = require('./mark-io.cjs');

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
 * Acceptance-ledger rules for a terminal mark (ADR-060). `require` is the opt-in
 * that makes a missing or incomplete ledger block `complete`; it defaults to
 * false so a project whose templates do not write one yet is unaffected.
 * `allowWeak` lets a flow finish with `weak` or `missing` verdicts.
 * @typedef {object} WorkerTerminalAcceptanceRules
 * @property {boolean} [require]
 * @property {boolean} [allowWeak]
 */

/**
 * @typedef {object} WorkerTerminalProjectConfig
 * @property {boolean} [requireSignal]
 * @property {WorkerTerminalAcceptanceRules} [acceptance]
 * @property {Partial<Record<WorkerTerminalCommand, WorkerTerminalCommandSpec>>} [complete]
 * @property {Partial<Record<WorkerTerminalCommand, WorkerTerminalCommandSpec>>} [no-change]
 * @property {Partial<Record<WorkerTerminalCommand, WorkerTerminalCommandSpec>>} [blocked]
 * @property {Record<string, Partial<Record<WorkerTerminalCommand, WorkerTerminalCommandSpec>> & {acceptance?: WorkerTerminalAcceptanceRules}>} [flows]
 * @property {WorkerTerminalWhenPresentRule[]} [whenPresent]
 */

/**
 * @typedef {object} WorkerTerminalContractDocument
 * @property {1} schemaVersion
 * @property {string} flowType
 * @property {string} [mode]
 * @property {boolean} requireSignal
 * @property {WorkerTerminalAcceptanceRules} [acceptance]
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
  review: {
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
  'review-fix': {
    complete: { report: 'artifacts/report.md', artifacts: ['artifacts/report.md'] },
    'no-change': {
      report: 'artifacts/no-change-report.md',
      artifacts: ['artifacts/no-change-report.md'],
    },
    blocked: { artifacts: [] },
  },
  qa: {
    complete: { report: 'artifacts/report.html', artifacts: [LEARNINGS, 'artifacts/report.html'] },
    'no-change': {
      report: 'artifacts/report.html',
      artifacts: [LEARNINGS, 'artifacts/report.html'],
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

  const acceptanceRules =
    projectConfig?.acceptance || flowLayer?.acceptance
      ? { ...projectConfig?.acceptance, ...flowLayer?.acceptance }
      : undefined;
  const acceptance = acceptanceRules
    ? {
        ...(acceptanceRules.require ? { require: true } : {}),
        ...(acceptanceRules.allowWeak ? { allowWeak: true } : {}),
      }
    : null;

  return {
    schemaVersion: 1,
    flowType: flowKey,
    ...(mode ? { mode } : {}),
    requireSignal,
    ...(acceptance && Object.keys(acceptance).length > 0 ? { acceptance } : {}),
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
 * @param {{ roleChecklist?: boolean }} [options] roleChecklist: a nested-loop role
 *   checklist (review, review-fix, ci-fix) rendered beside an existing
 *   task dir; it may keep its own `## Task` block.
 */
function lintWorkerTemplateStructure(templateContent, options = {}) {
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

  // The task writer generates TASK.md (ticket block, description, acceptance
  // criteria) and renders the flow template into CHECKLIST.md. A flow template
  // that still carries the old `## Task` header duplicates that block inside
  // the checklist.
  if (
    !options.roleChecklist &&
    (/^## Task\s*$/m.test(templateContent) || /^TASK_DIR:\s/m.test(templateContent))
  ) {
    issues.push(
      'carries a `## Task` block or `TASK_DIR:` line — the task writer generates TASK.md; keep only the checklist',
    );
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
      const reviewerFeedbackBinding =
        artifactPath === 'artifacts/review-feedback.md' &&
        templateContent.includes('{{REVIEW_FEEDBACK}}');
      if (!templateContent.includes(artifactPath) && !reviewerFeedbackBinding) {
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

const DETERMINISTIC_REFERENCE = /\[DETERMINISTIC:\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\]/;

function deterministicDeclarations(markdown, checklist) {
  return enumerateChecklistCheckboxes(markdown).flatMap((item) => {
    const match = item.rawLabel.match(DETERMINISTIC_REFERENCE);
    if (!match && item.rawLabel.includes('[DETERMINISTIC')) {
      throw new Error(`Invalid deterministic declaration in ${checklist} step ${item.stepNumber}`);
    }
    return match ? [{ checklist, stepNumber: item.stepNumber, reference: match[1] }] : [];
  });
}

function freezeDeterministicChecks(contract, markdown, checklist, commands = {}) {
  const steps = deterministicDeclarations(markdown, checklist).map((step) => {
    const command = commands[step.reference]?.trim();
    if (!command)
      throw new Error(
        `Deterministic step ${step.stepNumber}: ${step.reference} requires a configured command`,
      );
    return { ...step, command };
  });
  return steps.length ? { ...contract, deterministicChecks: steps } : contract;
}

function readOptionalJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function deterministicContract(taskDir, checklist) {
  return (
    readOptionalJson(path.join(taskDir, terminalContractInputForChecklist(checklist))) ??
    readOptionalJson(path.join(taskDir, 'inputs', 'worker-terminal-contract.json')) ??
    {}
  );
}

function recordedDeterministicSteps(taskDir, checklist) {
  const contract = deterministicContract(taskDir, checklist);
  const frozen = (contract.deterministicChecks ?? []).filter(
    (step) => step.checklist === checklist,
  );
  const file = path.join(taskDir, checklist);
  const actual = fs.existsSync(file)
    ? deterministicDeclarations(fs.readFileSync(file, 'utf8'), checklist)
    : [];
  const steps = [...frozen];
  for (const step of actual) {
    if (
      !steps.some(
        (candidate) =>
          candidate.stepNumber === step.stepNumber && candidate.reference === step.reference,
      )
    ) {
      steps.push({ ...step, command: null });
    }
  }
  return steps;
}

function deterministicCheckout(taskDir) {
  for (const cwd of [taskDir, process.cwd()]) {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim()) return fs.realpathSync(result.stdout.trim());
  }
  throw new Error(
    'Deterministic checks require a Git checkout. Invoke mark from the target checkout.',
  );
}

function deterministicInputHash(checkout, taskDir) {
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: checkout,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw new Error('Cannot enumerate publishable inputs for deterministic checks');
  const indexed = spawnSync('git', ['ls-files', '--stage', '-z'], {
    cwd: checkout,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (indexed.status !== 0)
    throw new Error('Cannot enumerate tracked submodules for deterministic checks');
  const gitlinks = new Map();
  for (const entry of indexed.stdout.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, commit, stage] = entry.slice(0, tab).split(' ');
    if (mode !== '160000') continue;
    const name = entry.slice(tab + 1);
    if (stage !== '0') throw new Error(`Resolve submodule conflict ${name} before CI parity`);
    gitlinks.set(name, commit);
  }
  const hash = createHash('sha256');
  const task = fs.realpathSync(taskDir);
  for (const name of [...new Set(result.stdout.split('\0').filter(Boolean))].sort()) {
    const file = path.join(checkout, name);
    if (file === task || file.startsWith(task + path.sep)) continue;
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (gitlinks.has(name)) {
      let commit = gitlinks.get(name);
      if (stat) {
        if (!stat.isDirectory()) throw new Error(`Tracked submodule ${name} is not a directory`);
        const top = spawnSync('git', ['-C', file, 'rev-parse', '--show-toplevel'], {
          encoding: 'utf8',
        });
        if (top.status !== 0) throw new Error(`Cannot inspect tracked submodule ${name}`);
        // Uninitialized submodule directories resolve to the parent checkout.
        if (fs.realpathSync(top.stdout.trim()) === fs.realpathSync(file)) {
          const head = spawnSync('git', ['-C', file, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
          const dirty = spawnSync(
            'git',
            [
              '-C',
              file,
              'status',
              '--porcelain=v1',
              '--untracked-files=all',
              '--ignore-submodules=none',
            ],
            { encoding: 'utf8' },
          );
          if (head.status !== 0 || dirty.status !== 0)
            throw new Error(`Cannot fingerprint tracked submodule ${name}`);
          if (dirty.stdout.trim())
            throw new Error(
              `Submodule ${name} has uncommitted work; commit its changes, then rerun CI parity`,
            );
          commit = head.stdout.trim();
        }
      }
      hash.update(name + '\0gitlink\0' + commit + '\0');
      continue;
    }
    if (!stat) continue;
    hash.update(name + '\0');
    hash.update(String(stat.mode & 0o777) + '\0');
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(file));
    else if (stat.isFile()) hash.update(fs.readFileSync(file));
    else throw new Error(`Cannot fingerprint publishable input ${name}`);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function deterministicReceiptPath(taskDir, step) {
  return path.join(
    taskDir,
    'artifacts',
    'deterministic-checks',
    step.checklist,
    `${step.stepNumber}.json`,
  );
}

function logHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function executeDeterministicStep(taskDir, checklist, stepNumber) {
  const step = recordedDeterministicSteps(taskDir, checklist).find(
    (item) => item.stepNumber === stepNumber,
  );
  if (!step) return;
  if (!step.command)
    throw new Error(
      `Deterministic step ${stepNumber}: ${step.reference} has no frozen command; initialize the task again`,
    );
  const checkout = deterministicCheckout(taskDir);
  const inputHash = deterministicInputHash(checkout, taskDir);
  const logPath = path.posix.join(
    'artifacts',
    'deterministic-checks',
    checklist,
    `${stepNumber}-${randomUUID()}.log`,
  );
  const logFile = path.join(taskDir, logPath);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const receiptFile = deterministicReceiptPath(taskDir, step);
  const receipt = {
    schemaVersion: 1,
    ...step,
    inputHash,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    exitCode: null,
    logPath,
  };
  atomicWrite(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
  const fd = fs.openSync(logFile, 'wx', 0o644);
  let result;
  try {
    result = spawnSync('bash', ['-c', step.command], { cwd: checkout, stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  const afterHash = deterministicInputHash(checkout, taskDir);
  const passed = result.status === 0 && inputHash === afterHash;
  const completed = {
    ...receipt,
    finishedAt: new Date().toISOString(),
    status: result.signal ? 'interrupted' : passed ? 'passed' : 'failed',
    exitCode: result.status,
    signal: result.signal ?? null,
    logHash: logHash(logFile),
  };
  atomicWrite(receiptFile, JSON.stringify(completed, null, 2) + '\n');
  if (!passed)
    throw new Error(
      `Deterministic step ${stepNumber} failed${inputHash !== afterHash ? ': command changed publishable inputs' : ` with exit ${result.status ?? result.signal ?? 'unknown'}`}. See ${logPath}`,
    );
  console.log(`Deterministic step ${stepNumber} passed, exit 0. Log: ${logPath}`);
}

function readDeterministicChecks(taskDir, checklist, options = {}) {
  if (checklist === undefined) {
    const target = resolveChecklistTarget(taskDir).checklist;
    const contract = deterministicContract(taskDir, target);
    const sources = [
      ...new Set([target, ...(contract.deterministicChecks ?? []).map((step) => step.checklist)]),
    ];
    const hasSteps = sources.some(
      (source) => recordedDeterministicSteps(taskDir, source).length > 0,
    );
    if (!hasSteps) return [];
    const inputHash =
      options.inputHash ?? deterministicInputHash(deterministicCheckout(taskDir), taskDir);
    return sources.flatMap((source) => readDeterministicChecks(taskDir, source, { inputHash }));
  }
  const steps = recordedDeterministicSteps(taskDir, checklist);
  if (!steps.length) return [];
  const inputHash =
    options.inputHash ?? deterministicInputHash(deterministicCheckout(taskDir), taskDir);
  return steps.map((step) => {
    let receipt;
    let error;
    try {
      receipt = readOptionalJson(deterministicReceiptPath(taskDir, step));
    } catch (cause) {
      error = `Invalid execution receipt: ${cause.message}`;
    }
    let status = error ? 'failed' : receipt ? receipt.status : 'missing';
    let message = error ?? (receipt ? '' : 'Execution receipt is missing');
    if (receipt) {
      if (
        receipt.schemaVersion !== 1 ||
        receipt.checklist !== checklist ||
        receipt.stepNumber !== step.stepNumber ||
        receipt.command !== step.command ||
        receipt.reference !== step.reference ||
        receipt.inputHash !== inputHash
      ) {
        status = 'stale';
        message = 'Command or publishable inputs changed; rerun this mark step';
      } else if (receipt.status !== 'passed' || receipt.exitCode !== 0 || !receipt.finishedAt) {
        status =
          receipt.status === 'interrupted' || receipt.status === 'running'
            ? 'interrupted'
            : 'failed';
        message = `Command did not pass, exit ${receipt.exitCode ?? 'unavailable'}`;
      } else {
        const logFile =
          typeof receipt.logPath === 'string' ? path.resolve(taskDir, receipt.logPath) : '';
        if (
          !logFile.startsWith(
            path.resolve(taskDir, 'artifacts', 'deterministic-checks') + path.sep,
          ) ||
          !fs.existsSync(logFile) ||
          receipt.logHash !== logHash(logFile)
        ) {
          status = 'failed';
          message = 'Execution log is missing or changed';
        }
      }
    }
    if (!step.command) {
      status = 'missing';
      message = 'Declared command is missing from the frozen task contract';
    }
    return {
      ...step,
      status,
      exitCode: receipt?.exitCode ?? null,
      logPath: receipt?.logPath ?? null,
      inputHash,
      message,
    };
  });
}

function evaluateDeterministicChecks(taskDir, checklist) {
  const checks = readDeterministicChecks(taskDir, checklist);
  const issues = checks
    .filter((step) => step.status !== 'passed')
    .map(
      (step) =>
        `${step.checklist} step ${step.stepNumber} (${step.reference}): ${step.message || step.status}`,
    );
  return { checks, issues };
}

function deterministicContractIssues(taskDir, checklist) {
  return evaluateDeterministicChecks(taskDir, checklist).issues;
}

const deterministicChecks = {
  outputPrefix: 'TASK_DETERMINISTIC_CHECKS ',
  declarations: deterministicDeclarations,
  freeze: freezeDeterministicChecks,
  execute: executeDeterministicStep,
  read: readDeterministicChecks,
  issues: deterministicContractIssues,
  evaluate: evaluateDeterministicChecks,
};

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
  deterministicChecks,
};
