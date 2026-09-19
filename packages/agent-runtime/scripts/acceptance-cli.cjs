#!/usr/bin/env node
/**
 * `farmslot-agent ac`: record and read the acceptance-criteria ledger
 * (`artifacts/acceptance-status.json`), the one writer of that file.
 *
 * The ids come from `inputs/handoff.json`, which task init fills from the
 * criteria it received; this CLI never invents an id or a criterion text.
 */
const fs = require('node:fs');
const path = require('node:path');

const {
  ACCEPTANCE_PROOF_MODES,
  ACCEPTANCE_VERDICTS,
  AcceptanceRefusal,
  acceptanceStatusList,
  renderAcceptanceCoverage,
  readAcceptanceLedger,
  setAcceptanceVerdict,
} = require('./acceptance-ledger.cjs');

const HANDOFF_INPUT = path.join('inputs', 'handoff.json');

const USAGE = [
  'usage: farmslot-agent ac <command> [--task-dir <path>]',
  '',
  `  ac set <AC-N> <${ACCEPTANCE_VERDICTS.join('|')}> [options]`,
  `      --proof-mode <${ACCEPTANCE_PROOF_MODES.join('|')}>   how the criterion is proven`,
  '      --evidence <task-dir relative path>   repeatable; the file must exist',
  '      --recipe-node <id>                    repeatable; recipe node proving it',
  '      --note "..."                          why, especially for untestable',
  '  ac list      every criterion with its current verdict (JSON, verdict null when unrecorded)',
  '  ac render    the coverage table, ending with the Overall recipe coverage line',
  '',
  'The task dir comes from --task-dir, else $TASK_DIR, else the current directory.',
].join('\n');

function usage(exitCode = 0) {
  (exitCode === 0 ? console.log : console.error)(USAGE);
  process.exit(exitCode);
}

function takeValue(args, index, flag) {
  const value = args[index + 1];
  if (value === undefined) throw new AcceptanceRefusal(`${flag} requires a value`, 2);
  return value;
}

function parseArgs(argv) {
  const opts = {
    taskDir: null,
    positional: [],
    proofMode: undefined,
    evidence: [],
    recipeNodes: [],
    note: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--task-dir') opts.taskDir = takeValue(argv, i++, arg);
    else if (arg === '--proof-mode') opts.proofMode = takeValue(argv, i++, arg);
    else if (arg === '--evidence') opts.evidence.push(takeValue(argv, i++, arg));
    else if (arg === '--recipe-node') opts.recipeNodes.push(takeValue(argv, i++, arg));
    else if (arg === '--note') opts.note = takeValue(argv, i++, arg);
    else if (arg === '-h' || arg === '--help') usage(0);
    else if (arg.startsWith('-')) throw new AcceptanceRefusal(`unknown option ${arg}`, 2);
    else opts.positional.push(arg);
  }
  return opts;
}

function resolveTaskDir(explicit) {
  const candidate = path.resolve(explicit ?? process.env.TASK_DIR ?? process.cwd());
  if (!fs.existsSync(path.join(candidate, HANDOFF_INPUT))) {
    throw new AcceptanceRefusal(
      `${candidate} is not a task directory (no ${HANDOFF_INPUT}); pass --task-dir <path>`,
    );
  }
  return candidate;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '-h' || command === '--help') usage(command ? 0 : 2);
  const opts = parseArgs(rest);
  const taskDir = resolveTaskDir(opts.taskDir);

  if (command === 'set') {
    const [id, verdict, ...extra] = opts.positional;
    if (!id || !verdict || extra.length > 0) {
      throw new AcceptanceRefusal('usage: ac set <AC-N> <verdict> [options]', 2);
    }
    const ledger = setAcceptanceVerdict(taskDir, {
      id,
      verdict,
      proofMode: opts.proofMode,
      evidence: opts.evidence,
      recipeNodes: opts.recipeNodes,
      note: opts.note,
    });
    const entry = ledger.criteria.find((criterion) => criterion.id === id);
    console.log(`${id}: ${entry.verdict}${entry.proofMode ? ` (${entry.proofMode})` : ''}`);
    return;
  }
  if (opts.positional.length > 0) {
    throw new AcceptanceRefusal(`ac ${command} takes no positional arguments`, 2);
  }
  if (command === 'list') {
    process.stdout.write(`${JSON.stringify(acceptanceStatusList(taskDir), null, 2)}\n`);
    return;
  }
  if (command === 'render') {
    const ledger = readAcceptanceLedger(taskDir);
    if (!ledger) {
      throw new AcceptanceRefusal(
        'no acceptance ledger yet — record verdicts with `farmslot-agent ac set <id> <verdict>`',
      );
    }
    process.stdout.write(renderAcceptanceCoverage(ledger));
    return;
  }
  usage(2);
}

// Only as a command: this file is a published package export, so requiring it
// (a consumer checking the entry point resolves) must not run a command.
if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error instanceof AcceptanceRefusal ? error.code : 1);
  }
}

module.exports = { main };
