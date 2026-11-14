"""Gateway-owned Git isolation for one blind trial; sent to the node on stdin."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

os.umask(0o077)
# buildBlindGitCommand inherits maintenance suppression from farm-git.ts.
# Keep submodule traversal explicit and avoid optional index writes while reading
# retained stores; apply these controls to every Python Git subprocess.
GIT = ['git', '-c', 'submodule.recurse=false', '--no-optional-locks']


def git(repo, *args, git_dir=None, check=True, input=None):
    command = GIT + ['-C', str(repo)]
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


def pack_into(repo, directory, arguments, source_file, git_dir=None):
    command = GIT + ['-C', str(repo)]
    if git_dir:
        command += ['--git-dir=' + str(git_dir), '--work-tree=' + str(repo)]
    command += ['pack-objects', '--quiet', '--stdout'] + arguments
    destination = GIT + ['-C', str(repo), '--git-dir=' + str(directory),
                         '--work-tree=' + str(repo), 'index-pack', '--stdin']
    with source_file.open('rb') as source:
        with subprocess.Popen(command, stdin=source, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE) as pack:
            indexed = subprocess.run(destination, stdin=pack.stdout, capture_output=True)
            pack.stdout.close()
            error = pack.stderr.read()
            code = pack.wait()
            if code or indexed.returncode:
                raise RuntimeError((error or indexed.stderr).decode(errors='replace').strip()
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
# ps prints other processes' environments with -E, BSD-style e, or legacy -e.
# Refuse those (and -e, use -A) before any option value; values are skipped.
PS_WRAPPER = '''#!/bin/sh
refuse() { echo 'ps: environment output is unavailable in this blind eval trial.' >&2; exit 1; }
value=; first=1
for arg in "$@"; do
  if [ -n "$value" ]; then value=; first=; continue; fi
  case "$arg" in
    --) first=; continue ;;
    -*) flags=${arg#-} ;;
    *) [ -n "$first" ] || { case "$arg" in *[eE]*) refuse ;; esac; continue; }
       flags=$arg ;;
  esac
  first=
  while [ -n "$flags" ]; do
    letter=${flags%"${flags#?}"}; flags=${flags#?}
    case "$letter" in
      e|E) refuse ;;
      O|o|G|g|p|t|U|u) [ -n "$flags" ] || value=1; flags= ;;
    esac
  done
done
COMMAND_MODE=unix2003 exec REAL_PS "$@"
'''
SANDBOX = '/usr/bin/sandbox-exec'
SANDBOX_REQUIRED = 'Blind eval trials need macOS sandbox-exec on the slot node; refusing an unsandboxed worker'
NODE_INSTALLATIONS = ['farmslot-node', 'farmslot-node-dev']


def require_sandbox():
    if not os.access(SANDBOX, os.X_OK):
        raise RuntimeError(SANDBOX_REQUIRED)


def live_tmux_sockets():
    # Read kernel metadata only; never connect to or issue commands to a server.
    result = subprocess.run(['/usr/sbin/lsof', '-nP', '-a', '-U', '-u', str(os.getuid()),
                             '-c', 'tmux', '-Fn'], capture_output=True, text=True, timeout=5)
    if result.returncode not in (0, 1):
        raise RuntimeError('Cannot discover tmux sockets for the blind boundary')
    return [line[1:] for line in result.stdout.splitlines() if line.startswith('n/')]


def path_aliases(value):
    path = Path(value).absolute()
    paths = {str(path), str(path.resolve())}
    for item in list(paths):
        for prefix in ['/tmp', '/var']:
            if item == '/private' + prefix or item.startswith('/private' + prefix + '/'):
                paths.add(item[len('/private'):])
            elif item == prefix or item.startswith(prefix + '/'):
                paths.add('/private' + item)
    return sorted(paths)


def tmux_socket_rules(sockets):
    directories = ['/tmp', '/private/tmp']
    if os.environ.get('TMUX_TMPDIR'):
        directories.append(os.environ['TMUX_TMPDIR'])
    roots = {alias for directory in directories
             for alias in path_aliases(Path(directory) / ('tmux-' + str(os.getuid())))}
    inherited = os.environ.get('TMUX', '').rsplit(',', 2)[0]
    paths = {alias for value in sockets + ([inherited] if inherited else [])
             for alias in path_aliases(value)}
    quote = lambda value: json.dumps(value, ensure_ascii=False)
    # Future servers can use arbitrary -S paths or fresh TMUX_TMPDIR roots.
    # Only the root-owned macOS resolver endpoint is needed by worker IP DNS.
    # Unnamed socketpairs remain available for Node and Chrome child processes.
    filters = ['(remote unix-socket)']
    filters += ['(remote unix-socket (subpath %s))' % quote(p) for p in sorted(roots)]
    filters += ['(remote unix-socket (literal %s))' % quote(p) for p in sorted(paths)]
    resolver = ['(remote unix-socket (literal %s))' % quote(p)
                for p in path_aliases('/var/run/mDNSResponder')]
    return ('(deny network-outbound ' + ' '.join(filters) + ')\n'
            + '(allow network-outbound ' + ' '.join(resolver) + ')')


def rename_guard_rules(values):
    # A path-based read denial must survive moving any of its ancestor dirs.
    parents = {str(parent) for value in values for alias in path_aliases(value)
               for parent in Path(alias).parents if str(parent) != '/'}
    return ['(deny file-write-unlink ' + ' '.join(
        '(literal %s)' % json.dumps(p, ensure_ascii=False) for p in sorted(parents)) + ')']


def worker_access_rules(repo):
    quote = lambda value: json.dumps(str(value), ensure_ascii=False)
    rules = []
    # Recipe CDP/dev servers, Metro, databases, local model providers and the
    # visual-review server (which can choose port 0) need TCP. Their complete
    # endpoint set is not captured at boundary creation. Block remote-shell
    # services on every address, including IPv6/mapped IPv4 and loopback aliases.
    rules += ['(deny network-outbound ' + ' '.join(
        '(remote tcp "*:%s")' % port for port in [22, 512, 513, 514]) + ')']
    rules += ['(deny process-exec ' + ' '.join(
        '(literal "/usr/bin/%s")' % name for name in ['ssh', 'scp', 'sftp']) + ')']
    # System ps prints other processes' environments; boundary/bin/ps refuses that.
    rules += ['(deny process-exec ' + ' '.join(
        '(literal %s)' % quote(p) for p in path_aliases('/bin/ps')) + ')']
    # Deployed task helpers and support bundles must remain executable.
    # Hide the rest of both legacy node installations, including dev-stack and
    # pool/project sources. Preserve a task checkout nested inside either root.
    for name in NODE_INSTALLATIONS:
        installation = Path.home() / name
        rules += ['(deny %s (subpath %s))' % (operation, quote(p))
                  for operation in ['file-read*', 'file-write*'] for p in path_aliases(installation)]
        readable = [installation / p for p in ['support', 'node_modules', 'packages/agent-runtime']]
        # Node realpath/module resolution stats ancestors of admitted scripts.
        # Metadata alone does not permit listing directories or reading sources.
        metadata = [installation, installation / 'packages']
        if inside(repo, installation.resolve()):
            readable += [repo]
            metadata += [p for p in repo.parents if inside(p, installation.resolve())]
            rules += ['(allow file-write* (subpath %s))' % quote(p) for p in path_aliases(repo)]
        rules += ['(allow file-read-metadata (literal %s))' % quote(p)
                  for value in metadata for p in path_aliases(value)]
        rules += ['(allow file-read* (subpath %s))' % quote(p)
                  for value in readable for p in path_aliases(value)]
        rules += ['(allow file-read* (literal %s))' % quote(p)
                  for p in path_aliases(installation / 'package.json')]
        # Core setup resolves its slot from the node pool (farmslot internal resolve-slot):
        # the directory and its *.json files are readable, never writable or linkable.
        pool = installation / 'pool'
        rules += ['(allow file-read* (literal %s))' % quote(p) for p in path_aliases(pool)]
        rules += ['(allow file-read* (regex %s))' % quote('^' + re.escape(p) + '/[^/]+[.]json$')
                  for p in path_aliases(pool)]
        rules += ['(deny file-link (subpath %s))' % quote(p) for p in path_aliases(pool)]
    rules += rename_guard_rules([Path.home() / name for name in NODE_INSTALLATIONS])
    return rules


def gateway_homes():
    home = Path.home()
    homes = {home / '.farmslot', *(p for p in home.glob('.farmslot*') if p.is_dir())}
    homes.update(Path(os.path.expanduser(os.environ[name]))
                 for name in ['FARMSLOT_HOME', 'FARMSLOT_CONFIG_DIR'] if os.environ.get(name))
    return homes


def gateway_network_ports(spec):
    # Read only URL fields before sandbox entry. Never return/log credential
    # fields or parser exceptions, which can include the original secret bytes.
    # Wildcard ports cover DNS aliases, LAN, IPv6 and mapped IPv4 without a
    # resolution race. Shared HTTP(S) ports must remain usable by providers.
    ports = {7777, 7778, 7801, 8808, 8809}  # CLI/server + TLS, desktop/worktree validation.
    urls = []
    homes = gateway_homes()
    configs = homes | {p / 'config' for p in homes}
    for root in sorted(configs):
        file = root / 'gateways.json'
        try:
            profiles = json.loads(file.read_text())
            urls += [('profile ' + json.dumps(name), profile['url'])
                     for name, profile in profiles['gateways'].items()]
        except FileNotFoundError:
            continue  # Absent homes/config layouts do not contribute endpoints.
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            raise RuntimeError('Cannot discover gateway endpoints for the blind boundary') from None
    for name in ['GATEWAY_URL', 'GW_URL', 'FARMSLOT_GATEWAY', 'VITE_FARMSLOT_GATEWAY_URL']:
        value = os.environ.get(name)
        # FARMSLOT_GATEWAY can also name a profile; every profile is read above.
        if value and (name != 'FARMSLOT_GATEWAY' or '://' in value):
            urls.append((name, value))
    def add_gateway_port(source, port):
        if port in (80, 443):
            print('Blind boundary: %s uses shared port %s; relying on credential hiding. '
                  'Use a dedicated gateway port for transport isolation.' % (source, port),
                  file=sys.stderr)
        else:
            ports.add(port)
    for source, value in urls:
        try:
            url = urlsplit(value)
            if url.scheme not in ['ws', 'wss', 'http', 'https'] or not url.hostname:
                raise ValueError()
            add_gateway_port(source, boundary_port(url.port if url.port is not None
                             else (443 if url.scheme in ['wss', 'https'] else 80)))
        except (ValueError, TypeError, AttributeError):
            raise RuntimeError('Invalid gateway endpoint for the blind boundary') from None
    for name in ['GATEWAY_PORT', 'GW_PORT', 'FARMSLOT_GATEWAY_TLS_PORT']:
        if os.environ.get(name):
            add_gateway_port(name, boundary_port(os.environ[name]))
    resources = spec.get('slotResourcePorts', {})
    for name, port in resources.items():
        if boundary_port(port) in ports:
            print('Blind boundary: denied gateway port %s collides with slot resource %s; '
                  'configure a distinct port.' % (port, json.dumps(name)), file=sys.stderr)
    # Slot capability browsers can run outside the seatbelt via LaunchServices.
    # Never exempt them. The blind harness spawns its own contained browser on
    # a fresh port, independent of configured slot and operator CDP endpoints.
    cdp_ports = {9323}
    for profile in Path.home().glob('.chrome-farmslot-*'):
        suffix = profile.name.removeprefix('.chrome-farmslot-')
        if suffix.isdigit():
            cdp_ports.add(boundary_port(suffix))
    if os.environ.get('FARMSLOT_CDP_PORT'):
        cdp_ports.add(boundary_port(os.environ['FARMSLOT_CDP_PORT']))
    if resources.get('cdp_port'):
        cdp_ports.add(boundary_port(resources['cdp_port']))
    ports |= cdp_ports
    ports -= {80, 443}
    return ports


def gateway_network_rules(spec, ports=None):
    return '(deny network-outbound ' + ' '.join(
        '(remote tcp "*:%s")' % port for port in sorted(gateway_network_ports(spec) if ports is None else ports)) + ')'


def boundary_port(value):
    if not str(value).isdigit() or not 1 <= int(value) <= 65535:
        raise RuntimeError('Invalid control-plane port for the blind boundary')
    return int(value)


def operator_browser_paths():
    # Paths/aliases only. Never open browser files, including DevToolsActivePort.
    home = Path.home()
    support = home / 'Library/Application Support'
    protected = [support / name for name in ['Google/Chrome', 'Google/Chrome Beta',
                 'Google/Chrome Canary', 'Google/Chrome Dev', 'Google/Chrome for Testing',
                 'Chromium', 'Chrome for Testing']]
    protected += [home / '.chrome-farmslot-9323', *home.glob('.chrome-farmslot-*')]
    if os.environ.get('FARMSLOT_CDP_PROFILE'):
        protected.append(Path(os.path.expanduser(os.environ['FARMSLOT_CDP_PROFILE'])))
    # Worker profiles live in the slot runtime, outside these operator stores.
    return protected


def gateway_credential_paths():
    # Discover paths/aliases only. Protect both legacy and layout-2 profiles,
    # including inactive homes and pool overrides.
    home = Path.home()
    homes = gateway_homes()
    configs = homes | {p / 'config' for p in homes}
    names = ['gateways.json', 'credentials.json', 'provider-accounts.json',
             'active-provider-accounts.json', 'node.secret', 'providers.env']
    protected = [p / name for p in configs for name in names]
    # Include existing atomic-write/backup files and individually symlinked secrets.
    protected += [p for root in configs for name in names + ['*.secret']
                  for p in root.glob(name + '*')]
    protected += [p / relative for p in homes for relative in ['node-link', 'state/node-link']]
    installations = {home / name for name in NODE_INSTALLATIONS}
    installations.update(p / 'code/node' for p in homes)
    installations.update(Path(os.path.expanduser(os.environ[name]))
                         for name in ['FARMSLOT_ROOT', 'FARMSLOT_WORKSPACE'] if os.environ.get(name))
    # Node reconnect reads .env at its install root and every ancestor. CLI/CDP
    # also load checkout .env.ports. Product runtime files elsewhere stay usable.
    control_roots = {Path(alias) for p in installations for alias in path_aliases(p)}
    control_roots |= {parent for p in list(control_roots) for parent in p.parents}
    protected += [p / name for p in control_roots for name in ['.env', '.env.ports']]
    protected += [p for root in control_roots for p in root.glob('.env.*')]
    # Deployed node-link authentication uses the node token in these declarations.
    for directory, pattern in [('Library/LaunchAgents', '*farmslot*.plist*'),
                               ('.config/systemd/user', '*farmslot*.service*')]:
        protected += list((home / directory).glob(pattern))
    return protected


def operator_shell_secret_paths():
    # Shell startup files export operator credentials; path_aliases adds each
    # resolved dotfiles target. The worker's own ZDOTDIR is the empty boundary/shell.
    home = Path.home()
    homes = {home} | ({Path(os.path.expanduser(os.environ['ZDOTDIR']))} if os.environ.get('ZDOTDIR') else set())
    startup = ['.zshenv', '.zshrc', '.zprofile', '.zlogin', '.zlogout', '.zsh_history', '.zsh_sessions']
    protected = [root / name for root in homes for name in startup]
    protected += [home / name for name in [
        '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.bash_history', '.profile',
        '.config/secrets', '.netrc', '.npmrc', '.yarnrc', '.pypirc',
        '.docker/config.json', '.git-credentials', '.aws', '.kube/config', '.gnupg']]
    return protected


def worker_private_rules(capsule):
    quote = lambda value: json.dumps(str(value), ensure_ascii=False)
    rules = []
    # These denials come after every read exception, including the boundary and
    # node_modules. Resolve symlinks before entering the sandbox as well.
    protected = [Path.home() / '.ssh', Path.home() / '.pi/agent/settings.json',
                 capsule / 'boundary/sandbox.sb'] + gateway_credential_paths() + operator_browser_paths()
    protected += operator_shell_secret_paths()
    for value in protected:
        rules += ['(deny %s (subpath %s))' % (operation, quote(p))
                  for operation in ['file-read*', 'file-write*'] for p in path_aliases(value)]
    # The basename remains protected even when a checkout's parent is renamed.
    rules += ['(deny %s (regex #"/blind-git[.](py|ts|js)$"))' % operation
              for operation in ['file-read*', 'file-write*']]
    # A later-created profile or a custom CLI home must not bypass the boundary.
    rules += ['(deny %s (regex #"/(gateways[.]json|credentials[.]json|provider-accounts[.]json|active-provider-accounts[.]json|node[.]secret|providers[.]env)([./]|$)"))' % operation
              for operation in ['file-read*', 'file-write*']]
    rules += rename_guard_rules(protected)
    # Yarn reads ~/.yarnrc.yml in every project; an absent file must read as absent, not EPERM.
    yarnrc = Path.home() / '.yarnrc.yml'
    rules += ['(deny file-write* file-link (subpath %s))' % quote(p) for p in path_aliases(yarnrc)]
    rules += rename_guard_rules([yarnrc])
    # Pi loads extensions inside this same seatbelt. File rules cannot distinguish
    # Pi's loader from its tool children; denying extension sources breaks startup.
    return rules


def slot_launch_dirs(spec, repo, checkouts):
    # Slot runtimes sit beside the checkouts (scripts/lib/runner-runtime.cjs) and
    # hold every slot's tmux launch scripts. The gateway passes each slot's launch
    # directory, own slot first; the fallback mirrors its default layout.
    return [Path(os.path.expanduser(p)) for p in spec.get('launchDirs', [])] or [
        p.parent / '.farmslot-runtime' / p.name / '.agent/.launch' for p in [repo] + checkouts]


def slot_runtime_rules(spec, repo, checkouts):
    quote = lambda value: json.dumps(str(value), ensure_ascii=False)
    launches = slot_launch_dirs(spec, repo, checkouts)
    own = launches[0].parent.parent
    trees = sorted({p.parent.parent.parent for p in launches
                    if p.parent.parent.parent.name == '.farmslot-runtime'})
    operations = ['file-read*', 'file-write*', 'file-link']
    # Every slot runtime is denied except this slot's own, which holds the
    # worker's runner homes and observability bundle.
    keep = ' '.join('(subpath %s)' % quote(p) for p in path_aliases(own))
    rules = ['(deny %s (require-all (subpath %s) (require-not (require-any %s))))'
             % (operation, quote(p), keep)
             for operation in operations for tree in trees for p in path_aliases(tree)]
    # Node realpath stats the root on the way to the own runtime's extensions.
    rules += ['(allow file-read-metadata (literal %s))' % quote(p)
              for tree in trees for p in path_aliases(tree)]
    rules += ['(deny %s (subpath %s))' % (operation, quote(p))
              for operation in operations for launch in launches for p in path_aliases(launch)]
    # Slots this node does not list keep the same layout.
    rules += ['(deny %s (regex #"/[.]farmslot-runtime/[^/]+/[.]agent/[.]launch(/|$)"))' % operation
              for operation in operations]
    return rules + rename_guard_rules(trees + launches)


# Operator credential stores, runner sessions and transcripts under HOME;
# gateway_homes() adds every farm home.
HOME_SECRET_STORES = ['.claude', '.codex', '.pi', '.grok', '.config', 'farm-paths-brief',
                      'xreview', 'Library/Application Support', 'Library/Preferences',
                      'Library/HTTPStorages', 'Library/Keychains', 'Library/Cookies']
# Operator stores at the root of a data volume that holds slot checkouts.
VOLUME_SECRET_STORES = ['lanes', 'slot-retained', 'xreview', 'dev/xreview-personal', '*archive*']


def blind_pi_home(spec, capsule):
    # Pi's operator home holds its logins and every session, and Pi refuses an
    # unreadable auth.json. A blind Pi without its own home gets one per trial.
    runtime = slot_launch_dirs(spec, Path(spec['repo']).resolve(), [])[0].parent.parent
    return runtime / '.blind-pi', runtime / '.blind-pi' / capsule.name


# Providers the Farmslot Pi extension registers for a blind worker, and the
# variable each takes its key from at runtime.
PI_STATIC_PROVIDER_KEYS = {'litellm': 'LITELLM_API_KEY', 'ollama': 'OLLAMA_API_KEY'}
PI_STATIC_PROVIDER_FIELDS = ['baseUrl', 'api', 'compat', 'models']
PI_STATIC_MODEL_FIELDS = ['id', 'name', 'api', 'reasoning', 'input', 'cost', 'contextWindow',
                          'maxTokens', 'thinkingLevelMap', 'compat']


def check_pi_agent_dir(spec, capsule):
    # A configured Pi home inside a denied store would reopen the operator's logins.
    configured = os.environ.get('PI_CODING_AGENT_DIR')
    if not configured:
        return
    agent = Path(os.path.expanduser(configured)).resolve()
    repo = Path(spec['repo']).resolve()
    if any(inside(agent, Path(p).resolve()) for p in host_secret_paths(spec, repo, capsule, [])):
        raise RuntimeError('Blind trial PI_CODING_AGENT_DIR %s is inside a store the blind sandbox '
                           'denies; unset it so the trial uses its own Pi home' % json.dumps(configured))


# Never copy a value under a credential-like key, at any depth: apiKey, headers,
# accessToken, client_secret and the like. Schema fields such as maxTokensField stay.
PI_SECRET_KEY = re.compile(r'(key|token|secret|password|passwd|credentials?|cookie|auth|authorization|bearer|headers?)$')
PI_PROVIDER_TOKEN = re.compile(r'^(sk-|gh[pos]_|github_pat_|xox[bp]-|glpat-|hf_|xai-|fw_|AIza|AKIA|ATATT)')


def credential_shaped(value):
    # credential-redaction.ts isSecretValue: provider shapes, or 16+ characters
    # mixing two of lowercase, uppercase and digits. References, URLs and paths are not.
    if PI_PROVIDER_TOKEN.match(value):
        return True
    if '$' in value or re.search(r'\s', value) or re.match(r'^[a-z][\w+.-]*://', value, re.I):
        return False
    if re.fullmatch(r'[~.]?/?[\w.-]+(/[\w.-]+)+/?', value):
        return False
    return len(value) >= 16 and sum(bool(re.search(c, value)) for c in ['[a-z]', '[A-Z]', '[0-9]']) >= 2


def scrub_pi_value(value):
    if isinstance(value, dict):
        return {k: scrub_pi_value(v) for k, v in value.items()
                if not PI_SECRET_KEY.search(re.sub(r'[^a-z]', '', k.lower())) and not (isinstance(v, str) and credential_shaped(v))}
    if isinstance(value, list):
        return [scrub_pi_value(v) for v in value if not (isinstance(v, str) and credential_shaped(v))]
    return value


def strip_json_comments(text):
    # Pi's models.json loader (pi-coding-agent utils/json.js stripJsonComments):
    # drop // line comments and trailing commas, leaving string literals intact.
    string = r'"(?:\\.|[^"\\])*"'
    text = re.sub(string + r'|//[^\n]*', lambda m: m.group(0) if m.group(0)[0] == '"' else '', text)
    return re.sub(string + r'|,(\s*[}\]])', lambda m: m.group(1) if m.group(1) is not None else m.group(0), text)


def private_dir(path):
    # The worker can rename entries in its own Pi home; never follow a link it planted.
    info = os.lstat(path)
    if os.path.islink(path) or not os.path.isdir(path) or info.st_uid != os.getuid():
        raise RuntimeError('Blind trial Pi home is not a private directory')


def write_blind_pi_models(target):
    # The extension keeps the operator's static model definitions for its
    # providers (preservePiStaticModels). Copy only those definitions: keys are
    # env references, and headers or any credential-like field are dropped.
    keys = dict(PI_STATIC_PROVIDER_KEYS)
    keys[os.environ.get('FARMSLOT_PI_ROUTER_ID') or 'router'] = 'FARMSLOT_PI_ROUTER_KEY'
    try:
        text = (Path.home() / '.pi/agent/models.json').read_text()
        providers = json.loads(strip_json_comments(text)).get('providers', {})
        static = {}
        for name, key in keys.items():
            provider = providers.get(name)
            if not isinstance(provider, dict):
                continue
            url = urlsplit(provider.get('baseUrl') or '')
            if url.username or url.password or url.query or url.fragment:
                continue  # A URL can embed a credential; the extension supplies the endpoint.
            entry = {field: provider[field] for field in PI_STATIC_PROVIDER_FIELDS if field in provider}
            entry['compat'] = scrub_pi_value(entry.get('compat', {}))
            entry['models'] = [{field: (model[field] if field in ('id', 'name') else scrub_pi_value(model[field]))
                                for field in PI_STATIC_MODEL_FIELDS if field in model}
                               for model in provider.get('models', []) if isinstance(model, dict)]
            static[name] = {**entry, 'apiKey': '$' + key}
    except FileNotFoundError:
        static = {}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        # Never report parser details: they can quote the operator's key bytes.
        raise RuntimeError('Cannot read the operator Pi static models for the blind trial') from None
    # Write through the directory itself: a fresh exclusive temporary file, never
    # an existing path or link, then an atomic rename that replaces any link at target.
    private_dir(target.parent)
    directory = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        name = '.models.%s.pending' % os.urandom(8).hex()
        handle = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        with os.fdopen(handle, 'w') as file:
            file.write(json.dumps({'providers': static}, indent=1) + '\n')
        os.replace(name, target.name, src_dir_fd=directory, dst_dir_fd=directory)
    finally:
        os.close(directory)


def host_secret_paths(spec, repo, capsule, checkouts):
    home = Path.home()
    denied = [home / name for name in HOME_SECRET_STORES] + sorted(gateway_homes())
    # Other trials' Pi homes in this slot runtime.
    denied.append(blind_pi_home(spec, capsule)[0])
    # The gateway passes the node's farm home, data, archive and run roots.
    denied += [Path(os.path.expanduser(p)) for p in spec.get('hostDeniedRoots', [])]
    volumes = {Path(*p.parts[:3]) for p in [repo] + checkouts
               if len(p.parts) > 3 and p.parts[1] == 'Volumes'}
    for volume in sorted(volumes):
        denied += [p for name in VOLUME_SECRET_STORES
                   for p in (volume.glob(name) if '*' in name else [volume / name])]
    # Node-local additions from the machine environment, colon separated.
    denied += [Path(os.path.expanduser(p))
               for p in os.environ.get('FARMSLOT_BLIND_DENIED_PATHS', '').split(':') if p]
    return denied


def host_secret_rules(spec, repo, capsule, checkouts):
    quote = lambda value: json.dumps(str(value), ensure_ascii=False)
    # The worker's own checkout, capsule, slot runtime and Pi home stay usable.
    writable = [repo, capsule, slot_launch_dirs(spec, repo, checkouts)[0].parent.parent,
                blind_pi_home(spec, capsule)[1]]
    # Read-only: pinned task CLIs, installed node code and Pi's managed fd/rg.
    readable = writable + [Path.home() / '.pi/agent/bin']
    readable += [h / p for h in gateway_homes() for p in ['task-pins', 'state/task-pins', 'code']]
    readable += [Path(os.path.expanduser(p)) for p in spec.get('hostReadableRoots', [])]
    home = Path.home().resolve()
    roots = sorted({Path(p) for value in host_secret_paths(spec, repo, capsule, checkouts)
                    for p in [Path(value).resolve()] if not inside(home, p)})
    rules, metadata = [], set()
    for operations, kept in [(['file-read*'], readable), (['file-write*', 'file-link'], writable)]:
        kept = [Path(p).resolve() for p in kept]
        for root in roots:
            inner = [p for p in kept if inside(p, root)]
            if root in inner:
                continue
            keep = ' '.join('(subpath %s)' % quote(a) for p in inner for a in path_aliases(p))
            # Node realpath stats each ancestor on the way to an admitted path.
            metadata |= {a for p in inner for parent in [p, *p.parents]
                         if inside(parent, root) and parent != p for a in path_aliases(parent)}
            rules += [('(deny %s (require-all (subpath %s) (require-not (require-any %s))))'
                       % (operation, quote(a), keep)) if keep
                      else '(deny %s (subpath %s))' % (operation, quote(a))
                      for operation in operations for a in path_aliases(root)]
    rules += ['(allow file-read-metadata (literal %s))' % quote(p) for p in sorted(metadata)]
    return rules + rename_guard_rules(roots)


def sandbox_profile(spec, capsule, tmux_sockets=None, network_ports=None):
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
    # Shared temp is never worker-owned. Reopen only this checkout's admitted
    # writes below and the boundary-allocated temp directory, not ambient TMPDIR.
    temporary = capsule / 'boundary/tmp'
    shared_temp = ['/tmp', '/var/tmp', '/var/folders', tempfile.gettempdir()]
    rules = ['(version 1)', '(allow default)',
                      *['(deny file-write* (subpath %s))' % quote(p)
                        for value in shared_temp for p in path_aliases(value)],
                      *([] if spec.get('proofBoundary') else [
                          '(allow file-write* (subpath %s))' % quote(repo)]),
                      *worker_access_rules(repo),
                      '(deny file-read* ' + ' '.join('(subpath %s)' % quote(path) for path in denied) + ')',
                      '(allow file-read* (subpath %s))' % quote((capsule / 'boundary').resolve())]
    if spec.get('proofBoundary'):
        scope = proof_scope(spec)
        rules += ['(deny file-read* ' + ' '.join('(subpath %s)' % quote(p) for p in scope['denied']) + ')',
                  '(allow file-read* (subpath %s))' % quote(scope['task']),
                  '(deny file-write* (subpath %s))' % quote(repo)]
        rules += ['(allow file-write* (subpath %s))' % quote(p) for p in [scope['task']] + scope['runtime']]
        rules += ['(deny file-write* (subpath %s))' % quote(p) for p in scope['pinned']]
    # Restore trusts the retained journal and stores. Protect this capsule and
    # all sibling trees after checkout/runtime exceptions, including aliases.
    protected_capsules = capsules | {capsule}
    rules += ['(deny file-write* file-link (subpath %s))' % quote(p)
              for value in sorted(protected_capsules) for p in path_aliases(value)]
    rules += rename_guard_rules(protected_capsules)
    rules += ['(allow file-write* (literal %s))' % quote(p)
              for name in ['attempts.log', 'git-trace.jsonl']
              for p in path_aliases(capsule / 'boundary' / name)]
    # Instance pool, runs and projects stay read-only, even through worker-created links.
    rules += ['(deny file-write* (subpath %s))' % quote(Path(os.path.expanduser(p)).resolve())
              for p in spec.get('farmConfigRoots', [])]
    rules += [tmux_socket_rules(tmux_sockets or []), gateway_network_rules(spec, network_ports)]
    if temporary.exists():
        rules += ['(allow file-write* (subpath %s))' % quote(p) for p in path_aliases(temporary)]
        broker = worker_temp(capsule) / 'broker'
        # Use only physical allocation aliases. Ordinary SBPL strings decode
        # JSON escapes before regex compilation; #"..." retains backslashes.
        rules += ['(allow network-outbound (remote unix-socket (regex %s)))'
                  % quote('^' + re.escape(p) + '/[^/]+$') for p in path_aliases(broker)]
        # Only bind sockets directly in this fixed directory. In particular a
        # directory rename must never import a foreign socket into an allowance.
        rules += ['(deny file-write* file-link (require-all (subpath %s) '
                  '(require-not (vnode-type SOCKET))))' % quote(p)
                  for p in path_aliases(broker)]
        # Also block two-step imports: move a containing directory into general
        # temp, then rename/link its socket into the broker. Chromium may bind
        # its singleton in general temp, but cannot move it into the broker.
        rules += ['(deny file-write-unlink file-link (require-all (vnode-type SOCKET) '
                  '(require-not (require-any ' + ' '.join('(subpath %s)' % quote(p)
                      for p in path_aliases(broker)) + '))))']
        # Keep the allocated root and its routing link fixed across retained launches.
        rules += ['(deny file-write* (literal %s))' % quote(p) for p in path_aliases(temporary)]
        rules += rename_guard_rules([temporary.resolve() / 'owned-entry'])
    # Check the source vnode as well as the destination path: an external
    # control socket must not acquire the trial directory's connect allowance.
    rules += ['(deny file-write* file-link (require-all (vnode-type SOCKET) '
              '(require-not (require-any ' + ' '.join('(subpath %s)' % quote(p)
                  for p in path_aliases(temporary)) + '))))']
    rules += ['(deny file-write* (subpath %s))' % quote((capsule / 'boundary/bin').resolve())]
    # Tmux launch scripts inline the node's pool environment, credentials included.
    rules += ['(deny %s (subpath %s))' % (operation, quote(p))
              for operation in ['file-read*', 'file-write*', 'file-link'] for p in path_aliases(repo / '.agent/.launch')]
    rules += slot_runtime_rules(spec, repo, checkouts)
    rules += worker_private_rules(capsule)
    # Last: no later allowance reopens a credential store.
    rules += host_secret_rules(spec, repo, capsule, checkouts)
    return '\n'.join(rules + [''])


def worker_temp(capsule):
    link = capsule / 'boundary/tmp'
    directory = link.resolve()
    if (not link.is_symlink() or directory.parent != Path('/private/tmp')
            or not re.fullmatch(r'fs-blind-[a-z0-9_]+', directory.name) or not directory.is_dir()
            or directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077):
        raise RuntimeError('Blind worker temporary directory is not private')
    return directory


def remove_worker_temp(capsule):
    link = capsule / 'boundary/tmp'
    if link.exists():
        shutil.rmtree(worker_temp(capsule))
        link.unlink()


def inside(path, root):
    return path == root or root in path.parents


def proof_scope(spec):
    repo = Path(spec['repo']).resolve()
    scope = spec['proofBoundary']
    task = Path(scope['currentTask']).resolve()
    task_root = Path(scope['taskRoot']).resolve()
    if task == task_root or not inside(task, task_root) or not inside(task, repo):
        raise RuntimeError('Proof task layout overlaps product or hidden inputs')
    denied = [task_root] + [Path(p).resolve() for p in scope['deniedRoots'] if Path(p).exists()]
    if any(inside(task, p) or inside(p, task) for p in denied[1:]):
        raise RuntimeError('Proof task overlaps gateway reference material')
    pinned = [repo / '.git', task / 'inputs', task / 'assets', task / 'TASK.md', task / 'mark']
    provenance = task / 'artifacts/harness-provenance.json'
    if provenance.exists():
        receipt = json.loads(provenance.read_text())
        pin = Path(receipt['pin']).resolve()
        if inside(task, pin) or inside(pin, task) or inside(repo, pin):
            raise RuntimeError('Proof task pin overlaps a writable root')
        pinned += [pin, provenance]
    runtime = [Path(p).resolve() for p in scope['runtimeRoots']]
    tracked = [repo / p.decode() for p in git(repo, 'ls-files', '-z').stdout.split(b'\0') if p]
    for root in [task] + runtime:
        if root == repo or not inside(root, repo) or any(inside(p, root) or inside(root, p) for p in tracked + [repo / '.git']):
            raise RuntimeError('Proof writable root overlaps tracked product or Git inputs')
        if git(repo, 'check-ignore', '--quiet', '--no-index', str(root.relative_to(repo)) + '/', check=False).returncode:
            raise RuntimeError('Proof writable root must be a gitignored task or runtime cache')
    if any(inside(p, root) or inside(root, p) for root in runtime for p in pinned + [task_root]):
        raise RuntimeError('Proof runtime cache overlaps pinned or task inputs')
    return {'task': task, 'runtime': runtime, 'denied': denied, 'pinned': pinned}


def input_digests(roots):
    result = {}
    for name in roots:
        root = Path(name)
        if not root.exists():
            result[name] = None
            continue
        files = sorted(root.rglob('*')) if root.is_dir() else [root]
        for file in files:
            if file.is_symlink():
                raise RuntimeError('Proof input symbolic links are forbidden')
            if file.is_file():
                result[str(file)] = hashlib.sha256(file.read_bytes()).hexdigest()
    return result


def freeze_proof_inputs(spec):
    scope = proof_scope(spec)
    # Pinned executable bytes are already verified by task init. The sandbox
    # denies their entire pin, while these small admitted task inputs are rehashed.
    roots = [str(p) for p in scope['pinned'] if p != Path(spec['repo']).resolve() / '.git'
             and (inside(p, scope['task']))]
    file = Path(spec['capsule']) / 'proof-inputs.json'
    frozen = {'roots': roots, 'inputs': input_digests(roots), 'scope': spec['proofBoundary']}
    if file.exists():
        if json.loads(file.read_text()) != frozen:
            raise RuntimeError('Proof input identity changed')
    else:
        save(file, frozen)


def verify_proof_source(spec):
    repo, proof = Path(spec['repo']), spec['proof']
    for sha in [proof['baseSha'], proof['headSha']]:
        git(repo, 'cat-file', '-e', sha + '^{commit}')
    if (spec['baseSha'] != proof['headSha']
            or git(repo, 'rev-parse', 'HEAD').stdout.decode().strip() != proof['headSha']
            or git(repo, 'rev-parse', 'HEAD^{tree}').stdout.decode().strip() != proof['treeSha']
            or git(repo, 'diff', '--cached', '--quiet', 'HEAD', '--', check=False).returncode
            or git(repo, 'diff', '--quiet', '--', check=False).returncode
            or git(repo, 'ls-files', '--others', '--exclude-standard').stdout.strip()):
        raise RuntimeError('Proof implementation changed')


def prepare_boundary(spec, capsule):
    require_sandbox()
    root = capsule / 'boundary'
    (root / 'gh-config').mkdir(parents=True, exist_ok=True)
    # Empty ZDOTDIR: worker zsh shells read no startup files. Seatbelt keeps it read-only.
    (root / 'shell').mkdir(exist_ok=True)
    (root / 'bin').mkdir(exist_ok=True)
    # The worker cannot create its slot runtime inside the denied runtime tree.
    slot_launch_dirs(spec, Path(spec['repo']).resolve(), [])[0].parent.parent.mkdir(
        parents=True, exist_ok=True)
    # The launch selects this trial's Pi home (blind-environment.md), reusing the
    # operator's managed fd/rg binaries read-only.
    homes, pi = blind_pi_home(spec, capsule)
    pi.mkdir(mode=0o700, parents=True, exist_ok=True)
    for directory in [homes, pi]:
        private_dir(directory)
    tools = Path.home() / '.pi/agent/bin'
    if tools.is_dir() and not os.path.lexists(pi / 'bin'):
        (pi / 'bin').symlink_to(tools)
    if not (root / 'pi-agent').is_symlink():
        (root / 'pi-agent').symlink_to(pi)
    check_pi_agent_dir(spec, capsule)
    write_blind_pi_models(pi / 'models.json')
    # Keep socket paths below sockaddr_un's macOS limit even for deep capsules.
    temporary = root / 'tmp'
    if not temporary.is_symlink():
        temporary.symlink_to(tempfile.mkdtemp(prefix='fs-blind-', dir='/private/tmp'))
    broker = worker_temp(capsule) / 'broker'
    broker.mkdir(mode=0o700, exist_ok=True)
    if broker.is_symlink() or broker.stat().st_uid != os.getuid() or broker.stat().st_mode & 0o077:
        raise RuntimeError('Blind worker broker directory is not private')
    # macOS refuses setuid exec under Seatbelt. A non-setuid, ad-hoc signed
    # system ps retains its CLI and sandbox, without a privileged helper. The
    # PATH entry is a wrapper that refuses environment output.
    (root / 'libexec').mkdir(exist_ok=True)
    ps = root / 'libexec/ps'
    shutil.copyfile('/bin/ps', ps)
    ps.chmod(0o700)
    subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(ps)],
                   check=True, capture_output=True)
    (root / 'bin/ps').unlink(missing_ok=True)
    (root / 'bin/ps').write_text(PS_WRAPPER.replace('REAL_PS', shlex.quote(str(ps))))
    (root / 'bin/ps').chmod(0o700)
    script = BOUNDARY_SCRIPT.replace('ATTEMPTS', shlex.quote(str(root / 'attempts.log')))
    for name in ['gh', 'deny']:
        (root / 'bin' / name).write_text(script)
        (root / 'bin' / name).chmod(0o700)
    if spec.get('proofBoundary'):
        freeze_proof_inputs(spec)
    # Preserve the endpoint across retained dispatch and task regeneration. Never
    # turn a configured slot/operator/gateway endpoint into an exemption.
    state_file = capsule / 'state.json'
    state = json.loads(state_file.read_text())
    network_ports = gateway_network_ports(spec)
    denied = network_ports | {22, 512, 513, 514}
    denied |= {boundary_port(p) for p in spec.get('slotResourcePorts', {}).values()}
    port = state.get('browserCdpPort')
    if port is not None and boundary_port(port) in denied:
        raise RuntimeError('Blind browser CDP port now overlaps a protected endpoint')
    if port is None:
        for _ in range(100):
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            if port not in denied:
                break
        else:
            raise RuntimeError('Cannot allocate a separate blind browser CDP port')
        state['browserCdpPort'] = port
        save(state_file, state)
    (root / 'sandbox.sb').write_text(sandbox_profile(spec, capsule, live_tmux_sockets(), network_ports))
    checked = subprocess.run([SANDBOX, '-f', str(root / 'sandbox.sb'), '/usr/bin/true'], capture_output=True)
    if checked.returncode:
        raise RuntimeError(SANDBOX_REQUIRED + ': ' + checked.stderr.decode(errors='replace').strip())
    return port


def refused_git_transport(trace):
    # Git refuses the isolated repository's transports before any stand-in runs;
    # its trace records the refusal and the command that tried, whichever git ran.
    if not trace.exists():
        return ''
    argv = {}
    with trace.open(errors='replace') as lines:
        for line in lines:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get('event') == 'start':
                argv[event.get('sid')] = ' '.join(event.get('argv') or ['git'])
            elif event.get('event') == 'error' and event.get('fmt') == "transport '%s' not allowed":
                return argv.get(event.get('sid'), 'git') + ': ' + str(event.get('msg'))
    return ''


def boundary(spec):
    port = prepare_boundary(spec, Path(spec['capsule']))
    return {**verify(spec), 'browserCdpPort': port}


def verify(spec, worker_boundary=True):
    repo, root = Path(spec['repo']), Path(spec['capsule']) / 'boundary'
    if git(repo, 'config', '--get', 'farmslot.blindRun').stdout.decode().strip() != spec['runId']:
        raise RuntimeError('Blind trial Git ownership does not match')
    if (repo / '.git').is_symlink() or not (repo / '.git').is_dir():
        raise RuntimeError('Blind trial requires an independent Git directory')
    if (repo / '.git/objects/info/alternates').exists():
        raise RuntimeError('Blind trial Git alternates are forbidden')
    allowed = {spec['baseSha']} | ({spec['proof']['baseSha']} if spec.get('proof') else set())
    if set((repo / '.git/shallow').read_text().split()) != allowed:
        raise RuntimeError('Blind trial shallow base changed')
    if git(repo, 'config', '--get-regexp', r'^remote\..*\.url$', check=False).returncode == 0:
        raise RuntimeError('Blind trial remote URLs are forbidden')
    if git(repo, 'config', '--get', 'protocol.allow').stdout.decode().strip() != 'never':
        raise RuntimeError('Blind trial fetch is not disabled')
    if spec.get('proof'):
        verify_proof_source(spec)
        receipt = Path(spec['capsule']) / 'proof-inputs.json'
        if receipt.exists():
            frozen = json.loads(receipt.read_text())
            if frozen['inputs'] != input_digests(frozen['roots']):
                raise RuntimeError('Proof input bytes changed')
    for commit in spec['referenceCommits']:
        if git(repo, 'cat-file', '-e', commit + '^{commit}', check=False).returncode == 0:
            raise RuntimeError('Reference objects are available in the blind trial')
    if worker_boundary and not all((root / name).is_file() for name in ['bin/gh', 'bin/deny', 'sandbox.sb']):
        raise RuntimeError('Blind trial worker boundary is missing')
    attempts = root / 'attempts.log'
    attempt = attempts.read_text(errors='replace').strip().split('\n')[0] if attempts.exists() else ''
    attempt = attempt or refused_git_transport(root / 'git-trace.jsonl')
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


def gitlinks(repo, commit, git_dir=None):
    links = {}
    for entry in git(repo, 'ls-tree', '-rz', commit, git_dir=git_dir).stdout.split(b'\0'):
        if entry.startswith(b'160000 '):
            metadata, path = entry.split(b'\t', 1)
            links[os.fsdecode(path)] = metadata.split()[2].decode()
    return links


def require_clean_submodules(repo, root):
    for path in gitlinks(repo, 'HEAD'):
        worktree = repo / path
        if not (worktree / '.git').exists():
            if worktree.is_dir() and any(worktree.iterdir()):
                raise RuntimeError('Blind trial refuses dirty submodule ' + str(worktree.relative_to(root)))
            continue  # An uninitialized, empty worktree has no local edits.
        require_clean_submodules(worktree, root)
        if git(worktree, 'status', '--porcelain', '--untracked-files=all',
               '--ignore-submodules=none').stdout.strip():
            raise RuntimeError('Blind trial refuses dirty submodule ' + str(worktree.relative_to(root)))


def prepare_submodules(repo, source, destination, snapshots, state, capsule):
    context = repo if repo.is_dir() else source
    links = [gitlinks(context, commit, git_dir=source) for commit in snapshots]
    if set(gitlinks(context, 'HEAD', git_dir=source)) - set(links[0]):
        raise RuntimeError('Blind trial cannot retain reference-only submodule worktrees')
    if not any(links):
        return
    if any(set(item) != set(links[0]) for item in links):
        raise RuntimeError('Blind trial requires matching submodule paths in admitted snapshots')
    # Read names from the admitted tree, not the reference checkout's .gitmodules.
    config = git(context, 'config', '--null', '--blob', snapshots[0] + ':.gitmodules',
                 '--get-regexp', r'^submodule\..*\.path$', git_dir=source).stdout
    names = {os.fsdecode(value): key.decode()[10:-5]
             for key, value in (entry.split(b'\n', 1) for entry in config.split(b'\0') if entry)}
    for path, commit in links[0].items():
        worktree = (repo / path).resolve()
        name = names[path]
        target = destination / 'modules' / name
        if not inside(worktree, repo.resolve()) or worktree == repo.resolve() or not inside(
                target.resolve(), (destination / 'modules').resolve()):
            raise RuntimeError('Blind trial submodule path escapes its repository')
        entry = worktree / '.git'
        if entry.is_symlink():
            raise RuntimeError('Blind trial submodule Git entry must not be a symlink')
        module_source = (Path(git(worktree, 'rev-parse', '--absolute-git-dir').stdout.decode().strip())
                         if entry.exists() else source / 'modules' / name)
        if not entry.is_dir() and not inside(module_source.resolve(), Path(state['originalDirectory']).resolve()):
            raise RuntimeError('Blind trial submodule Git directory is outside the retained metadata')
        # Never clone an unprepared module: that would import reference history.
        module_snapshots = list(dict.fromkeys(item[path] for item in links))
        for sha in module_snapshots:
            if git(context, 'cat-file', '-e', sha + '^{commit}',
                   git_dir=module_source, check=False).returncode:
                raise RuntimeError('Blind trial submodule %s is missing admitted commit %s '
                                   'from its local cache; populate that module cache before isolation'
                                   % (worktree.relative_to(Path(state['repo']).resolve()), sha))
        git(context, 'init', '-q', '--bare', '--template=',
            '--object-format=' + ('sha256' if len(commit) == 64 else 'sha1'), str(target))
        objects = capsule / 'module.objects'
        objects.write_bytes(git(context, 'rev-list', '--objects', '--no-object-names', '--no-walk',
                                *module_snapshots, git_dir=module_source).stdout)
        # pack-objects needs the source module's object store, not the superproject's.
        pack_into(context, target, [], objects, git_dir=module_source)
        objects.unlink()
        for key, value in [('core.bare', 'false'), ('core.worktree', str(worktree)),
                           ('protocol.allow', 'never')]:
            git(context, 'config', key, value, git_dir=target)
        copy_local_commit_settings(context, module_source, target)
        (target / 'shallow').write_text('\n'.join(sorted(module_snapshots)) + '\n')
        (target / 'HEAD').write_text(commit + '\n')
        if (module_source / 'index').exists():
            shutil.copyfile(module_source / 'index', target / 'index')
        state.setdefault('submodules', []).append({
            'worktree': str(worktree), 'originalDirectory': str(module_source), 'directory': str(target.relative_to(capsule / 'prepared.git')),
            'commit': commit, 'gitfile': entry.read_bytes().hex() if entry.is_file() else None,
            'embedded': str(capsule / ('module-entry-' + str(len(state['submodules']))))
                        if entry.is_dir() else None})
        prepare_submodules(worktree, module_source, target, module_snapshots, state, capsule)


def connect_submodules(repo, state):
    for module in state.get('submodules', []):
        worktree = Path(module['worktree'])
        worktree.mkdir(parents=True, exist_ok=True)
        entry = worktree / '.git'
        if module['embedded']:
            entry.rename(module['embedded'])
        directory = repo / '.git' / module['directory']
        entry.write_text('gitdir: ' + os.path.relpath(directory, worktree) + '\n')
        # Use only the copied index to remove reference-only tracked files.
        git(worktree, 'read-tree', '--reset', '-u', module['commit'])


def preserve_submodule_candidates(repo, capsule, state, candidate):
    # Git does not traverse gitlinks when packing the superproject. Walk every
    # retained candidate revision explicitly, including earlier recorded gitlinks.
    histories = {str(repo.resolve()): (candidate, [])}
    originals = {str(repo.resolve()): (Path(state['originalDirectory']), Path('.'))}
    trial = hashlib.sha256((state['runId'] + ':' + str(state['slotEpoch'])).encode()).hexdigest()
    for module in state.get('submodules', []):
        worktree = Path(module['worktree'])
        parent = max((Path(p) for p in histories if inside(worktree, Path(p))
                      and worktree != Path(p)), key=lambda p: len(p.parts))
        parent_source, parent_roots = histories[str(parent)]
        roots = set()
        for revision in git(repo, 'rev-list', '--all', 'HEAD', *parent_roots,
                            git_dir=parent_source).stdout.decode().splitlines():
            sha = gitlinks(repo, revision, git_dir=parent_source).get(str(worktree.relative_to(parent)))
            if sha:
                roots.add(sha)
        source = candidate / module['directory']
        roots.update(git(repo, 'for-each-ref', '--format=%(objectname)',
                         git_dir=source).stdout.decode().splitlines())
        roots.add(git(repo, 'rev-parse', 'HEAD', git_dir=source).stdout.decode().strip())
        histories[str(worktree)] = (source, sorted(roots))
        # Older journals omit originalDirectory, and deinitialized modules also
        # have no gitfile. Their recorded directory uses module names, not paths
        # in the worktree, and is relative to the retained root Git directory.
        original_path = module.get('originalDirectory')
        if original_path is not None:
            destination = Path(original_path)
        elif module['embedded']:
            destination = worktree / '.git'
        elif module['gitfile'] is not None:
            destination = (worktree / bytes.fromhex(module['gitfile']).decode().strip()[8:]).resolve()
        else:
            parent_directory, parent_relative = originals[str(parent)]
            destination = parent_directory / Path(module['directory']).relative_to(parent_relative)
        originals[str(worktree)] = (destination, Path(module['directory']))
        admitted = set((source / 'shallow').read_text().split())
        exported = sorted(roots - admitted)
        if not exported:
            continue
        # Resolve original stores across both root-entry renames and embedded
        # module-entry moves.
        if module['embedded'] and Path(module['embedded']).exists():
            destination = Path(module['embedded'])
        elif state['originalIsDirectory'] and (capsule / 'original.entry').exists():
            original_root = Path(state['originalDirectory'])
            if inside(destination, original_root):
                destination = capsule / 'original.entry' / destination.relative_to(original_root)
        if not (destination / 'objects').is_dir():
            raise RuntimeError('Cannot locate original submodule store for %s; '
                               'restore the cached store at %s and retry restoration. '
                               'Candidate store retained at %s'
                               % (worktree.relative_to(repo.resolve()), destination, source))
        objects = capsule / 'module-candidate.objects'
        objects.write_text('\n'.join(exported) + '\n')
        pack_into(repo, destination, ['--revs'], objects, git_dir=source)
        for sha in exported:
            # Suppress even an operator's logAllRefUpdates=always preference.
            # Only object packs and these refs may be added to original stores.
            git(repo, '-c', 'core.logAllRefUpdates=false', 'update-ref',
                'refs/farmslot/candidate/' + trial + '/' + sha, sha, git_dir=destination)
        objects.unlink()


def restore_submodule_entries(state):
    for module in reversed(state.get('submodules', [])):
        entry = Path(module['worktree']) / '.git'
        if module['embedded']:
            original = Path(module['embedded'])
            if original.exists():
                entry.unlink(missing_ok=True)
                original.rename(entry)
        elif module['gitfile'] is not None:
            entry.write_bytes(bytes.fromhex(module['gitfile']))
        else:
            entry.unlink(missing_ok=True)


# A partial clone fetches each missing object on demand, one request per object:
# a Mobile base exceeded the isolate budget that way. Fetch them in one batch first.
PREFETCH_TIMEOUT_S = 600


def prefetch_partial_clone(repo, snapshots, scratch_root):
    listed = git(repo, 'rev-list', '--objects', '--no-object-names', '--no-walk', '--missing=print', *snapshots)
    if b'\n?' not in b'\n' + listed.stdout:
        return
    scratch = Path(tempfile.mkdtemp(prefix='.blind-prefetch-', dir=scratch_root))
    try:
        # A checkout into scratch batches the fetch; the slot's index and files are untouched.
        (scratch / 'tree').mkdir()
        env = {**os.environ, 'GIT_INDEX_FILE': str(scratch / 'index')}
        for sha in snapshots:
            subprocess.run(GIT + ['-C', str(repo), '--work-tree=' + str(scratch / 'tree'), 'read-tree',
                                  '-u', '--reset', sha], env=env, capture_output=True, check=True,
                           timeout=PREFETCH_TIMEOUT_S)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        raise RuntimeError('Blind trial base objects are missing from this partial clone and could not be '
                           'fetched; fetch the base on the slot and retry') from None
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def isolate(spec):
    # One isolation per capsule at a time: a timed-out caller can leave one running.
    capsule = Path(spec['capsule'])
    capsule.parent.mkdir(parents=True, exist_ok=True)
    with open(capsule.parent / (capsule.name + '.lock'), 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Blind trial isolation is already running for this capsule') from None
        return isolate_locked(spec)


def isolate_locked(spec):
    repo, capsule = Path(spec['repo']), Path(spec['capsule'])
    journal = capsule / 'state.json'
    if journal.exists():
        state = json.loads(journal.read_text())
        if any(state.get(key) != spec.get(key) for key in ['runId', 'repo', 'baseSha', 'branch', 'slotId', 'slotEpoch', 'referenceCommits', 'proof']):
            raise RuntimeError('Blind trial capsule belongs to another execution')
        if state['phase'] in ('preparing', 'restored'):
            # An interrupted isolate left the swap half done, or its capsule was restored:
            # finish the restoration, keep that capsule aside and isolate afresh.
            restore(spec)
            capsule.rename(capsule.with_name(capsule.name + '.interrupted-' + os.urandom(4).hex()))
            return isolate_locked(spec)
        if state['phase'] != 'isolated':
            raise RuntimeError('Blind trial capsule requires restoration before preparation')
        source = capsule / 'original.entry' if state['originalIsDirectory'] else Path(state['originalDirectory'])
        copy_local_commit_settings(repo, source, repo / '.git')
        return verify(spec, worker_boundary=False)
    if not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', spec['baseSha']):
        raise RuntimeError('Blind trial requires a full base commit')
    git(repo, 'check-ref-format', '--branch', spec['branch'])
    git(repo, 'cat-file', '-e', spec['baseSha'] + '^{commit}')
    require_clean_submodules(repo, repo)
    if git(repo, 'status', '--porcelain', '--untracked-files=all',
           '--ignore-submodules=none').stdout.strip():
        raise RuntimeError('Blind trial requires a clean checkout before isolation')
    if git(repo, 'show-ref', '--verify', '--quiet', 'refs/heads/' + spec['branch'], check=False).returncode == 0:
        raise RuntimeError('Blind trial branch already exists')
    for commit in spec['referenceCommits']:
        if not spec.get('proof') and (commit == spec['baseSha'] or git(repo, 'merge-base', '--is-ancestor', commit,
                                           spec['baseSha'], check=False).returncode == 0):
            raise RuntimeError('Blind trial base contains the reference answer')
    prefetch_partial_clone(repo, [spec['baseSha']] + ([spec['proof']['baseSha']] if spec.get('proof') else []),
                           capsule.parent)
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
                            spec['baseSha'], *([spec['proof']['baseSha']] if spec.get('proof') else [])).stdout)
    pack_into(repo, prepared, [], objects)
    git(repo, 'config', 'core.bare', 'false', git_dir=prepared)
    git(repo, 'config', 'core.worktree', str(repo), git_dir=prepared)
    git(repo, 'config', 'protocol.allow', 'never', git_dir=prepared)
    git(repo, 'config', 'farmslot.blindRun', spec['runId'], git_dir=prepared)
    copy_local_commit_settings(repo, original_directory, prepared)
    snapshots = sorted({spec['baseSha']} | ({spec['proof']['baseSha']} if spec.get('proof') else set()))
    (prepared / 'shallow').write_text('\n'.join(snapshots) + '\n')
    git(repo, 'update-ref', 'refs/heads/' + spec['branch'], spec['baseSha'], git_dir=prepared)
    # Project checks diff against origin/main (git merge-base origin/main HEAD). Point it at the
    # verified base: a local tracking ref only, with no remote URL and no reference history.
    git(repo, 'update-ref', 'refs/remotes/origin/main', spec['baseSha'], git_dir=prepared)
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/' + spec['branch'], git_dir=prepared)
    git(repo, 'read-tree', spec['baseSha'], git_dir=prepared)
    prepare_submodules(repo, original_directory, prepared,
                       [spec['baseSha']] + ([spec['proof']['baseSha']] if spec.get('proof') else []),
                       state, capsule)
    save(journal, state)
    try:
        (repo / '.git').rename(original)
        source = original if state['originalIsDirectory'] else original_directory
        # The original index knows which later tracked files must disappear.
        git(repo, 'read-tree', '--reset', '-u', spec['baseSha'], git_dir=source)
        prepared.rename(repo / '.git')
        connect_submodules(repo, state)
        result = verify(spec, worker_boundary=False)
        state['phase'] = 'isolated'
        save(journal, state)
        return result
    except BaseException:
        if original.exists():
            if (repo / '.git').exists():
                (repo / '.git').rename(capsule / 'failed.git')
            original.rename(repo / '.git')
            restore_submodule_entries(state)
            git(repo, 'reset', '--hard', state['originalHead'])
        state['phase'] = 'restored'
        save(journal, state)
        raise


def preserve_parked_work(repo, capsule, source, destination):
    prefixes = ['refs/farmslot/parked/', 'refs/farmslot/parked-meta/']
    def refs(directory):
        return dict(line.split() for line in git(
            repo, 'for-each-ref', '--format=%(refname) %(objectname)', *prefixes,
            git_dir=directory).stdout.decode().splitlines())
    parked = refs(source)
    if not parked:
        return
    existing = refs(destination)
    updates = []
    for ref, sha in parked.items():
        if ref in existing:
            if existing[ref] != sha:
                raise RuntimeError('Blind trial parked ref conflicts with original: ' + ref)
            updates.append('verify ' + ref + ' ' + sha)
        else:
            updates.append('create ' + ref + ' ' + sha)
    objects = capsule / 'parked.objects'
    objects.write_text('\n'.join(parked.values()) + '\n')
    # The capsule stops traversal at its shallow base; the original already has
    # that base's full history. Export a self-contained pack, never a thin pack.
    pack_into(repo, destination, ['--revs'], objects, git_dir=source)
    # Create atomically, verifying matching refs on retries rather than moving
    # any existing ref. A concurrent conflicting writer also fails closed.
    git(repo, '-c', 'core.logAllRefUpdates=false', 'update-ref', '--no-deref', '--stdin',
        git_dir=destination,
        input=('start\n' + '\n'.join(updates) + '\nprepare\ncommit\n').encode())
    objects.unlink()


def restore(spec):
    repo, capsule = Path(spec['repo']), Path(spec['capsule'])
    journal = capsule / 'state.json'
    if not journal.exists():
        if git(repo, 'config', '--get', 'farmslot.blindRun', check=False).stdout.strip():
            raise RuntimeError('Blind trial restoration record is missing')
        return {'status': 'absent'}
    state = json.loads(journal.read_text())
    if any(state.get(key) != spec.get(key) for key in ['runId', 'repo', 'baseSha', 'branch', 'slotId', 'slotEpoch', 'referenceCommits', 'proof']):
        raise RuntimeError('Blind trial restoration owner does not match')
    if state['phase'] == 'restored':
        remove_worker_temp(capsule)
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
        restore_submodule_entries(state)
        state['phase'] = 'restored'
        save(journal, state)
        remove_worker_temp(capsule)
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
    if not state.get('parkedWorkExported'):
        if original.exists() or retained.exists():
            source = retained if retained.exists() else repo / '.git'
            destination = original if state['originalIsDirectory'] and original.exists() else Path(state['originalDirectory'])
            preserve_parked_work(repo, capsule, source, destination)
        state['parkedWorkExported'] = True
        save(journal, state)
    if not state.get('submodulesExported'):
        preserve_submodule_candidates(repo, capsule, state,
                                      retained if retained.exists() else repo / '.git')
        state['submodulesExported'] = True
        save(journal, state)
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
    restore_submodule_entries(state)
    if retained.exists():
        shutil.copyfile(retained / 'index', directory / 'index')
        shutil.rmtree(retained)
    state['phase'] = 'restored'
    save(journal, state)
    for name in ['base.objects', 'candidate.objects']:
        (capsule / name).unlink(missing_ok=True)
    remove_worker_temp(capsule)
    return {'status': 'restored', 'runId': spec['runId'], 'headSha': head}


if __name__ == '__main__':
    request = json.loads(sys.argv[1])
    action = request.pop('action')
    if action == 'plan':
        capsule = Path(request['repo']).resolve().parent / '.farmslot-blind-evals' / request['slotId'] / (request['runId'] + '-' + str(request['slotEpoch']))
        # Plan runs before the swap and before any worker. Never recover identity from a journal.
        repo = Path(request['repo'])
        common = git(repo, 'rev-parse', '--git-common-dir').stdout.decode().strip()
        repo_key = hashlib.sha256(os.path.abspath(repo / common).encode()).hexdigest()
        result = {'status': 'planned', 'capsule': str(capsule), 'repoKey': repo_key}
    else:
        result = {'isolate': isolate, 'boundary': boundary, 'verify': verify, 'restore': restore}[action](request)
    print(json.dumps(result))
