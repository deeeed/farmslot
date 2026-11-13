// Shared KERN_PROCARGS2 reader. Environment decoding is opt-in; ownership
// inspection never returns or decodes a process's environment.
import { execFileSync } from 'node:child_process';

import { PYTHON_TIMEOUT_MS, usablePython } from './python.mjs';

export const NATIVE_PROC_ARGS = String.raw`
import ctypes, json, struct, sys
def read_native_proc_args(pid, include_environment=False):
    libc = ctypes.CDLL(None, use_errno=True)
    argmax = ctypes.c_int()
    size = ctypes.c_size_t(ctypes.sizeof(argmax))
    if libc.sysctl((ctypes.c_int * 2)(1, 8), 2, ctypes.byref(argmax), ctypes.byref(size), None, 0):
        raise OSError('cannot read argument limit')
    buf = ctypes.create_string_buffer(argmax.value)
    size = ctypes.c_size_t(argmax.value)
    if libc.sysctl((ctypes.c_int * 3)(1, 49, pid), 3, buf, ctypes.byref(size), None, 0):
        raise ProcessLookupError('process arguments are absent or unreadable')
    raw = buf.raw[:size.value]
    argc = struct.unpack('i', raw[:4])[0]
    rest = raw[4:]
    rest = rest[rest.index(b'\0') + 1:].lstrip(b'\0')
    parts = rest.split(b'\0')
    result = {'argv': [p.decode('utf-8', 'replace') for p in parts[:argc]]}
    if include_environment:
        env = []
        for part in parts[argc:]:
            if not part:
                break
            env.append(part.decode('utf-8', 'replace'))
        result['env'] = env
    return result
`;

export function runNativeProcessProbe(source, pid, { python = usablePython } = {}) {
  const interpreter = python();
  if (!interpreter)
    throw new Error(
      'macOS process inspection requires a usable python3; install Python or Command Line Tools',
    );
  // Absent/denied identities are JSON null. Interpreter failures must propagate.
  return JSON.parse(
    execFileSync(interpreter, ['-c', source, String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PYTHON_TIMEOUT_MS,
    }),
  );
}

export function readNativeProcArgs(pid, { includeEnvironment = false } = {}) {
  if (process.platform !== 'darwin') return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return runNativeProcessProbe(
    `${NATIVE_PROC_ARGS}
try:
    print(json.dumps(read_native_proc_args(int(sys.argv[1]), ${includeEnvironment ? 'True' : 'False'})))
except (OSError, ValueError):
    print('null')
`,
    pid,
  );
}
