'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { enumerateChecklistCheckboxes } = require('./checklist-target.cjs');

const OUTCOMES = new Set(['PASS', 'FINDING', 'NOT_APPLICABLE', 'NOT_CHECKED']);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hashMap = (value) =>
  object(value) && Object.values(value).every((entry) => typeof entry === 'string' && entry);

function coverageRowKey(row) {
  if (row.kind === 'scope' && typeof row.path === 'string' && row.path) return `scope:${row.path}`;
  if (
    row.kind === 'criterion' &&
    typeof row.unitId === 'string' &&
    row.unitId &&
    Number.isInteger(row.stepNumber) &&
    row.stepNumber > 0 &&
    typeof row.ruleSourceSha256 === 'string' &&
    row.ruleSourceSha256
  )
    return `criterion:${row.unitId}:${row.stepNumber}:${row.ruleSourceSha256}`;
  throw new Error('Invalid review coverage row identity');
}

/** The caller supplies hashes from a validated earlier review, never from model claims. */
function readCoverageIndex(bytes, expected) {
  if (
    typeof bytes !== 'string' ||
    !expected ||
    !expected.indexSha256 ||
    sha256(bytes) !== expected.indexSha256
  )
    return null;
  let value;
  try {
    value = JSON.parse(bytes);
  } catch (error) {
    // A legacy/malformed index disables reuse; it cannot invalidate the delta range.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.rows) ||
    !['runId', 'headSha', 'reportSha256', 'authorizationHash', 'ruleHash'].every(
      (key) => typeof value[key] === 'string' && value[key],
    ) ||
    ['runId', 'headSha', 'reportSha256'].some((key) => value[key] !== expected[key])
  )
    return null;
  const keys = new Set();
  for (const row of value.rows) {
    if (
      !object(row) ||
      !object(row.definition) ||
      typeof row.key !== 'string' ||
      !object(row.value) ||
      !hashMap(row.sourceHashes) ||
      !hashMap(row.evidenceHashes) ||
      keys.has(row.key)
    )
      return null;
    try {
      if (coverageRowKey(row.definition) !== row.key) return null;
    } catch (error) {
      if (error.message === 'Invalid review coverage row identity') return null;
      throw error;
    }
    if (row.definition.kind === 'criterion' && !OUTCOMES.has(row.value.outcome)) return null;
    if (
      row.definition.kind === 'scope' &&
      ![row.value.scope, row.value.justification].every(
        (text) => typeof text === 'string' && text.trim(),
      )
    )
      return null;
    keys.add(row.key);
  }
  return value;
}

function reusableCoverageRows(index, inputs) {
  const reusable = [],
    invalidated = [];
  if (!index) return { reusable, invalidated, unavailable: 'missing-or-unverified-index' };
  const definitions = new Map(inputs.definitions.map((row) => [coverageRowKey(row), row]));
  for (const row of index.rows) {
    let reason;
    if (index.authorizationHash !== inputs.authorizationHash) reason = 'authorization-changed';
    else if (index.ruleHash !== inputs.ruleHash) reason = 'rules-changed';
    else if (!definitions.has(row.key)) reason = 'row-no-longer-current';
    else if (
      row.definition.kind === 'criterion' &&
      (row.definition.label !== definitions.get(row.key).label ||
        row.definition.family !== definitions.get(row.key).family)
    )
      reason = 'rule-binding-changed';
    else if (
      row.definition.kind === 'criterion' &&
      ['PASS', 'FINDING'].includes(row.value.outcome) &&
      !Object.keys(row.sourceHashes).length &&
      !Object.keys(row.evidenceHashes).length
    )
      reason = 'no-verifiable-row-input';
    else if (
      Object.entries(row.sourceHashes).some(
        ([key, value]) => value === 'missing' || inputs.sourceHashes[key] !== value,
      )
    )
      reason = 'source-changed-or-missing';
    else if (
      Object.entries(row.evidenceHashes).some(
        ([key, value]) => value === 'missing' || inputs.evidenceHashes[key] !== value,
      )
    )
      reason = 'evidence-changed-or-missing';
    if (reason) invalidated.push({ key: row.key, reason });
    else reusable.push(row);
  }
  return { reusable, invalidated };
}

function strings(value, name) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry))
    throw new Error(`Review coverage ${name} must be an explicit array of strings`);
  return [...new Set(value)];
}

function fingerprints(paths, hashes, allowMissing) {
  return Object.fromEntries(
    paths.map((file) => {
      const value = Object.hasOwn(hashes, file) ? hashes[file] : undefined;
      if (typeof value !== 'string' || (!allowMissing && value === 'missing'))
        throw new Error(`Review coverage input is missing: ${file}`);
      return [file, value];
    }),
  );
}

/** Reuse is an explicit reviewer applicability claim, not a current-head verdict. */
function composeCoverageRows(inputs, update, baseline) {
  if (!object(update) || update.schemaVersion !== 1 || !Array.isArray(update.rows))
    throw new Error('Expected review-result.json coverage schemaVersion 1 and rows');
  const reuse = strings(update.reuse, 'reuse');
  if (reuse.length && update.applicabilityChecked !== true)
    throw new Error('Reused review rows require current-delta applicability confirmation');
  const available = new Map(
    reusableCoverageRows(baseline, inputs).reusable.map((row) => [row.key, row]),
  );
  const definitions = new Map(inputs.definitions.map((row) => [coverageRowKey(row), row]));
  if (definitions.size !== inputs.definitions.length)
    throw new Error('Duplicate coverage definition');
  const result = new Map();
  for (const key of reuse) {
    const row = available.get(key);
    if (!row) throw new Error(`Review coverage row requires current evaluation: ${key}`);
    result.set(key, {
      ...row,
      definition: definitions.get(key),
      provenance: {
        runId: baseline.runId,
        headSha: baseline.headSha,
        reportSha256: baseline.reportSha256,
        applicabilityChecked: true,
      },
    });
  }
  for (const row of update.rows) {
    if (!object(row) || typeof row.key !== 'string' || !definitions.has(row.key))
      throw new Error('Review coverage update has an unknown row');
    if (result.has(row.key)) throw new Error(`Duplicate review coverage update: ${row.key}`);
    const definition = definitions.get(row.key);
    const sources = strings(row.sources, 'sources');
    const artifacts = strings(row.artifacts, 'artifacts');
    const value =
      definition.kind === 'scope'
        ? { scope: row.scope, justification: row.justification }
        : { outcome: row.outcome, evidence: row.evidence };
    if (definition.kind === 'scope') {
      if (!sources.includes(definition.path)) sources.push(definition.path);
      if (
        ![value.scope, value.justification].every((text) => typeof text === 'string' && text.trim())
      )
        throw new Error('Scope coverage requires authorization and justification');
    } else if (
      !OUTCOMES.has(value.outcome) ||
      typeof value.evidence !== 'string' ||
      !value.evidence.trim()
    )
      throw new Error('Criterion coverage requires an outcome and evidence or gap');
    const allowMissing = value.outcome === 'NOT_CHECKED';
    result.set(row.key, {
      key: row.key,
      definition,
      value,
      sourceHashes: fingerprints(sources, inputs.sourceHashes, allowMissing),
      evidenceHashes: fingerprints(artifacts, inputs.evidenceHashes, allowMissing),
      provenance: { runId: inputs.runId, headSha: inputs.headSha, applicabilityChecked: true },
    });
  }
  for (const key of definitions.keys())
    if (!result.has(key)) throw new Error(`Missing current review coverage row: ${key}`);
  return {
    schemaVersion: 1,
    runId: inputs.runId,
    headSha: inputs.headSha,
    authorizationHash: inputs.authorizationHash,
    ruleHash: inputs.ruleHash,
    rows: [...definitions.keys()].map((key) => result.get(key)),
  };
}

function cell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}
function renderCoverage(index) {
  const scope = [
    '| File | Ticket AC or required test | Scope justification or finding |',
    '| --- | --- | --- |',
  ];
  const ledger = [
    '# Review ledger',
    '',
    `Current head: ${index.headSha}`,
    '',
    '## Criteria ledger',
    '',
  ];
  const units = new Map();
  for (const row of index.rows) {
    const d = row.definition,
      v = row.value;
    const reused =
      row.provenance.headSha !== index.headSha
        ? ` Reused from ${row.provenance.headSha}; current-delta applicability checked.`
        : '';
    if (d.kind === 'scope')
      scope.push(`| \`${cell(d.path)}\` | ${cell(v.scope)} | ${cell(v.justification + reused)} |`);
    else {
      if (!units.has(d.unitId)) units.set(d.unitId, []);
      units
        .get(d.unitId)
        .push(
          `| ${d.stepNumber} | ${cell(d.family ?? d.unitId)} | ${cell(d.label)} | ${v.outcome} | ${cell(v.evidence + reused)} |`,
        );
    }
  }
  for (const [unit, rows] of units)
    ledger.push(
      `### ${unit}`,
      '',
      '| # | Family | Rule | Outcome | Evidence or gap |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      '',
    );
  ledger.push('## Diff scope', '', ...scope, '');
  return { scope: scope.join('\n'), ledger: ledger.join('\n') };
}

function relativeFile(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.startsWith('../') ||
    value === '..'
  )
    throw new Error('Review coverage requires a canonical relative path');
  return value;
}

function optionalFile(file, encoding = 'utf8') {
  try {
    return fs.readFileSync(file, encoding);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function readReviewTaskFile(taskDir, file, encoding = 'utf8') {
  const root = fs.realpathSync(taskDir);
  const target = path.join(root, relativeFile(file));
  let resolved;
  try {
    resolved = fs.realpathSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('Review coverage file escapes its task directory');
  return fs.readFileSync(resolved, encoding);
}

function readCoveragePolicy(manifest) {
  const data = typeof manifest === 'string' ? JSON.parse(manifest) : manifest;
  const policy = data?.reviewCoverage;
  if (policy === undefined) return undefined;
  if (
    !object(policy) ||
    policy.schemaVersion !== 1 ||
    !['runId', 'repo', 'headSha', 'authorizationHash', 'ruleHash'].every(
      (key) => typeof policy[key] === 'string' && policy[key],
    ) ||
    !path.isAbsolute(policy.repo) ||
    !Array.isArray(policy.scopePaths)
  )
    throw new Error('Invalid frozen review coverage policy');
  policy.scopePaths.forEach(relativeFile);
  if (
    policy.baseline &&
    (!object(policy.baseline) ||
      !['runId', 'headSha', 'reportSha256', 'indexSha256'].every(
        (key) => typeof policy.baseline[key] === 'string' && policy.baseline[key],
      ) ||
      !hashMap(policy.baseline.evidenceHashes ?? {}))
  )
    throw new Error('Invalid review coverage baseline identity');
  return policy;
}

function coverageDefinitions(taskDir, policy) {
  const registry = JSON.parse(readReviewTaskFile(taskDir, 'subtasks/index.json') ?? '{"units":[]}');
  const units = registry.units?.length
    ? registry.units
    : [{ id: 'root', checklist: 'CHECKLIST.md', source: { sha256: policy.ruleHash } }];
  return [
    ...policy.scopePaths.map((file) => ({ kind: 'scope', path: relativeFile(file) })),
    ...units.flatMap((unit) => {
      const text = readReviewTaskFile(taskDir, relativeFile(unit.checklist));
      if (text === undefined) throw new Error('Registered review checklist is missing');
      const lines = text.split('\n');
      return enumerateChecklistCheckboxes(text).map((item, index) => ({
        kind: 'criterion',
        unitId: unit.id,
        stepNumber: index + 1,
        ruleSourceSha256: unit.source.sha256,
        label: lines[item.lineIndex].replace(/^\s*- \[[ xX]\]\s*/, '').trim(),
      }));
    }),
  ];
}

/** One Git batch for the selected paths, including explicit absence for deleted contribution files. */
function coverageSourceHashes(repo, headSha, files, scopePaths) {
  const unique = [...new Set(files.map(relativeFile))];
  if (!unique.length) return {};
  const output = execFileSync(
    'git',
    ['ls-tree', '-r', '-z', '--full-tree', headSha, '--', ...unique],
    {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' },
    },
  );
  return parseCoverageSourceHashes(output, unique, scopePaths);
}

function parseCoverageSourceHashes(output, files, scopePaths) {
  const result = Object.fromEntries(
    files.map((file) => [relativeFile(file), scopePaths.includes(file) ? 'absent' : 'missing']),
  );
  for (const entry of output.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\t');
    const [mode, , objectId] = entry.slice(0, separator).split(' ');
    const file = entry.slice(separator + 1);
    if (Object.hasOwn(result, file)) result[file] = `${mode}:${objectId}`;
  }
  return result;
}

function stripScopeSection(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## Diff scope');
  if (start < 0) return markdown.trimEnd();
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return [...lines.slice(0, start), ...(end < 0 ? [] : lines.slice(end))].join('\n').trimEnd();
}

function writeCoverageFile(file, text) {
  if (optionalFile(file) === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { flag: 'wx' });
  fs.renameSync(temporary, file);
}

function reviewCoverageEvidencePaths(update) {
  if (!object(update) || !Array.isArray(update.rows))
    throw new Error('Review result requires coverage rows');
  return [...new Set(update.rows.flatMap((row) => strings(row.artifacts, 'artifacts')))].map(
    (file) => {
      relativeFile(file);
      if (
        !file.startsWith('artifacts/') ||
        [
          'artifacts/acceptance-status.json',
          'artifacts/review.md',
          'artifacts/review-ledger.md',
          'artifacts/review-coverage.json',
          'artifacts/review-result.json',
        ].includes(file)
      )
        throw new Error(
          'Coverage evidence must be separate reviewer proof, never a managed or engine ledger',
        );
      return file;
    },
  );
}

function normalizeCoverageUpdate(update, definitions, runId) {
  reviewCoverageEvidencePaths(update);
  const byPosition = new Map(
    definitions
      .filter((d) => d.kind === 'criterion')
      .map((d) => [`${d.unitId}:${d.stepNumber}`, coverageRowKey(d)]),
  );
  return {
    ...update,
    rows: update.rows.map((row) => ({
      ...row,
      key:
        row.key ??
        (row.kind === 'scope'
          ? `scope:${relativeFile(row.path)}`
          : byPosition.get(`${row.unitId}:${row.stepNumber}`)),
      artifacts: strings(row.artifacts, 'artifacts').map((file) => `${runId}:${file}`),
    })),
  };
}

function reviewCoverageSourcePaths(scopePaths, baseline, update) {
  return [
    ...new Set([
      ...scopePaths,
      ...(baseline?.rows.flatMap((row) => Object.keys(row.sourceHashes)) ?? []),
      ...update.rows.flatMap((row) => strings(row.sources, 'sources')),
    ]),
  ].map(relativeFile);
}

/** Used by the marker and by the accepted-result verifier, with independently read hashes. */
function composeReviewArtifacts(
  policy,
  definitions,
  result,
  rawReport,
  baseline,
  sourceHashes,
  artifactHashes,
  baselineEvidenceHashes = policy.baseline?.evidenceHashes ?? {},
) {
  const normalized = normalizeCoverageUpdate(result.coverage, definitions, policy.runId);
  const evidenceHashes = { ...baselineEvidenceHashes };
  for (const file of reviewCoverageEvidencePaths(result.coverage))
    evidenceHashes[`${policy.runId}:${file}`] = artifactHashes[file] ?? 'missing';
  const index = composeCoverageRows(
    { ...policy, definitions, sourceHashes, evidenceHashes },
    normalized,
    baseline,
  );
  if (
    index.rows.some((row) => row.value.outcome === 'FINDING') &&
    (!Array.isArray(result.issues) || !result.issues.length)
  )
    throw new Error('Coverage findings require current typed issues; reuse cannot clear them');
  const rendered = renderCoverage(index);
  const prose = stripScopeSection(rawReport);
  const report = `${prose}\n\n## Diff scope\n\n${rendered.scope}\n`;
  index.reportSha256 = sha256(report);
  index.ledgerSha256 = sha256(rendered.ledger);
  index.compositionFingerprint = sha256(
    JSON.stringify({
      policy,
      normalized,
      definitions,
      prose,
      issues: result.issues,
      artifactHashes,
    }),
  );
  return { index, report, ledger: rendered.ledger };
}

/** Existing mark terminal paths call this before their artifact checks and hashes. */
function materializeReviewCoverage(taskDir) {
  const policy = readCoveragePolicy(
    readReviewTaskFile(taskDir, 'inputs/instruction-manifest.json') ?? '{}',
  );
  if (!policy) return null; // Older tasks keep their frozen report contract.
  if (policy.schemaVersion !== 1 || !Array.isArray(policy.scopePaths))
    throw new Error('Invalid frozen review coverage policy');
  const result = JSON.parse(readReviewTaskFile(taskDir, 'artifacts/review-result.json') ?? 'null');
  if (!object(result)) throw new Error('Current structured review result is missing');
  const update = result.coverage;
  if (!object(update) || !Array.isArray(update.rows))
    throw new Error('Review result requires coverage rows');
  const definitions = coverageDefinitions(taskDir, policy);
  const normalized = normalizeCoverageUpdate(update, definitions, policy.runId);
  const artifactHashes = Object.fromEntries(
    reviewCoverageEvidencePaths(update).map((file) => {
      const bytes = readReviewTaskFile(taskDir, file, null);
      return [file, bytes === undefined ? 'missing' : sha256(bytes)];
    }),
  );
  const priorBytes = policy.baseline
    ? readReviewTaskFile(taskDir, 'inputs/prior-review-coverage.json')
    : undefined;
  const baseline = readCoverageIndex(priorBytes, policy.baseline);
  const rawReport = readReviewTaskFile(taskDir, 'artifacts/review.md') ?? '';
  if (!rawReport.trim())
    throw new Error('Current review report must be authored before coverage composition');
  const prose = stripScopeSection(rawReport);
  const fingerprint = sha256(
    JSON.stringify({
      policy,
      normalized,
      definitions,
      prose,
      issues: result.issues,
      artifactHashes,
    }),
  );
  const outputFile = path.join(taskDir, 'artifacts/review-coverage.json');
  const cachedBytes = readReviewTaskFile(taskDir, 'artifacts/review-coverage.json');
  const cached = cachedBytes ? JSON.parse(cachedBytes) : undefined;
  const oldLedger = readReviewTaskFile(taskDir, 'artifacts/review-ledger.md');
  const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: policy.repo,
    encoding: 'utf8',
  }).trim();
  if (actualHead !== policy.headSha)
    throw new Error('Review source head changed before coverage composition');
  if (
    cached?.compositionFingerprint === fingerprint &&
    cached.reportSha256 === sha256(rawReport) &&
    oldLedger !== undefined &&
    cached.ledgerSha256 === sha256(oldLedger)
  )
    return cached;
  const sourcePaths = reviewCoverageSourcePaths(policy.scopePaths, baseline, update);
  const sourceHashes = coverageSourceHashes(
    policy.repo,
    policy.headSha,
    sourcePaths,
    policy.scopePaths,
  );
  const { index, report, ledger } = composeReviewArtifacts(
    policy,
    definitions,
    result,
    rawReport,
    baseline,
    sourceHashes,
    artifactHashes,
  );
  // The task's output parent is fixed; never follow a reviewer-created directory link.
  const parent = fs.realpathSync(path.join(taskDir, 'artifacts'));
  if (path.relative(fs.realpathSync(taskDir), parent) !== 'artifacts')
    throw new Error('Review coverage output directory changed');
  writeCoverageFile(path.join(taskDir, 'artifacts/review.md'), report);
  writeCoverageFile(path.join(taskDir, 'artifacts/review-ledger.md'), ledger);
  writeCoverageFile(outputFile, JSON.stringify(index, null, 2) + '\n');
  return index;
}

module.exports = {
  sha256,
  coverageRowKey,
  readCoverageIndex,
  reusableCoverageRows,
  composeCoverageRows,
  renderCoverage,
  relativeFile,
  coverageDefinitions,
  coverageSourceHashes,
  parseCoverageSourceHashes,
  reviewCoverageEvidencePaths,
  reviewCoverageSourcePaths,
  readReviewTaskFile,
  readCoveragePolicy,
  composeReviewArtifacts,
  materializeReviewCoverage,
};
