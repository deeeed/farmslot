#!/usr/bin/env node

import { closeoutLearningPackage } from '../closeout/index.js';

interface CliOptions {
  taskDir?: string;
  configPath?: string;
  metadataPath?: string;
  share: boolean;
  json: boolean;
}

function usage(): string {
  return `Usage:
  handoff closeout <task-dir> [--config <file>] [--metadata <file>] [--json]
  handoff closeout <task-dir> --share [--config <file>] [--json]

closeout stages a scrubbed Learning Package locally. --share writes only after
explicit per-call human approval.`;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv[0] !== 'closeout') throw new Error(usage());
  const options: CliOptions = { share: false, json: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--share') {
      options.share = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--config' || arg === '--metadata') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.\n${usage()}`);
      index += 1;
      if (arg === '--config') options.configPath = value;
      if (arg === '--metadata') options.metadataPath = value;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}\n${usage()}`);
    if (options.taskDir !== undefined) {
      throw new Error(`Unexpected positional argument: ${arg}\n${usage()}`);
    }
    options.taskDir = arg;
  }
  if (!options.taskDir) throw new Error(`Missing <task-dir>.\n${usage()}`);
  return options;
}

function printHuman(result: ReturnType<typeof closeoutLearningPackage>): void {
  if (result.status === 'blocked') {
    process.stderr.write(
      `Learning package blocked by the scrub gate.\nQuarantine: ${result.quarantineDir}\n`,
    );
    return;
  }
  if (result.status === 'staged') {
    process.stdout.write(
      `Learning package staged: ${result.packageDir}\n` +
        `Destination path: ${result.wouldWritePath}\n` +
        'No remote write occurred.\n' +
        'Next: after explicit human approval, rerun with --share.\n',
    );
    return;
  }
  if (result.status === 'already-shared') {
    process.stdout.write(
      `Learning package already committed: ${result.destinationPath}\n` +
        (result.pushed
          ? 'Push: complete\n'
          : result.pushError
            ? `Push: failed (${result.pushError})\nNext: rerun this approved share command to retry.\n`
            : 'Push: skipped (destination has no remote)\n'),
    );
    return;
  }
  process.stdout.write(
    `Learning package written: ${result.destinationPath}\nCommit: ${result.commitSha}\n` +
      (result.pushed
        ? 'Push: complete\n'
        : result.pushError
          ? `Push: failed (${result.pushError})\nNext: retry git push from the destination clone.\n`
          : 'Push: skipped (destination has no remote)\n'),
  );
}

function main(): void {
  let options: CliOptions | undefined;
  const jsonRequested = process.argv.slice(2).includes('--json');
  try {
    options = parseArgs(process.argv.slice(2));
    const result = closeoutLearningPackage({
      taskDir: options.taskDir!,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.metadataPath === undefined ? {} : { metadataPath: options.metadataPath }),
      share: options.share,
    });
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printHuman(result);
    if (result.status === 'blocked') process.exitCode = 1;
    if ((result.status === 'written' || result.status === 'already-shared') && result.pushError) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = (error as Error).message;
    if (options?.json || jsonRequested) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: 'error',
            error: {
              code: 'HANDOFF_CLOSEOUT_FAILED',
              message,
              userAction: message.includes('Next:')
                ? message.split('Next:').at(-1)?.trim()
                : usage(),
            },
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stderr.write(`handoff closeout failed: ${message}\n`);
    }
    process.exitCode = 1;
  }
}

main();
