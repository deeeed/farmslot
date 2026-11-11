// /bin/ps is setuid on macOS and cannot execute inside a seatbelt. Inspect
// only same-UID processes with libproc + KERN_PROCARGS2, as the gateway does.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

import { usablePython } from './python.mjs';

const MAC_PROCESS_INFO = String.raw`
import ctypes, json, os, struct, sys
class BsdInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        'flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid', 'ruid',
        'rgid', 'svuid', 'svgid', 'rfu')] + [
        ('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)] + [
        (name, ctypes.c_uint32) for name in ('nfiles', 'pgid', 'pjobc', 'tdev', 'tpgid')] + [
        ('nice', ctypes.c_int32), ('sec', ctypes.c_uint64), ('usec', ctypes.c_uint64)]
pid = int(sys.argv[1])
libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
def info():
    value = BsdInfo()
    if libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(value), ctypes.sizeof(value)) != ctypes.sizeof(value):
        raise ProcessLookupError('process is absent or unreadable')
    if value.uid != os.getuid() or value.ruid != os.getuid():
        raise PermissionError('foreign UID')
    return value
try:
    before = info()
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
    argv = [p.decode('utf-8', 'replace') for p in rest.split(b'\0')[:argc]]
    after = info()
    if (before.sec, before.usec) != (after.sec, after.usec):
        raise ProcessLookupError('process identity changed')
    print(json.dumps({'argv': argv, 'pgid': after.pgid, 'state': after.status,
                      'startedAt': str(after.sec) + ':' + str(after.usec)}))
except (OSError, ValueError):
    # Unreadable or vanished identities cannot authorize a signal. No env is emitted.
    print('null')
`;

export function processInfo(pid, { platform = process.platform, python = usablePython } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (platform === 'darwin') {
    const interpreter = python();
    if (!interpreter)
      throw new Error(
        'macOS process inspection requires a usable python3; install Python or Command Line Tools',
      );
    // Expected absent/denied identities are JSON null from the probe. Any
    // interpreter failure must propagate, never masquerade as a foreign PID.
    return JSON.parse(
      execFileSync(interpreter, ['-c', MAC_PROCESS_INFO, String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 2000,
      }),
    );
  }
  try {
    if (platform === 'linux') {
      const root = `/proc/${pid}`;
      if (statSync(root).uid !== process.getuid()) return null;
      const before = readFileSync(`${root}/stat`, 'utf8').split(/.*\) /u)[1].split(' ');
      const argv = readFileSync(`${root}/cmdline`, 'utf8').split('\0').slice(0, -1);
      const after = readFileSync(`${root}/stat`, 'utf8').split(/.*\) /u)[1].split(' ');
      if (before[19] !== after[19]) return null;
      return { argv, pgid: Number(after[2]), state: after[0], startedAt: after[19] };
    }
    const row = execFileSync('ps', ['-ww', '-o', 'pgid=,stat=,lstart=,args=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000,
    }).trim();
    const match = row.match(/^(\d+)\s+(\S+)\s+((?:\S+\s+){4}\S+)\s+(.+)$/u);
    return match
      ? {
          pgid: Number(match[1]),
          state: match[2],
          startedAt: match[3],
          argv: match[4].split(/\s+/u),
        }
      : null;
  } catch (error) {
    // Absent or unreadable processes cannot establish ownership. Native macOS
    // interpreter failures were deliberately handled outside this recovery.
    if (
      error.status === 1 ||
      ['ESRCH', 'EACCES', 'EPERM'].includes(error.code) ||
      (platform === 'linux' && error.code === 'ENOENT')
    )
      return null;
    throw error;
  }
}
