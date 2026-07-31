import { spawn } from 'node:child_process';
import { platform } from 'node:os';

import type { ExecResult, NodeExecParams } from '@farmslot/protocol';

export type { ExecResult };

export type OutputCallback = (stream: 'stdout' | 'stderr', data: string) => void;

// Resolve the operator's exported login environment once, then reuse it for
// every command. Resource health probes run frequently; starting each command
// as a login shell repeatedly sources expensive dotfiles and can overwhelm the
// machine. Restart the node after changing shell-managed environment/toolchains.
const IS_DARWIN = platform() === 'darwin';
const SHELL = IS_DARWIN ? 'zsh' : 'bash';
const NON_LOGIN_SHELL_ARGS = IS_DARWIN ? ['-f', '-c'] : ['--noprofile', '--norc', '-c'];

// Guarantee system binaries (lsof, ps, sw_vers, ...) stay reachable even when
// an operator's login dotfile hard-overwrites PATH. We append after login init
// so user-preferred toolchains (asdf/homebrew/nvm) still win on ties.
const SYSTEM_PATH_FALLBACK = '/usr/sbin:/usr/bin:/sbin:/bin';

const LOGIN_ENV_MARKER = 'FARMSLOT_LOGIN_ENV_BEGIN';
const SHELL_BOOKKEEPING_ENV = new Set(['SHLVL', 'PWD', 'OLDPWD', '_']);
let loginEnvironmentPromise: Promise<NodeJS.ProcessEnv> | undefined;

export function resolveLoginEnvironment(): Promise<NodeJS.ProcessEnv> {
  loginEnvironmentPromise ??= new Promise((resolve) => {
    const proc = spawn(SHELL, ['-lc', `printf '\\0${LOGIN_ENV_MARKER}\\0'; env -0`], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    // Profiles sometimes print diagnostics. Drain stderr so a noisy profile
    // cannot fill the pipe and deadlock this one-time initialization probe.
    proc.stderr.resume();
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve({ ...process.env, PATH: `${process.env.PATH ?? ''}:${SYSTEM_PATH_FALLBACK}` });
        return;
      }
      const fields = Buffer.concat(stdoutChunks).toString().split('\0');
      const markerIndex = fields.lastIndexOf(LOGIN_ENV_MARKER);
      if (markerIndex < 0) {
        resolve({ ...process.env, PATH: `${process.env.PATH ?? ''}:${SYSTEM_PATH_FALLBACK}` });
        return;
      }
      const loginEnvironment: NodeJS.ProcessEnv = {};
      for (const field of fields.slice(markerIndex + 1)) {
        const separator = field.indexOf('=');
        if (separator <= 0) continue;
        const name = field.slice(0, separator);
        if (SHELL_BOOKKEEPING_ENV.has(name)) continue;
        loginEnvironment[name] = field.slice(separator + 1);
      }
      const loginPath = loginEnvironment.PATH ?? process.env.PATH ?? '';
      resolve({ ...loginEnvironment, PATH: `${loginPath}:${SYSTEM_PATH_FALLBACK}` });
    });
    proc.on('error', () => {
      // Falling back to the inherited environment is correct when the login
      // shell itself cannot start; the fixed suffix keeps core tools reachable.
      resolve({ ...process.env, PATH: `${process.env.PATH ?? ''}:${SYSTEM_PATH_FALLBACK}` });
    });
  });
  return loginEnvironmentPromise;
}

export async function resolveLoginPath(): Promise<string> {
  return (await resolveLoginEnvironment()).PATH ?? SYSTEM_PATH_FALLBACK;
}

export async function exec(params: NodeExecParams, onOutput?: OutputCallback): Promise<ExecResult> {
  const { cwd, timeout, maxBuffer } = params;
  const { FORCE_COLOR: _droppedForceColor, ...envNoForceColor } = process.env;
  void _droppedForceColor;
  const argvMode = 'argv' in params && params.argv !== undefined;
  if (argvMode && params.argv.length === 0) {
    throw new Error('exec argv must contain at least one element');
  }
  const loginEnvironment = await resolveLoginEnvironment();
  const { FORCE_COLOR: _droppedLoginForceColor, ...loginEnvNoForceColor } = loginEnvironment;
  void _droppedLoginForceColor;
  const env: NodeJS.ProcessEnv = argvMode
    ? { ...envNoForceColor, PATH: loginEnvironment.PATH }
    : { ...envNoForceColor, ...loginEnvNoForceColor, PATH: loginEnvironment.PATH };
  if (!argvMode) {
    for (const name of SHELL_BOOKKEEPING_ENV) delete env[name];
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let maxBufferExceeded = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutEscalation: ReturnType<typeof setTimeout> | undefined;

    // Drop FORCE_COLOR so child shells/tools don't emit ANSI escapes when stdout
    // is a pipe. Critical for shell scripts that match command output verbatim —
    // example-mobile's VisionCamera podspec uses `node --print "require.resolve(...)"`
    // and compares the trimmed result to the literal "undefined"; with FORCE_COLOR
    // set the comparison fails, File.dirname returns ".", and pod install dies
    // looking for an unavailable react-native-worklets-core spec. Mirrors the
    // gateway-side fix in core/exec.ts.
    const executable = argvMode ? params.argv[0] : SHELL;
    const spawnArgs = argvMode ? params.argv.slice(1) : [...NON_LOGIN_SHELL_ARGS, params.cmd];
    const proc = spawn(executable, spawnArgs, {
      cwd: cwd ?? process.cwd(),
      env,
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
