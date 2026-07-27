import { spawn } from 'node:child_process';
import { platform } from 'node:os';

import type { ExecResult, NodeExecParams } from '@farmslot/protocol';

export type { ExecResult };

export type OutputCallback = (stream: 'stdout' | 'stderr', data: string) => void;

// macOS: zsh is default shell and typically has asdf/nvm in .zshrc
// Linux: bash with login shell picks up .bashrc/.profile
const SHELL = platform() === 'darwin' ? 'zsh' : 'bash';

// Guarantee system binaries (lsof, ps, sw_vers, ...) stay reachable even when
// an operator's login dotfile hard-overwrites PATH. We append after login init
// so user-preferred toolchains (asdf/homebrew/nvm) still win on ties.
const SYSTEM_PATH_FALLBACK = '/usr/sbin:/usr/bin:/sbin:/bin';

let loginPathPromise: Promise<string> | undefined;

export function resolveLoginPath(): Promise<string> {
  loginPathPromise ??= new Promise((resolve) => {
    const child = spawn(SHELL, ['-lc', 'printf %s "$PATH"'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', () => resolve(process.env.PATH ?? ''));
    child.on('close', (code) => resolve(code === 0 && output ? output : (process.env.PATH ?? '')));
  });
  return loginPathPromise;
}

export async function exec(params: NodeExecParams, onOutput?: OutputCallback): Promise<ExecResult> {
  const hasCmd = typeof params.cmd === 'string';
  const hasArgv = Array.isArray(params.argv) && params.argv.length > 0;
  if (hasCmd === hasArgv) {
    throw new Error('exec requires exactly one of non-empty argv or cmd');
  }
  const loginPath = hasArgv ? await resolveLoginPath() : undefined;
  return new Promise((resolve) => {
    const { cmd, argv, cwd, timeout, maxBuffer } = params;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let maxBufferExceeded = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutEscalation: ReturnType<typeof setTimeout> | undefined;

    const wrapped = `export PATH="$PATH:${SYSTEM_PATH_FALLBACK}"; ${cmd ?? ''}`;
    // Drop FORCE_COLOR so child shells/tools don't emit ANSI escapes when stdout
    // is a pipe. Critical for shell scripts that match command output verbatim —
    // example-mobile's VisionCamera podspec uses `node --print "require.resolve(...)"`
    // and compares the trimmed result to the literal "undefined"; with FORCE_COLOR
    // set the comparison fails, File.dirname returns ".", and pod install dies
    // looking for an unavailable react-native-worklets-core spec. Mirrors the
    // gateway-side fix in core/exec.ts.
    const { FORCE_COLOR: _droppedForceColor, ...envNoForceColor } = process.env;
    void _droppedForceColor;
    const proc = hasArgv
      ? spawn(argv![0], argv!.slice(1), {
          cwd: cwd ?? process.cwd(),
          env: {
            ...envNoForceColor,
            PATH: `${loginPath}:${SYSTEM_PATH_FALLBACK}`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: timeout != null,
        })
      : spawn(SHELL, ['-lc', wrapped], {
          cwd: cwd ?? process.cwd(),
          env: envNoForceColor,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: timeout != null,
        });

    const killProcessTree = (sig: NodeJS.Signals) => {
      if (timeout != null && proc.pid) {
        try {
          process.kill(-proc.pid, sig);
          return;
        } catch (groupError) {
          try {
            proc.kill(sig);
            return;
          } catch (processError) {
            console.warn(
              `[node.exec] ${sig} after process exit: group=${(groupError as Error).message}; process=${(processError as Error).message}`,
            );
            return;
          }
        }
      }
      proc.kill(sig);
    };

    const terminateWithEscalation = () => {
      killProcessTree('SIGTERM');
      timeoutEscalation = setTimeout(() => killProcessTree('SIGKILL'), 5000);
      timeoutEscalation.unref();
    };

    const appendOutput = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const nextOutputBytes = outputBytes + chunk.byteLength;
      let keptChunk = chunk;
      if (maxBuffer != null && nextOutputBytes > maxBuffer) {
        const remaining = Math.max(0, maxBuffer - outputBytes);
        keptChunk = remaining > 0 ? chunk.subarray(0, remaining) : Buffer.alloc(0);
        outputBytes = maxBuffer;
        if (!maxBufferExceeded) {
          maxBufferExceeded = true;
          stderr += `\nmaxBuffer exceeded after ${nextOutputBytes} bytes`;
          terminateWithEscalation();
        }
      } else {
        outputBytes = nextOutputBytes;
      }
      if (keptChunk.byteLength === 0) return;
      const text = keptChunk.toString();
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      onOutput?.(stream, text);
    };

    let stdoutEnded = false;
    let stderrEnded = false;
    let processClosed = false;
    let resolved = false;
    let exitCode = 1;

    const tryResolve = () => {
      if (resolved || !processClosed || !stdoutEnded || !stderrEnded) return;
      resolved = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (timeoutEscalation) clearTimeout(timeoutEscalation);
      resolve({ stdout, stderr, exitCode: timedOut ? 124 : maxBufferExceeded ? 1 : exitCode });
    };

    const markStreamClosed = (stream: 'stdout' | 'stderr') => {
      if (stream === 'stdout') stdoutEnded = true;
      else stderrEnded = true;
      tryResolve();
    };

    proc.stdout.on('data', (chunk: Buffer) => appendOutput('stdout', chunk));
    proc.stdout.on('end', () => markStreamClosed('stdout'));
    proc.stdout.on('close', () => markStreamClosed('stdout'));
    proc.stdout.on('error', (err) => {
      stderr += `\nstdout stream error: ${err.message}`;
      markStreamClosed('stdout');
    });

    proc.stderr.on('data', (chunk: Buffer) => appendOutput('stderr', chunk));
    proc.stderr.on('end', () => markStreamClosed('stderr'));
    proc.stderr.on('close', () => markStreamClosed('stderr'));
    proc.stderr.on('error', (err) => {
      stderr += `\nstderr stream error: ${err.message}`;
      markStreamClosed('stderr');
    });

    proc.on('close', (code) => {
      exitCode = code ?? 1;
      processClosed = true;
      tryResolve();
    });

    proc.on('error', (err) => {
      resolved = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (timeoutEscalation) clearTimeout(timeoutEscalation);
      resolve({ stdout, stderr: stderr + `\nspawn error: ${err.message}`, exitCode: 1 });
    });

    if (timeout != null) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        stderr += `\ncommand timed out after ${timeout}ms`;
        terminateWithEscalation();
      }, timeout);
      timeoutTimer.unref();
    }
  });
}
