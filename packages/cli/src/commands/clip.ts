// clip.ts — `farmslot clip`: push copy-ready text or a link to the farm's Companion clipboard.
import { execFileSync } from 'node:child_process';

import type { Command } from 'commander';

import {
  CLIP_TEXT_MAX_BYTES,
  clipLinkUrl,
  type ClipPushParams,
  type ClipPushResult,
  Methods,
} from '@farmslot/protocol';

import { resolveContext } from '../context.js';
import { createEmitter } from '../envelope.js';

export interface ClipOptions {
  text?: string;
  link?: string;
  label?: string;
}

function clipError(message: string, userAction: string): Error {
  return Object.assign(new Error(message), { code: 'INVALID_CLIP', userAction });
}

/** Reads stdin up to one byte past the cap, so an oversized pipe fails without buffering it all. */
export async function readClipStdin(stdin: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    chunks.push(buffer);
    bytes += buffer.byteLength;
    if (bytes > CLIP_TEXT_MAX_BYTES) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function clipPushParams(
  options: ClipOptions,
  stdinText: string | undefined,
  source?: string,
): ClipPushParams {
  if (options.link !== undefined && (options.text !== undefined || stdinText !== undefined))
    throw clipError('--link takes no other text', 'Pass either --link <url> or --text/stdin.');
  const kind = options.link !== undefined ? 'link' : 'text';
  const text = options.link ?? options.text ?? stdinText;
  if (text === undefined || !text.trim())
    throw clipError('Nothing to clip', 'Pass --text "...", --link <url>, or pipe text on stdin.');
  if (kind === 'link' && !clipLinkUrl(text))
    throw clipError(`Not an http(s) URL: ${text}`, 'Pass one full URL to --link.');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > CLIP_TEXT_MAX_BYTES)
    throw clipError(
      `Clip text is over the ${CLIP_TEXT_MAX_BYTES}-byte limit`,
      'Clip a shorter excerpt, or link to the full text.',
    );
  return {
    text,
    ...(kind === 'link' ? { kind } : {}),
    ...(options.label ? { label: options.label } : {}),
    ...(source ? { source } : {}),
  };
}

/** The tmux session this command runs in, so a clip says which lane sent it. */
function tmuxSession(): string | undefined {
  if (!process.env.TMUX) return undefined;
  const target = process.env.TMUX_PANE ? ['-t', process.env.TMUX_PANE] : [];
  const name = execFileSync('tmux', ['display-message', '-p', ...target, '#S'], {
    encoding: 'utf8',
  }).trim();
  return name || undefined;
}

export function registerClipCommand(program: Command): void {
  program
    .command('clip')
    .description('Send copy-ready text or a link to the Companion clipboard')
    .option('--text <text>', 'Text to clip (default: read stdin)')
    .option('--link <url>', 'Clip one URL; clients show it as a tappable link')
    .option('--label <label>', 'Short label shown above the clip')
    .action(async (options: ClipOptions, command: Command) => {
      const { client, output } = resolveContext(command);
      const emit = createEmitter(output, command);
      try {
        const stdinText =
          options.text === undefined && options.link === undefined && !process.stdin.isTTY
            ? await readClipStdin(process.stdin)
            : undefined;
        const params = clipPushParams(options, stdinText, tmuxSession());
        const result = await client.call<ClipPushResult>(Methods.CLIP_PUSH, params);
        if (emit.machine) emit.ok(result);
        else
          output.write(
            `Clipped ${result.clip.label ? `"${result.clip.label}" ` : ''}(${Buffer.byteLength(result.clip.text, 'utf8')} bytes)\n`,
          );
      } catch (error) {
        emit.fail(error);
      }
    });
}
