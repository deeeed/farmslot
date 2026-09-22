// Python is also used by the native session probes. flock is released by the OS
// on process exit, including crashes; persistent lock files are never removed.
const trustScript = String.raw`
import fcntl, json, os, sys, tempfile
file = os.path.realpath(os.path.join(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~'), '.claude.json'))
with os.fdopen(os.open(file + '.farmslot-review.lock', os.O_CREAT | os.O_RDWR, 0o600), 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        with open(file) as source:
            data = json.load(source)
    except FileNotFoundError:
        data = {}
    except json.JSONDecodeError:
        raise RuntimeError('Invalid Claude configuration JSON') from None
    if not isinstance(data, dict) or not isinstance(data.get('projects', {}), dict):
        raise RuntimeError('Invalid Claude configuration')
    projects = data.setdefault('projects', {})
    record = projects.setdefault(sys.argv[1], {})
    if not isinstance(record, dict):
        raise RuntimeError('Invalid Claude workspace configuration')
    record['hasTrustDialogAccepted'] = True
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=os.path.dirname(file), prefix='.claude-review-', delete=False) as output:
            temporary = output.name
            json.dump(data, output, indent=2)
        os.replace(temporary, file)
        temporary = None
    finally:
        if temporary is not None:
            os.unlink(temporary)
`;

export function claudeReviewWorkspaceTrustSeed(checkoutPath: string): string {
  return `require('node:child_process').execFileSync('python3', ['-c', ${JSON.stringify(trustScript)}, ${JSON.stringify(checkoutPath)}], {stdio:'inherit'});`;
}
