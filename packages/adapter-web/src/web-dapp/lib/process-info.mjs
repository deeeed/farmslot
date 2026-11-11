// /bin/ps is setuid on macOS and cannot execute inside a seatbelt. Inspect
// only same-UID processes with libproc + KERN_PROCARGS2, as the gateway does.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

import { NATIVE_PROC_ARGS, runNativeProcessProbe } from './native-proc-args.mjs';

const MAC_PROCESS_INFO = String.raw`${NATIVE_PROC_ARGS}
import os
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
    argv = read_native_proc_args(pid)['argv']
    after = info()
    if (before.sec, before.usec) != (after.sec, after.usec):
        raise ProcessLookupError('process identity changed')
    print(json.dumps({'argv': argv, 'pgid': after.pgid, 'state': after.status,
                      'startedAt': str(after.sec) + ':' + str(after.usec)}))
except (OSError, ValueError):
    # Unreadable or vanished identities cannot authorize a signal. No env is emitted.
    print('null')
`;

export function processInfo(pid, { platform = process.platform, python } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (platform === 'darwin') return runNativeProcessProbe(MAC_PROCESS_INFO, pid, { python });
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
