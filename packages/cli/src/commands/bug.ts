// bug.ts — the `farmslot bug` command family: triage | score | grade | validate
// | batch. Gateway-free (like `internal`): every verb runs in the CLI process,
// spawning gh / curl / claude / the project scorer as side-effect edges around
// the protocol decision cores. Machine mode emits one envelope; human mode gets
// ~200ms instant feedback via a spinner.
//
// Ports scripts/{triage-bug,score-bug,grade-bug,validate-bug,batch-triage,
// download-github-images,download-jira-images}.sh.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Command } from 'commander';

import {
  type EnqueueBridgeResult,
  enqueueScoredBugs,
  parseEnqueueThreshold,
} from '../bug/enqueue-bridge.js';
import { type BatchOptions, runBatch, runGrade, runValidate } from '../bug/pipeline.js';
import { loadProjectContext, runScore, runTriage } from '../bug/triage.js';
import { resolveContext } from '../context.js';
import { createEmitter, type EnvelopeEmitter } from '../envelope.js';
import { OutputContext } from '../output.js';
import { withProgress } from '../progress.js';

function machineOutput(cmd: Command): { output: OutputContext; emit: EnvelopeEmitter } {
  const output = new OutputContext(Boolean(cmd.optsWithGlobals().json));
  return { output, emit: createEmitter(output, cmd) };
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/** Resolve --project, falling back to `projects/<name>/` in a path argument. */
function resolveProjectName(explicit: string | undefined, fromPath?: string): string {
  if (explicit) return explicit;
  const match = fromPath?.match(/projects\/([^/]+)\//);
  if (match) return match[1];
  throw Object.assign(new Error('--project is required (could not auto-detect from path)'), {
    code: 'PROJECT_REQUIRED',
    userAction: 'Pass --project <name>.',
  });
}

function countInputModes(opts: {
  github?: string;
  jira?: string;
  input?: string;
  stdin?: boolean;
}): number {
  return [opts.github, opts.jira, opts.input, opts.stdin].filter(Boolean).length;
}

export function registerBugCommand(program: Command): void {
  const bug = program
    .command('bug')
    .description('Bug triage/scoring pipeline (gateway-free; spawns gh/curl/claude edges)');

  // ── triage ───────────────────────────────────────────────────────────────
  bug
    .command('triage')
    .description('Heuristic-only triage: fetch a bug, score it, write scores/<key>.json')
    .option('--github <ref>', 'GitHub issue: owner/repo#N or a full issues URL')
    .option('--jira <key>', 'Jira issue key (e.g. PROJ-2236)')
    .option('--input <file>', 'Path to an existing bug-input.json')
    .option('--stdin', 'Read bug-input.json from stdin')
    .option('--project <name>', 'Project name (projects/<name>)')
    .option('--scores-dir <dir>', 'Override the scores output directory')
    .option('--skip-existing', 'Exit early if the score file already has a heuristic')
    .option('--download-images <dir>', 'Also download issue images to this directory')
    .action(
      async (
        opts: {
          github?: string;
          jira?: string;
          input?: string;
          stdin?: boolean;
          project?: string;
          scoresDir?: string;
          skipExisting?: boolean;
          downloadImages?: string;
        },
        cmd: Command,
      ) => {
        const { output, emit } = machineOutput(cmd);
        try {
          const modes = countInputModes(opts);
          if (modes === 0) {
            throw Object.assign(
              new Error('one of --github, --jira, --input, or --stdin is required'),
              {
                code: 'USAGE_ERROR',
                userAction: 'Pass exactly one input mode.',
              },
            );
          }
          if (modes > 1) {
            throw Object.assign(
              new Error('--github, --jira, --input, and --stdin are mutually exclusive'),
              {
                code: 'USAGE_ERROR',
                userAction: 'Pass exactly one input mode.',
              },
            );
          }
          const project = resolveProjectName(opts.project, opts.input);
          const ctx = await loadProjectContext(project);
          // Show pending feedback before blocking on a (possibly slow, interactive)
          // stdin read — otherwise the CLI sits silent past the ~200ms rule.
          const stdinJson = opts.stdin
            ? await withProgress('Reading bug input from stdin', readStdin, !emit.machine)
            : undefined;
          const result = await withProgress(
            'Triaging bug',
            () =>
              runTriage(
                {
                  github: opts.github,
                  jira: opts.jira,
                  input: opts.input,
                  stdinJson,
                  project,
                  scoresDir: opts.scoresDir,
                  skipExisting: opts.skipExisting,
                  downloadImages: opts.downloadImages,
                  now: new Date(),
                },
                ctx,
              ),
            !emit.machine,
          );
          if (emit.machine) {
            emit.ok(result);
          } else if (result.skipped) {
            output.write(`Skipped (already scored): ${result.scoreKey}\n`);
          } else {
            output.write(`Scored: ${result.scoreFile}\n`);
            if (result.heuristic) {
              output.write(`  difficulty:  ${result.heuristic.difficulty}\n`);
              output.write(`  category:    ${result.heuristic.category}\n`);
              output.write(`  p(one-shot): ${result.heuristic.one_shot_probability}\n`);
            } else {
              output.write('  scoring: not configured (bug_input saved without heuristic)\n');
            }
            if (result.downloadedImages?.length) {
              output.write(`  images:      ${result.downloadedImages.join(' ')}\n`);
            }
          }
        } catch (err) {
          emit.fail(err);
        }
      },
    );

  // ── score ────────────────────────────────────────────────────────────────
  bug
    .command('score')
    .description("Run the project's heuristic scorer over a bug-input and validate its output")
    .option('--input <file>', 'Path to a bug-input.json')
    .option('--stdin', 'Read bug-input.json from stdin')
    .option('--project <name>', 'Project name (projects/<name>)')
    .action(async (opts: { input?: string; stdin?: boolean; project?: string }, cmd: Command) => {
      const { output, emit } = machineOutput(cmd);
      // Staging dir for --stdin input; removed in finally so it is not leaked.
      let stagingDir: string | undefined;
      try {
        if (opts.input && opts.stdin) {
          throw Object.assign(new Error('--input and --stdin are mutually exclusive'), {
            code: 'USAGE_ERROR',
            userAction: 'Pass exactly one of --input or --stdin.',
          });
        }
        if (!opts.input && !opts.stdin) {
          throw Object.assign(new Error('--input or --stdin is required'), {
            code: 'USAGE_ERROR',
            userAction: 'Pass --input <file> or --stdin.',
          });
        }
        const project = resolveProjectName(opts.project, opts.input);
        const ctx = await loadProjectContext(project);
        // Show pending feedback before blocking on a slow interactive stdin read.
        const inputAbs = opts.stdin
          ? await withProgress(
              'Reading bug input from stdin',
              async () => {
                stagingDir = await mkdtemp(path.join(tmpdir(), 'farmslot-bug-'));
                const file = path.join(stagingDir, 'bug-input.json');
                await writeFile(file, await readStdin());
                return file;
              },
              !emit.machine,
            )
          : path.resolve(opts.input!);
        const heuristic = await withProgress(
          'Scoring bug',
          () => runScore(inputAbs, ctx),
          !emit.machine,
        );
        if (emit.machine) {
          emit.ok({ scored: heuristic !== null, heuristic });
        } else if (heuristic) {
          output.write(`${JSON.stringify(heuristic, null, 2)}\n`);
        } else {
          output.write('scoring: not configured for this project (nothing to score)\n');
        }
      } catch (err) {
        emit.fail(err);
      } finally {
        if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
      }
    });

  // ── grade ────────────────────────────────────────────────────────────────
  bug
    .command('grade')
    .description('LLM difficulty grading (claude): add llm + final sections to a score file')
    .requiredOption('--score-file <path>', 'Path to a scores/<key>.json produced by triage')
    .option('--model <model>', 'Grading model', 'sonnet')
    .option('--project <name>', 'Project name (auto-detected from the score-file path)')
    .action(async (opts: { scoreFile: string; model: string; project?: string }, cmd: Command) => {
      const { output, emit } = machineOutput(cmd);
      try {
        const project = resolveProjectName(opts.project, opts.scoreFile);
        const ctx = await loadProjectContext(project);
        const result = await withProgress(
          'Grading bug',
          () => runGrade(opts.scoreFile, opts.model, ctx, new Date()),
          !emit.machine,
        );
        if (emit.machine) {
          emit.ok(result);
        } else if (result.skipped) {
          output.write(`Skipped: ${result.reason}\n`);
        } else {
          output.write(
            `LLM: ${result.llm!.difficulty}@${result.llm!.confidence} confidence, p=${result.llm!.one_shot_probability}\n`,
          );
          output.write(
            `Final: ${result.final!.difficulty} (${result.final!.source}), p=${result.final!.one_shot_probability}, model=${result.final!.recommended_model}\n`,
          );
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  // ── validate ──────────────────────────────────────────────────────────────
  bug
    .command('validate')
    .description('LLM validity check (claude haiku): is the bug still present or already fixed?')
    .requiredOption('--score-file <path>', 'Path to a scores/<key>.json produced by triage')
    .option('--project <name>', 'Project name (auto-detected from the score-file path)')
    .action(async (opts: { scoreFile: string; project?: string }, cmd: Command) => {
      const { output, emit } = machineOutput(cmd);
      try {
        const project = resolveProjectName(opts.project, opts.scoreFile);
        const ctx = await loadProjectContext(project);
        const result = await withProgress(
          'Validating bug',
          () => runValidate(opts.scoreFile, ctx, new Date()),
          !emit.machine,
        );
        if (emit.machine) {
          emit.ok(result);
        } else {
          const status = result.still_valid ? 'STILL VALID' : 'LIKELY FIXED';
          output.write(`${status} (confidence: ${result.confidence}) — ${result.reason}\n`);
        }
      } catch (err) {
        emit.fail(err);
      }
    });

  // ── batch ─────────────────────────────────────────────────────────────────
  bug
    .command('batch')
    .description('Bulk-fetch bugs from GitHub/Jira and triage them all')
    .argument('<project>', 'Project name (projects/<name>)')
    .option('--source <github|jira>', 'Issue source', 'github')
    .option('--label <label>', 'GitHub label filter (repeatable)', collect, [] as string[])
    .option('--team <team>', 'Filter by team-<team> label / Jira label')
    .option('--jql <clause>', 'Jira: extra JQL appended to the base query')
    .option('--limit <n>', 'Max issues to fetch', '100')
    .option('--since <date>', 'Only issues updated on/after this ISO date')
    .option('--max-age <days>', 'Only issues updated within N days (alternative to --since)')
    .option('--exclude-assigned', 'Skip already-assigned issues')
    .option('--parallel <n>', 'Concurrent triage jobs', '4')
    .option('--rescore', 'Re-score even when a score file already exists')
    .option('--validate', 'Run the LLM validity check on scored issues')
    .option('--download-images <dir>', 'Also download issue images to this directory')
    .option(
      '--enqueue-threshold <p>',
      'Create backlog items (candidate, flow fix-bug) for scored issues with p(one-shot) >= p (0..1); requires a reachable gateway',
    )
    .action(
      async (
        project: string,
        opts: {
          source: string;
          label: string[];
          team?: string;
          jql?: string;
          limit: string;
          since?: string;
          maxAge?: string;
          excludeAssigned?: boolean;
          parallel: string;
          rescore?: boolean;
          validate?: boolean;
          downloadImages?: string;
          enqueueThreshold?: string;
        },
        cmd: Command,
      ) => {
        const { output, emit } = machineOutput(cmd);
        try {
          if (opts.source !== 'github' && opts.source !== 'jira') {
            throw Object.assign(new Error(`--source must be github or jira, got: ${opts.source}`), {
              code: 'USAGE_ERROR',
              userAction: 'Pass --source github or --source jira.',
            });
          }
          // Blank values must be usage errors, not threshold 0 (Number('') === 0).
          const enqueueThreshold = parseEnqueueThreshold(opts.enqueueThreshold);
          const batchOpts: BatchOptions = {
            source: opts.source,
            label: opts.label,
            team: opts.team,
            jql: opts.jql,
            limit: Number(opts.limit) || 100,
            since: opts.since,
            maxAge: opts.maxAge != null ? Number(opts.maxAge) : undefined,
            excludeAssigned: Boolean(opts.excludeAssigned),
            parallel: Number(opts.parallel) || 4,
            rescore: Boolean(opts.rescore),
            validate: Boolean(opts.validate),
            downloadImages: opts.downloadImages,
            now: new Date(),
          };
          const result = await withProgress(
            'Batch triaging',
            () => runBatch(project, batchOpts),
            !emit.machine,
          );
          for (const failure of result.failures) {
            process.stderr.write(`  FAIL: ${failure.ref}: ${failure.error}\n`);
          }
          // Total failure: issues were found but nothing scored or skipped-with-
          // existing. Exit non-zero with structured remediation so automation does
          // not read an empty batch as success.
          if (result.total > 0 && result.scored === 0 && result.skipped === 0) {
            throw Object.assign(
              new Error(`batch produced no scores: all ${result.total} issue(s) failed`),
              {
                code: 'BATCH_ALL_FAILED',
                userAction:
                  'Inspect the per-issue FAIL lines above (auth/network/scorer errors), fix the root cause, then re-run.',
                details: result.failures,
              },
            );
          }
          let enqueueBridge: EnqueueBridgeResult | undefined;
          if (enqueueThreshold !== undefined) {
            const ctx = resolveContext(cmd);
            enqueueBridge = await withProgress(
              `Enqueueing scored bugs >= ${enqueueThreshold}`,
              () =>
                enqueueScoredBugs(ctx.client, {
                  project,
                  source: opts.source as 'github' | 'jira',
                  scoresDir: result.scoresDir,
                  // scoredKeys only: with --rescore a FAILED issue can leave a
                  // stale score file behind, which must not be bridged.
                  keys: result.scoredKeys,
                  threshold: enqueueThreshold,
                }),
              !emit.machine,
            );
            for (const failure of enqueueBridge.failures) {
              process.stderr.write(`  ENQUEUE FAIL: ${failure.ref}: ${failure.error}\n`);
            }
          }
          if (emit.machine) {
            emit.ok(enqueueBridge ? { ...result, enqueueBridge } : result);
          } else {
            if (result.total === 0) {
              output.write('No issues found matching filters.\n');
            } else {
              output.write(result.report);
              output.write(
                `\nScored: ${result.scored}, skipped: ${result.skipped}, failed: ${result.failed} of ${result.total}\n`,
              );
            }
            if (enqueueBridge) {
              output.write(
                `Enqueue bridge (p>=${enqueueBridge.threshold}): ${enqueueBridge.created.length} created, ${enqueueBridge.skippedExisting.length} already tracked, ${enqueueBridge.skippedBelowThreshold} below threshold, ${enqueueBridge.skippedInvalid.length} invalid${enqueueBridge.failures.length > 0 ? `, ${enqueueBridge.failures.length} FAILED` : ''}\n`,
              );
              for (const createdItem of enqueueBridge.created) {
                output.write(
                  `  + ${createdItem.itemRef} <- ${createdItem.ref} (p=${createdItem.probability})\n`,
                );
              }
            }
          }
        } catch (err) {
          emit.fail(err);
        }
      },
    );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
