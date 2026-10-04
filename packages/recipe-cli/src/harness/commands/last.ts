// last — the resumability journal's most recent command for a checkout.

import { readCommandJournal } from '../command-journal.js';
import { harnessHost } from '../host.js';
import {
  optionFlag,
  optionString,
  type ParsedArgs,
  shellQuote,
  targetPath,
} from '../parse-args.js';
import { EXIT } from '../shared.js';

export function handleLast({ options }: ParsedArgs): number {
  const { name } = harnessHost();
  const target = targetPath(options);
  const { file, record } = readCommandJournal(target, optionString(options, 'runtimeDir'));
  const json = optionFlag(options, 'json');
  if (!record) {
    const message = `no resumability journal exists for ${target}`;
    const userAction = `run a proof or runtime command in this checkout, then re-run ${name} last --json`;
    if (json) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            command: 'last',
            target,
            journalPath: file,
            status: 'fail',
            exitCode: EXIT.runtime,
            error: { code: 'LAST_NOT_FOUND', message, userAction },
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`✗ ${name} last: ${message}\n  Next: ${userAction}`);
    }
    return EXIT.runtime;
  }
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'last',
          target,
          journalPath: file,
          status: 'pass',
          exitCode: EXIT.ok,
          last: record,
        },
        null,
        2,
      ),
    );
  } else {
    const end = record.finishedAt ?? 'still running or interrupted';
    console.log(
      `${record.verdict.toUpperCase()} ${record.command} (exit ${record.exitCode ?? 'pending'})`,
    );
    console.log(
      `command: ${name} ${record.command}${record.args.length > 0 ? ` ${record.args.map(shellQuote).join(' ')}` : ''}`,
    );
    console.log(`started: ${record.startedAt}`);
    console.log(`finished: ${end}`);
    if (record.evidencePaths.length > 0) {
      console.log('evidence:');
      for (const evidence of record.evidencePaths) console.log(`  ${evidence}`);
    } else {
      console.log('evidence: none recorded');
    }
    console.log(`journal: ${file}`);
  }
  return EXIT.ok;
}
