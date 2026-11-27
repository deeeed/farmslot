import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  collectTaskDebrief,
  completeTaskDebrief,
  debriefPath,
  readTaskDebrief,
  renderTaskDebrief,
  resolveDebriefScrubOptions,
  type TaskDebriefOptions,
  writeTaskDebrief,
} from './index.js';

export const TASK_DEBRIEF_CLI_USAGE =
  'handoff debrief prepare|finalize|validate|show <task-dir> [--bound | --export <file>]';

async function readResponse(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > 128 * 1024) throw new Error('Debrief response exceeds 128 KiB.');
    chunks.push(bytes);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export async function runTaskDebriefCli(argv: readonly string[]): Promise<void> {
  const [command, directory, flag, destination, ...extra] = argv;
  if (
    !directory ||
    directory.startsWith('-') ||
    !['prepare', 'finalize', 'show', 'validate'].includes(command ?? '') ||
    extra.length ||
    (flag !== undefined &&
      !(
        (command === 'validate' && flag === '--bound' && destination === undefined) ||
        (command === 'show' && flag === '--export' && destination)
      ))
  )
    throw new Error(TASK_DEBRIEF_CLI_USAGE);
  const options: TaskDebriefOptions = {
    scrub: resolveDebriefScrubOptions(),
    tokens: {
      workspace: path.resolve(directory),
      home: homedir(),
      farmslotHome: process.env.FARMSLOT_HOME,
    },
  };
  if (command === 'prepare') {
    const { requestId, fingerprint, prompt } = collectTaskDebrief(directory, options);
    printJson({ requestId, fingerprint, prompt });
  } else if (command === 'finalize') {
    const response = await readResponse();
    const request = collectTaskDebrief(directory, options);
    const record = completeTaskDebrief(request, response, options);
    writeTaskDebrief(directory, record);
    printJson({ path: debriefPath, debriefId: record.debriefId, outcome: record.outcome });
  } else if (command === 'validate') {
    const record = readTaskDebrief(directory, flag === '--bound' ? options : undefined);
    printJson({
      valid: true,
      binding: flag === '--bound' ? record.identity.binding : 'shape-only',
    });
  } else {
    const markdown = renderTaskDebrief(readTaskDebrief(directory));
    if (destination) writeFileSync(destination, markdown, { flag: 'wx', mode: 0o600 });
    else process.stdout.write(markdown);
  }
}
