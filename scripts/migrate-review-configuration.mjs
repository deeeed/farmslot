#!/usr/bin/env node
// Offline ADR-063 conversion. No gateway, session, artifact or review-state operations.
import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tsImport } from 'tsx/esm/api';

const { assertReviewSequence, assertWarmReviewContext } = await tsImport(
  '../packages/review-dispatch/src/index.ts',
  {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(
      new URL('../packages/review-dispatch/test/tsconfig.json', import.meta.url),
    ),
  },
);

const RENAMES = {
  reviewDepth: 'reviewPolicy',
  pendingReviewPlan: 'reviewSequence',
  pendingReviewPlanRequestedAt: 'reviewSequenceRequestedAt',
  independentReviews: 'reviews',
  selfReview: 'review',
  selfReviewVerdict: 'reviewVerdict',
  selfReviewSummary: 'reviewSummary',
  needsSelfReview: 'needsReview',
  incrementalUnavailableReason: 'warmUnavailableReason',
  minimum_independent_reviews: 'minimum_reviews',
  fallbackReason: 'refusalReason',
};
const REMOVED = new Set(['crossRunner', 'requireCrossRunner', 'require_cross_runner']);
const ROLE_NAMES = { 'self-review': 'review', 'self-review-fix': 'review-fix' };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const field = (parent, key) => (parent ? `${parent}.${key}` : key);

/** Returns a proposed document and paths only; never creates reviewer lineage or proof. */
export function convertReviewConfiguration(document, kind) {
  const changes = new Set();
  const unresolved = new Set();
  const changed = (at) => changes.add(at || '$');
  const refuse = (at) => unresolved.add(at || '$');
  const primaryRunners =
    kind === 'run'
      ? [
          ...new Set(
            (document.agentContexts ?? [])
              .filter((context) => context.role === document.flowType || context.role === 'primary')
              .map((context) => context.runner)
              .filter((runner) => typeof runner === 'string' && runner.trim() && runner !== 'same'),
          ),
        ]
      : [];
  const recordedRunner = kind === 'run' ? document.metrics?.runner : undefined;
  const workerRunner =
    typeof recordedRunner === 'string' && recordedRunner.trim() && recordedRunner !== 'same'
      ? recordedRunner
      : primaryRunners.length === 1
        ? primaryRunners[0]
        : undefined;

  function resolveRunner(runner, at) {
    if (runner !== 'same') return runner;
    if (!workerRunner) {
      refuse(at);
      return runner;
    }
    changed(at);
    return workerRunner;
  }

  function put(target, key, value, at) {
    if (Object.hasOwn(target, key) && JSON.stringify(target[key]) !== JSON.stringify(value)) {
      refuse(at);
      return;
    }
    target[key] = value;
  }

  function sequence(rows, at) {
    if (rows === null) return null;
    if (!Array.isArray(rows)) {
      refuse(at);
      return rows;
    }
    return rows.map((row, index) => {
      const current = `${at}[${index}]`;
      if (!object(row)) {
        refuse(current);
        return row;
      }
      const runner = resolveRunner(row.runner, field(current, 'runner'));
      if (typeof runner !== 'string' || !runner.trim() || runner === 'same') {
        refuse(field(current, 'runner'));
        return row;
      }
      const allowed = new Set([
        'runner',
        'model',
        'effort',
        'mode',
        'order',
        'validationDepth',
        'sessionIntent',
      ]);
      for (const key of Object.keys(row)) if (!allowed.has(key)) refuse(field(current, key));
      if (row.order !== undefined && row.order !== index + 1) refuse(field(current, 'order'));
      if (row.validationDepth !== undefined && row.validationDepth !== 'static-code')
        refuse(field(current, 'validationDepth'));
      // Unstarted legacy choices become COLD. A saved intent never proves retained lineage.
      const result = {
        runner,
        model: row.model ?? null,
        effort: row.effort ?? null,
        mode: row.mode ?? 'cold',
      };
      if (!['warm', 'cold'].includes(result.mode)) refuse(field(current, 'mode'));
      for (const key of ['model', 'effort']) {
        if (result[key] !== null && (typeof result[key] !== 'string' || !result[key].trim()))
          refuse(field(current, key));
      }
      if (JSON.stringify(row) !== JSON.stringify(result)) changed(current);
      return result;
    });
  }

  function policy(value, at, owner) {
    if (!object(value)) {
      refuse(at);
      return value;
    }
    const minimum = value.minimumIndependentReviews ?? value.minimumReviews ?? 1;
    const extra = value.extraLoopsRequested ?? 0;
    if (![minimum, extra].every((count) => Number.isInteger(count) && count >= 0)) {
      refuse(at);
      return value;
    }
    const base = Math.max(value.requireCrossRunner === true ? 1 : 0, minimum);
    let requestedExtra = extra;
    // Match the outgoing gateway's v1 double-count repair before removing countingVersion.
    if (value.countingVersion !== 2 && value.requestedBy === 'dispatch' && extra > 0) {
      const plan = owner.pendingReviewPlan ?? owner.reviewSequence;
      const reviews = owner.independentReviews ?? owner.reviews;
      const pending = Array.isArray(plan) ? plan.length : 0;
      const materialized = Array.isArray(reviews)
        ? reviews.filter(
            (review) =>
              review?.source === 'dispatch' && !String(review.id).startsWith('self-review-'),
          ).length
        : 0;
      if ((pending > 0 && extra === pending) || (pending === 0 && extra === materialized))
        requestedExtra = Math.max(0, (pending || materialized) - base);
    }
    const result = {
      minimumReviews: base + requestedExtra,
      requestedBy: value.requestedBy ?? 'dispatch',
    };
    if (!['dispatch', 'human-gate', 'agent-gate'].includes(result.requestedBy))
      refuse(field(at, 'requestedBy'));
    const allowed = [
      'minimumIndependentReviews',
      'minimumReviews',
      'requireCrossRunner',
      'extraLoopsRequested',
      'countingVersion',
      'requestedBy',
    ];
    for (const key of Object.keys(value)) if (!allowed.includes(key)) refuse(field(at, key));
    changed(at);
    return result;
  }

  function visit(value, at = '', parentKey = '') {
    if (Array.isArray(value))
      return value.map((item, index) => visit(item, `${at}[${index}]`, parentKey));
    if (!object(value)) return value;
    const result = {};
    const historical =
      kind === 'run' && !['reviewSequence', 'pendingReviewPlan'].includes(parentKey);
    const options =
      (kind === 'project' && /workflow_defaults\.[^.]+\.review$/.test(at)) ||
      /prWork\.review\.options$/.test(at) ||
      (kind === 'pr-rules' &&
        parentKey === 'review' &&
        [
          'scope',
          'sessionIntent',
          'validationDepth',
          'busySession',
          'workflow',
          'publishReview',
          'autoFinish',
          'qaProfileId',
        ].some((key) => key in value));
    const session = parentKey === 'session' && ('continuity' in value || 'intent' in value);
    const legacyMode =
      'reviewScope' in value ||
      'sessionIntent' in value ||
      'reviewSessionIntent' in value ||
      'reviewSessionPolicy' in value ||
      (options && 'scope' in value);

    const oldModes = {
      reviewScope: ['full', 'incremental'],
      sessionIntent: ['resume', 'reset'],
      reviewSessionIntent: ['resume', 'reset'],
      reviewSessionPolicy: ['fresh-per-pass', 'warm-per-reviewer'],
    };
    if (options) oldModes.scope = ['full', 'incremental'];
    if (session) oldModes.intent = ['resume', 'reset'];
    if (kind === 'project' && at === 'review')
      oldModes.session_policy = ['fresh-per-pass', 'warm-per-reviewer'];
    for (const [key, choices] of Object.entries(oldModes)) {
      if (value[key] !== undefined && !choices.includes(value[key])) refuse(field(at, key));
    }

    for (const [key, child] of Object.entries(value)) {
      const current = field(at, key);
      if (
        key === 'models' &&
        Array.isArray(child) &&
        ('slotPolicy' in value || 'workspacePolicy' in value)
      ) {
        result.models = child.map((row, index) => {
          if (!object(row)) {
            refuse(`${current}[${index}]`);
            return row;
          }
          const choice = {
            ...row,
            runner: resolveRunner(row.runner, `${current}[${index}].runner`),
            effort: row.effort ?? null,
            mode: row.mode ?? 'cold',
          };
          if (JSON.stringify(choice) !== JSON.stringify(row)) changed(`${current}[${index}]`);
          return choice;
        });
        try {
          assertReviewSequence(
            result.models.map(({ runner, model, effort, mode }) => ({
              runner,
              model,
              effort,
              mode,
            })),
            { maxRows: 20, sequenceRole: 'execution-alternatives' },
          );
        } catch {
          refuse(current);
        }
        continue;
      }
      if (REMOVED.has(key)) {
        changed(current);
        continue;
      }
      if (key === 'pendingReviewPlan' || key === 'reviewSequence') {
        put(result, 'reviewSequence', sequence(child, current), current);
        if (key === 'pendingReviewPlan') changed(current);
        continue;
      }
      if (key === 'reviewDepth') {
        put(result, 'reviewPolicy', policy(child, current, value), current);
        continue;
      }
      if (key === 'reviewScope' || key === 'reviewSessionIntent' || key === 'reviewSessionPolicy') {
        changed(current);
        continue;
      }
      if (
        key === 'sessionIntent' ||
        (options && ['scope', 'validationDepth', 'busySession'].includes(key)) ||
        (key === 'contextMode' && 'reviewScope' in value)
      ) {
        changed(current);
        continue;
      }
      if (session && key === 'intent') {
        changed(current);
        continue;
      }
      if (kind === 'project' && at === '' && key === 'self_review') {
        if (child?.runner === 'same') refuse(field(current, 'runner'));
        const review = visit(child, 'review', 'review');
        if (child?.runner === 'same') unresolved.delete('review.runner');
        if (object(review) && review.mode === undefined) review.mode = 'cold';
        put(result, 'review', review, current);
        changed(current);
        continue;
      }
      if (kind === 'project' && at === 'review' && key === 'session_policy') {
        changed(current);
        continue;
      }
      let replacement = key === 'runner' ? resolveRunner(child, current) : child;
      if (key === 'status' && child === 'self-reviewing') replacement = 'reviewing';
      if (['role', 'agentRole', 'name'].includes(key) && Object.hasOwn(ROLE_NAMES, child))
        replacement = ROLE_NAMES[child];
      if (key === 'source' && child === 'self-review') replacement = 'pipeline';
      if (key === 'label' && child === 'Self-review') replacement = 'Review';
      if (key === 'label' && child === 'Self-review fix') replacement = 'Review fix';
      if (session && key === 'continuity' && child === 'fallback-fresh') replacement = 'fresh';
      const renamed = RENAMES[key] ?? key;
      put(result, renamed, visit(replacement, field(at, renamed), renamed), current);
      if (renamed !== key || replacement !== child) changed(current);
    }
    if (legacyMode) {
      const target = at === '' ? 'reviewMode' : 'mode';
      // Recorded runs keep the requested range; no missing reviewId/session evidence is synthesized.
      const mode =
        historical && (value.reviewScope === 'incremental' || value.sessionIntent === 'resume')
          ? 'warm'
          : 'cold';
      if (result[target] !== undefined && result[target] !== mode) refuse(field(at, target));
      else result[target] = mode;
    }
    if (session && value.intent !== undefined && result.mode === undefined)
      result.mode = value.intent === 'resume' ? 'warm' : 'cold';
    if (
      kind === 'project' &&
      at === 'review' &&
      value.session_policy !== undefined &&
      result.mode === undefined
    )
      result.mode = 'cold';
    if (options && result.mode === undefined) {
      result.mode = 'cold';
      changed(field(at, 'mode'));
    }
    if (options && value.validationDepth === 'full-live') {
      result.workflow ??= 'qa';
      if (!result.qaProfileId) refuse(field(at, 'qaProfileId'));
    }
    if (
      kind === 'project' &&
      /^publication_review\.[^.]+$/.test(at) &&
      value.require_cross_runner === true
    ) {
      result.minimum_reviews = Math.max(1, result.minimum_reviews ?? 1);
    }
    if (
      historical &&
      (['reviews', 'attempts'].includes(parentKey) || parentKey === 'reviewResult') &&
      'verdict' in value &&
      result.mode === undefined
    ) {
      result.mode = result.session?.mode ?? 'cold';
      changed(field(at, 'mode'));
    }
    if (result.reviewSequence !== undefined && result.reviewSequence !== null) {
      try {
        assertReviewSequence(result.reviewSequence, { allowEmpty: true, maxRows: 5 });
        assertWarmReviewContext(result.reviewSequence, result.reviewSequenceContext);
      } catch {
        refuse(field(at, 'reviewSequence'));
      }
    }
    return result;
  }

  const value = visit(document);
  return { value, fields: [...changes].sort(), unresolved: [...unresolved].sort() };
}

function argumentsFor(argv) {
  const options = { apply: false };
  const names = {
    '--root': 'root',
    '--backlog': 'backlog',
    '--queue': 'queue',
    '--runs-dir': 'runs',
    '--projects-dir': 'projects',
    '--pr-rules': 'prRules',
  };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--apply') options.apply = true;
    else if (argv[index] === '--dry-run') options.dryRun = true;
    else if (names[argv[index]] && argv[index + 1] && !argv[index + 1].startsWith('--'))
      options[names[argv[index]]] = path.resolve(argv[++index]);
    else throw new Error('arguments');
  }
  if (options.apply && options.dryRun) throw new Error('arguments');
  options.root ??= process.env.FARMSLOT_ROOT
    ? path.resolve(process.env.FARMSLOT_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  options.backlog ??= process.env.FARMSLOT_BACKLOG_FILE ?? path.join(options.root, '.backlog.json');
  options.queue ??=
    process.env.FARMSLOT_DISPATCH_QUEUE_FILE ?? path.join(options.root, '.dispatch-queue.json');
  options.runs ??= process.env.FARMSLOT_RUNS_DIR ?? path.join(options.root, '.runs');
  options.projects ??= process.env.FARMSLOT_PROJECTS_DIR ?? path.join(options.root, 'projects');
  options.prRules ??= path.join(options.root, '.pr-rules.json');
  return options;
}

async function optionalRead(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw new Error('read');
  }
}

/** Apply is refused for the entire batch when any record needs an operator choice. */
export async function migrateReviewConfiguration(options) {
  const report = { scanned: 0, changed: 0, unresolved: 0, applied: 0, items: [] };
  const proposals = [];
  async function inspect(file, kind, array = false) {
    const original = await optionalRead(file);
    if (original === null) return;
    report.scanned++;
    let parsed;
    try {
      parsed = JSON.parse(original);
    } catch {
      report.unresolved++;
      report.items.push({ file, fields: [], unresolved: ['$'] });
      return;
    }
    if ((array && !Array.isArray(parsed)) || (!array && !object(parsed))) {
      report.unresolved++;
      report.items.push({ file, fields: [], unresolved: ['$'] });
      return;
    }
    const records = array ? parsed : [parsed];
    const converted = records.map((item, index) => {
      const conversion = convertReviewConfiguration(item, kind);
      if (conversion.fields.length || conversion.unresolved.length) {
        const groups = new Map();
        for (const category of ['fields', 'unresolved'])
          for (const at of conversion[category]) {
            let record = item;
            let itemId =
              typeof item?.id === 'string'
                ? item.id
                : kind === 'project'
                  ? path.basename(path.dirname(file))
                  : String(index);
            for (const key of kind === 'pr-rules'
              ? at.replaceAll('[', '.').replaceAll(']', '').split('.')
              : []) {
              record = record?.[key];
              if (object(record) && typeof record.id === 'string') itemId = record.id;
            }
            if (!groups.has(itemId))
              groups.set(itemId, { file, itemId, fields: [], unresolved: [] });
            groups.get(itemId)[category].push(at);
          }
        report.items.push(...groups.values());
        report.unresolved += conversion.unresolved.length;
      }
      return conversion.value;
    });
    const value = array ? converted : converted[0];
    if (JSON.stringify(parsed) !== JSON.stringify(value)) {
      report.changed++;
      proposals.push({ file, original, value });
    }
  }
  await inspect(options.backlog, 'backlog', true);
  await inspect(options.queue, 'queue', true);
  await inspect(options.prRules ?? path.join(options.root, '.pr-rules.json'), 'pr-rules');
  for (const [directory, kind] of [
    [options.runs, 'run'],
    [path.join(options.runs, 'archive'), 'run'],
    [options.projects, 'project'],
  ]) {
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error('directory');
    }
    for (const name of names.sort()) {
      const file =
        kind === 'run' ? path.join(directory, name) : path.join(directory, name, 'project.json');
      if (kind === 'run' && (!name.endsWith('.json') || name.startsWith('.'))) continue;
      await inspect(file, kind);
    }
  }
  if (options.apply && !report.unresolved) {
    // Detect a writer or an earlier conversion before creating any backups or changing any file.
    for (const proposal of proposals) {
      proposal.file = await realpath(proposal.file);
      if (
        (await readFile(proposal.file, 'utf8')) !== proposal.original ||
        (await optionalRead(`${proposal.file}.adr063-original`)) !== null
      )
        throw new Error('changed');
    }
    for (const { file, original, value } of proposals) {
      await copyFile(file, `${file}.adr063-original`, constants.COPYFILE_EXCL);
      const temporary = `${file}.adr063-${process.pid}.tmp`;
      const permissions = (await stat(file)).mode & 0o777;
      await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {
        flag: 'wx',
        mode: permissions,
      });
      await chmod(temporary, permissions);
      if ((await readFile(file, 'utf8')) !== original) throw new Error('changed');
      await rename(temporary, file);
      report.applied++;
    }
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await migrateReviewConfiguration(argumentsFor(process.argv.slice(2)));
    console.log(JSON.stringify(report));
    if (report.unresolved) process.exitCode = 2;
  } catch {
    // Errors may contain private JSON values or environment details. Emit neither.
    console.error(JSON.stringify({ unresolved: 1, fields: ['$'] }));
    process.exitCode = 1;
  }
}
