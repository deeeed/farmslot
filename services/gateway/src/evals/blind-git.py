"""Gateway-owned Git isolation for one blind trial; sent to the node on stdin."""
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys

os.umask(0o077)


def git(repo, *args, git_dir=None, check=True, input=None):
    command = ['git', '-C', str(repo)]
    if git_dir:
        command += ['--git-dir=' + str(git_dir), '--work-tree=' + str(repo)]
    result = subprocess.run(command + list(args), input=input, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(result.stderr.decode(errors='replace').strip() or 'Git operation failed')
    return result


def save(path, value):
    temporary = path.with_suffix('.pending')
    temporary.write_text(json.dumps(value) + '\n')
    temporary.replace(path)


def pack_into(repo, directory, arguments, source_file):
    command = ['git', '-C', str(repo), 'pack-objects', '--quiet', '--stdout'] + arguments
    destination = ['git', '-C', str(repo), '--git-dir=' + str(directory), 'index-pack', '--stdin']
    with source_file.open('rb') as source:
        with subprocess.Popen(command, stdin=source, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE) as pack:
            indexed = subprocess.run(destination, stdin=pack.stdout, capture_output=True)
            pack.stdout.close()
            error = pack.stderr.read()
            code = pack.wait()
            if code or indexed.returncode:
                raise RuntimeError((indexed.stderr or error).decode(errors='replace').strip()
                                   or 'Blind trial object transfer failed')


# The worker starts without GitHub credentials, inside a sandbox (blind-git.ts).
# These stand-ins refuse its gh, credential-helper and SSH-transport calls and record them.
BOUNDARY_SCRIPT = '''#!/bin/sh
[ "${0##*/}" = gh ] && set -- gh "$@"
[ "$1 $2" = 'credential get' ] && set -- "$@" "$(sed -n 's/^host=//p')"
printf '%s\\n' "$*" >> ATTEMPTS
echo 'GitHub access is unavailable in this blind eval trial.' >&2
exit 1
'''
SANDBOX = '/usr/bin/sandbox-exec'
SANDBOX_REQUIRED = 'Blind eval trials need macOS sandbox-exec on the slot node; refusing an unsandboxed worker'


def require_sandbox():
    if not os.access(SANDBOX, os.X_OK):
        raise RuntimeError(SANDBOX_REQUIRED)


def sandbox_profile(spec, capsule):
    # Deny reads of other slot checkouts, the original checkout a linked worktree
    # shares objects with, every blind capsule except this boundary, and the
    # GitHub CLI login. Later rules take precedence.
    repo = Path(spec['repo']).resolve()
    checkouts = [Path(os.path.expanduser(path)).resolve() for path in spec.get('siblingRepos', [])]
    state = json.loads((capsule / 'state.json').read_text())
    if not state['originalIsDirectory']:
        common = Path(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir',
                          git_dir=state['originalDirectory']).stdout.decode().strip()).resolve()
        checkouts += [common, common.parent] if common.name == '.git' else [common]
    denied = [path for path in checkouts if path != repo and path not in repo.parents]
    capsules = {path.parent / '.farmslot-blind-evals' for path in [repo] + checkouts}
    denied += sorted(capsules) + [(Path.home() / '.config' / 'gh').resolve()]
    quote = lambda path: json.dumps(str(path), ensure_ascii=False)
    return '\n'.join(['(version 1)', '(allow default)',
                      '(deny file-read* ' + ' '.join('(subpath %s)' % quote(path) for path in denied) + ')',
                      '(allow file-read* (subpath %s))' % quote((capsule / 'boundary').resolve()), ''])


def prepare_boundary(spec, capsule):
    require_sandbox()
    root = capsule / 'boundary'
    (root / 'gh-config').mkdir(parents=True, exist_ok=True)
    (root / 'bin').mkdir(exist_ok=True)
    script = BOUNDARY_SCRIPT.replace('ATTEMPTS', shlex.quote(str(root / 'attempts.log')))
    for name in ['gh', 'deny']:
        (root / 'bin' / name).write_text(script)
        (root / 'bin' / name).chmod(0o700)
    (root / 'sandbox.sb').write_text(sandbox_profile(spec, capsule))
    checked = subprocess.run([SANDBOX, '-f', str(root / 'sandbox.sb'), '/usr/bin/true'], capture_output=True)
    if checked.returncode:
        raise RuntimeError(SANDBOX_REQUIRED + ': ' + checked.stderr.decode(errors='replace').strip())


def boundary(spec):
    prepare_boundary(spec, Path(spec['capsule']))
    return verify(spec)


def verify(spec, worker_boundary=True):
    repo, root = Path(spec['repo']), Path(spec['capsule']) / 'boundary'
    if git(repo, 'config', '--get', 'farmslot.blindRun').stdout.decode().strip() != spec['runId']:
        raise RuntimeError('Blind trial Git ownership does not match')
    if (repo / '.git').is_symlink() or not (repo / '.git').is_dir():
        raise RuntimeError('Blind trial requires an independent Git directory')
    if (repo / '.git/objects/info/alternates').exists():
        raise RuntimeError('Blind trial Git alternates are forbidden')
    if (repo / '.git/shallow').read_text().strip() != spec['baseSha']:
        raise RuntimeError('Blind trial shallow base changed')
    if git(repo, 'config', '--get-regexp', r'^remote\..*\.url$', check=False).returncode == 0:
        raise RuntimeError('Blind trial remote URLs are forbidden')
    if git(repo, 'config', '--get', 'protocol.allow').stdout.decode().strip() != 'never':
        raise RuntimeError('Blind trial fetch is not disabled')
    for commit in spec['referenceCommits']:
        if git(repo, 'cat-file', '-e', commit + '^{commit}', check=False).returncode == 0:
            raise RuntimeError('Reference objects are available in the blind trial')
    if worker_boundary and not all((root / name).is_file() for name in ['bin/gh', 'bin/deny', 'sandbox.sb']):
        raise RuntimeError('Blind trial worker boundary is missing')
    attempts = root / 'attempts.log'
    attempt = attempts.read_text(errors='replace').strip().split('\n')[0] if attempts.exists() else ''
    receipt = {'status': 'isolated', 'baseSha': spec['baseSha'], 'runId': spec['runId']}
    return {**receipt, 'githubAttempt': attempt[:500]} if attempt else receipt


def copy_local_commit_settings(repo, source, destination):
    # Retain repository-local identity/signing policy, without copying remotes,
    # fetch configuration or includes that could reopen the reference store.
    for key in ['user.name', 'user.email', 'user.signingkey', 'commit.gpgsign', 'gpg.format', 'gpg.program']:
        result = git(repo, 'config', '--local', '--get', key, git_dir=source, check=False)
        if result.returncode == 1:
            continue
        if result.returncode:
            raise RuntimeError('Cannot read the original commit configuration')
        git(repo, 'config', '--local', key, result.stdout.decode().rstrip('\n'), git_dir=destination)


def isolate(spec):
    repo, capsule = Path(spec['repo']), Path(spec['capsule'])
    journal = capsule / 'state.json'
    if journal.exists():
        state = json.loads(journal.read_text())
        if any(state.get(key) != spec.get(key) for key in ['runId', 'repo', 'baseSha', 'branch', 'slotId', 'slotEpoch', 'referenceCommits']):
            raise RuntimeError('Blind trial capsule belongs to another execution')
        if state['phase'] != 'isolated':
            raise RuntimeError('Blind trial capsule requires restoration before preparation')
        source = capsule / 'original.entry' if state['originalIsDirectory'] else Path(state['originalDirectory'])
        copy_local_commit_settings(repo, source, repo / '.git')
        return verify(spec, worker_boundary=False)
    if not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', spec['baseSha']):
        raise RuntimeError('Blind trial requires a full base commit')
    git(repo, 'check-ref-format', '--branch', spec['branch'])
    git(repo, 'cat-file', '-e', spec['baseSha'] + '^{commit}')
    if git(repo, 'status', '--porcelain').stdout.strip():
        raise RuntimeError('Blind trial requires a clean checkout before isolation')
    if git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/' + spec['branch'], check=False).returncode == 0:
        raise RuntimeError('Blind trial branch already exists')
    for commit in spec['referenceCommits']:
        if commit == spec['baseSha'] or git(repo, 'merge-base', '--is-ancestor', commit,
                                           spec['baseSha'], check=False).returncode == 0:
            raise RuntimeError('Blind trial base contains the reference answer')
    capsule.mkdir(parents=True, mode=0o700)
    prepared, original = capsule / 'prepared.git', capsule / 'original.entry'
    original_directory = Path(git(repo, 'rev-parse', '--absolute-git-dir').stdout.decode().strip())
    state = {**spec, 'phase': 'preparing',
             'originalDirectory': str(original_directory),
             'originalHead': git(repo, 'rev-parse', 'HEAD').stdout.decode().strip(),
             'originalIsDirectory': (repo / '.git').is_dir()}
    save(journal, state)
    git(repo, 'init', '-q', '--bare', '--template=', '--object-format=' + ('sha256' if len(spec['baseSha']) == 64 else 'sha1'), str(prepared))
    objects = capsule / 'base.objects'
    objects.write_bytes(git(repo, 'rev-list', '--objects', '--no-object-names', '--no-walk',
                            spec['baseSha']).stdout)
    pack_into(repo, prepared, [], objects)
    git(repo, 'config', 'core.bare', 'false', git_dir=prepared)
    git(repo, 'config', 'core.worktree', str(repo), git_dir=prepared)
    git(repo, 'config', 'protocol.allow', 'never', git_dir=prepared)
    git(repo, 'config', 'farmslot.blindRun', spec['runId'], git_dir=prepared)
    copy_local_commit_settings(repo, original_directory, prepared)
    (prepared / 'shallow').write_text(spec['baseSha'] + '\n')
    git(repo, 'update-ref', 'refs/heads/' + spec['branch'], spec['baseSha'], git_dir=prepared)
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/' + spec['branch'], git_dir=prepared)
    git(repo, 'read-tree', spec['baseSha'], git_dir=prepared)
    try:
        (repo / '.git').rename(original)
        source = original if state['originalIsDirectory'] else original_directory
        # The original index knows which later tracked files must disappear.
        git(repo, 'read-tree', '--reset', '-u', spec['baseSha'], git_dir=source)
        prepared.rename(repo / '.git')
        result = verify(spec, worker_boundary=False)
        state['phase'] = 'isolated'
        save(journal, state)
        return result
    except BaseException:
        if original.exists():
            if (repo / '.git').exists():
                (repo / '.git').rename(capsule / 'failed.git')
            original.rename(repo / '.git')
            git(repo, 'reset', '--hard', state['originalHead'])
        state['phase'] = 'restored'
        save(journal, state)
        raise


def restore(spec):
    repo, capsule = Path(spec['repo']), Path(spec['capsule'])
    journal = capsule / 'state.json'
    if not journal.exists():
        if git(repo, 'config', '--get', 'farmslot.blindRun', check=False).stdout.strip():
            raise RuntimeError('Blind trial restoration record is missing')
        return {'status': 'absent'}
    state = json.loads(journal.read_text())
    if any(state.get(key) != spec.get(key) for key in ['runId', 'repo', 'baseSha', 'branch', 'slotId', 'slotEpoch', 'referenceCommits']):
        raise RuntimeError('Blind trial restoration owner does not match')
    if state['phase'] == 'restored':
        return {'status': 'restored', 'runId': spec['runId']}
    original = capsule / 'original.entry'
    if state['phase'] == 'preparing':
        if original.exists():
            if (repo / '.git').exists():
                if git(repo, 'config', '--get', 'farmslot.blindRun', check=False).stdout.decode().strip() != spec['runId']:
                    raise RuntimeError('Blind trial interrupted preparation lost Git ownership')
                (repo / '.git').rename(capsule / 'interrupted.git')
            original.rename(repo / '.git')
            git(repo, 'reset', '--hard', state['originalHead'])
        elif git(repo, 'config', '--get', 'farmslot.blindRun', check=False).stdout.strip():
            raise RuntimeError('Blind trial interrupted preparation lost original Git metadata')
        state['phase'] = 'restored'
        save(journal, state)
        return {'status': 'restored', 'runId': spec['runId']}
    retained = capsule / 'candidate.git'
    if state['phase'] != 'restoring':
        if not original.exists():
            raise RuntimeError('Blind trial original Git metadata is missing')
        if git(repo, 'config', '--get', 'farmslot.blindRun').stdout.decode().strip() != spec['runId']:
            raise RuntimeError('Blind trial restoration lost Git ownership')
        source = original if state['originalIsDirectory'] else Path(state['originalDirectory'])
        head = git(repo, 'rev-parse', 'HEAD').stdout.decode().strip()
        if head != spec['baseSha']:
            commits = capsule / 'candidate.objects'
            commits.write_text(head + '\n^' + spec['baseSha'] + '\n')
            pack_into(repo, source, ['--revs'], commits)
        branch = 'refs/heads/' + spec['branch']
        current = git(repo, 'rev-parse', '--verify', branch, git_dir=source, check=False)
        if current.returncode == 0:
            if current.stdout.decode().strip() != head:
                raise RuntimeError('Blind candidate branch changed during restoration')
        else:
            git(repo, 'update-ref', branch, head, '0' * len(head), git_dir=source)
        state['phase'] = 'restoring'
        state['candidateHead'] = head
        save(journal, state)
    head = state['candidateHead']
    if original.exists():
        if (repo / '.git').exists():
            if git(repo, 'config', '--get', 'farmslot.blindRun').stdout.decode().strip() != spec['runId']:
                raise RuntimeError('Blind trial interrupted restoration lost Git ownership')
            (repo / '.git').rename(retained)
        original.rename(repo / '.git')
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/' + spec['branch'])
    if git(repo, 'rev-parse', 'HEAD').stdout.decode().strip() != head:
        raise RuntimeError('Restored candidate branch does not match its retained head')
    directory = Path(git(repo, 'rev-parse', '--absolute-git-dir').stdout.decode().strip())
    if retained.exists():
        shutil.copyfile(retained / 'index', directory / 'index')
        shutil.rmtree(retained)
    state['phase'] = 'restored'
    save(journal, state)
    for name in ['base.objects', 'candidate.objects']:
        (capsule / name).unlink(missing_ok=True)
    return {'status': 'restored', 'runId': spec['runId'], 'headSha': head}


if __name__ == '__main__':
    request = json.loads(sys.argv[1])
    action = request.pop('action')
    if action == 'plan':
        capsule = Path(request['repo']).resolve().parent / '.farmslot-blind-evals' / request['slotId'] / (request['runId'] + '-' + str(request['slotEpoch']))
        result = {'status': 'planned', 'capsule': str(capsule)}
    else:
        result = {'isolate': isolate, 'boundary': boundary, 'verify': verify, 'restore': restore}[action](request)
    print(json.dumps(result))
