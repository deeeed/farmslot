# Command Center for macOS

Farmslot packages the existing Command Center UI in Electron. It connects to an independently running local or remote gateway. Closing or quitting the app does not stop gateway work.

Requires macOS 13 or later. The initial package targets Apple silicon. The web client continues using the same UI source.

## Build and run

From the repository root, using Node 22.12 or later and Yarn 4:

```sh
yarn install --immutable
yarn workspace @farmslot/command-center-desktop build
yarn workspace @farmslot/command-center-desktop start
```

The build writes production UI assets to this workspace's `ui-dist/`; it does not overwrite the web build or start a gateway. First launch opens Connection Settings. Enter the gateway's `ws://` or `wss://` URL and select token, password, or no authentication. Use `wss://` for remote gateways.

Open **Farmslot > Connection Settings** with `Cmd+,` to change the connection or replace a rejected credential. Settings are encrypted with Electron `safeStorage`, backed by macOS Keychain, in `~/Library/Application Support/Farmslot/connection.encrypted`. App replacement preserves this directory. Credentials are never added to the app's page URL.

Standard macOS edit shortcuts and View menu zoom/reload commands are available. Closing the window leaves Farmslot in the Dock; clicking its icon reopens the window. `Cmd+Q` quits. Web links open in the default browser. Gateway artifact links and exported files use a native save dialog.

## Installable build

```sh
yarn workspace @farmslot/command-center-desktop package:mac
```

Artifacts are written to `release/`: a standalone `.app` under `mac-arm64/`, plus a DMG and ZIP. Open the DMG and drag Farmslot into Applications. These local builds are unsigned and unnotarized; macOS may require allowing the app in Privacy & Security. They are intended for local testing.

For distribution, use an Apple **Developer ID Application** certificate and notarization credentials. Apple Development certificates do not satisfy this requirement. Configure electron-builder's signing variables, such as `CSC_LINK` and `CSC_KEY_PASSWORD`, and notarization credentials `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`, then run:

```sh
yarn workspace @farmslot/command-center-desktop package:mac:signed
```

The command rejects missing or incomplete notarization credentials before building. It also accepts electron-builder's `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` or `APPLE_KEYCHAIN_PROFILE` credentials. After packaging, it verifies the app signature, stapled notarization ticket, and Gatekeeper assessment. These checks cover the app inside the DMG/ZIP; the DMG itself is not signed. All checks must succeed before distributing the result. No automatic updater is included.

## Development app

Farmslot keeps its purple icon and bundled UI. Farmslot Dev has a red icon background,
a distinct bundle ID, and separate credentials and preferences in
`~/Library/Application Support/Farmslot Dev`. Both can stay installed and pinned in the Dock.

```sh
yarn workspace @farmslot/command-center-desktop package:mac:dev
```

Install `release-dev/mac-arm64/Farmslot Dev.app` beside Farmslot. In Dev's Connection
Settings, enter your gateway login and set **Development UI → Vite URL** to your running
Command Center frontend, for example `http://localhost:5175/`. Only use a server you trust;
it receives the saved gateway connection through the desktop bridge. The allowed hosts
are `localhost`, `127.0.0.1`, and `[::1]`, with `/` or `/cc/` as the path.

Frontend edits appear through Vite reloads. The app does not start Vite or the gateway.
If the server is unavailable during navigation or reload, settings offer **Retry development UI**
and **Use bundled UI**. Native main/preload changes require rebuilding and replacing the app.
This is a local development workflow, not an automatic distribution updater.

For an unpackaged shell, build once then run `yarn workspace @farmslot/command-center-desktop start:dev`.
Development links use `farmslot-dev://` with the same destinations as `farmslot://`.
Each app registers only its own scheme. Choose different global shortcuts if running both at once.

To reproduce the live check in a dedicated worktree, build both app profiles, export
`FARMSLOT_GATEWAY` and `FARMSLOT_GATEWAY_TOKEN`, then run
`node --import tsx scripts/e2e-desktop-live-ui.mts`. It owns ports 5186/9513/9514,
creates a temporary profile, briefly edits and restores the worktree's UI title,
and only reads the gateway. Screenshots and results go to `temp/desktop-live-ui/`.
The same check is in `docs/examples/recipes/farmslot/electron-live-ui.recipe.json`.

## Updating the checkout

The shared **Update checkout** banner names the gateway's source checkout and target commit
before applying an update. This may be on a remote machine. For Farmslot Dev, frontend changes
appear automatically only when Vite serves that same checkout.

The action only fast-forwards a clean default branch. Local edits, feature branches, divergent
history and dependency changes stop the update with an explanation. For dependency changes,
update that checkout in a terminal and run `yarn install --immutable`. The action never stashes
or resets local work. Git operations continue if a development gateway watcher reconnects;
the banner resumes progress from disk. **Check again** refreshes remote status, and local pulls
appear on the next poll within 30 seconds.

Desktop shell changes require rebuilding and replacing the `.app`. A source update does not
install a new macOS binary or restart a packaged gateway. The banner calls out these follow-ups.

The [checkout update recipe](../../docs/examples/recipes/farmslot/checkout-update.recipe.json)
uses a disposable repository and an isolated Electron profile to verify the real update action.

## Daily use

Remember me is enabled by default in connection settings and desktop login. Saved credentials use macOS Keychain encryption. Turning it off deletes the saved record; the current connection lasts until you quit, including window close/reopen.

The menu bar shows connection status and pending decisions. Closing the window hides it and keeps status updates running. Use the menu bar or Dock to reopen it. Command+Shift+Space shows or hides Farmslot; change or disable this shortcut in Connection Settings. Conflicting shortcuts report an error and keep the previous shortcut. The last view and window bounds survive quit and app replacement.

## Dock badge and links

The Dock badge shows the same pending-decision count as the menu bar. It clears while disconnected or loading, and when no decisions remain.

Open a run, its current gate, or a slot with a `farmslot://` link:

| Link                                                          | Destination                                   |
| ------------------------------------------------------------- | --------------------------------------------- |
| `farmslot://run/<run-id>`                                     | Run drawer with its current gate and progress |
| `farmslot://gate/<run-id>`                                    | The same run's current gate                   |
| `farmslot://slot/<slot-id>`                                   | Slot view                                     |
| `farmslot://slot/<slot-id>?runId=<run-id>`                    | Slot view in a run's context                  |
| `farmslot://fleet`, `farmslot://runs`, `farmslot://decisions` | Main views                                    |

Use **Farmslot → Copy Link to Current View** for supported views. Links target the app's configured gateway; they do not contain credentials, change gateways, or perform actions. On first use, connection setup opens and retains the link until you connect. Opening a link restores a hidden or minimized window. Selected source files and other temporary view filters are not included in copied links.

Packaged normal launches register the URL scheme with macOS. Isolated profiles using `FARMSLOT_DESKTOP_USER_DATA` skip changing the default handler; tests can target their bundle explicitly with `open -a <test-app> <link>`.

## Validation

```sh
yarn workspace @farmslot/command-center-desktop test
FARMSLOT_DESKTOP_USER_DATA=/tmp/farmslot-desktop-validation \
  FARMSLOT_DESKTOP_CDP_PORT=9473 \
  yarn workspace @farmslot/command-center-desktop start
```

`FARMSLOT_DESKTOP_USER_DATA` isolates settings and Chromium storage. `FARMSLOT_DESKTOP_CDP_PORT` explicitly enables a localhost debugging endpoint for the existing Command Center CDP tools. Normal launches have no debugger endpoint.

The main process serves bundled assets on a loopback port under `/cc/`. First launch allocates the port and saves it in `ui-port.json` within userData. Later launches reuse it so UI preferences survive a full quit. If another process occupies that port, launch fails with an error; close that process before reopening Farmslot. It accepts only its own Host header and confines requests to bundled files. The renderer has no Node integration, runs sandboxed with context isolation, and receives connection settings, shortcut preferences, a resume notification, and a narrowly validated menu-bar status API through the preload bridge. IPC accepts requests only from the app's main frame. Notifications and clipboard permissions are restricted to the trusted app main frame. The persistent renderer session disables HTTP caching so authenticated resource URLs never enter Chromium's disk cache; UI preferences remain persistent. Startup also clears HTTP cache left by earlier development builds. The app does not proxy gateway requests or alter gateway authentication or TLS checks.

### Reproduce the live recipe

Use a fresh, dedicated worktree. This fixture uses only ports 8977/9473 and its own tmux session; leave the operator checkout and gateway running. From the worktree root, create isolated state and a local shell slot:

```sh
python3 - <<'PY'
from pathlib import Path
import json, os, secrets, shlex
root = Path.cwd()
assert not (root / '.env.ports').exists(), 'Use a fresh validation worktree'
assert not (root / '.env.local-auth').exists(), 'Use a fresh validation worktree'
base = root / '.sandbox/electron'
for name in ['home', 'pool', 'projects/desktop-validation', 'runs']:
    (base / name).mkdir(parents=True, exist_ok=True)
project = {'name': 'desktop-validation', 'paths': {'runtime_dir': '.agent', 'artifact_dir': '.task'}}
(base / 'projects/desktop-validation/project.json').write_text(json.dumps(project))
pool = {'machine': 'desktop-validation', 'project': 'desktop-validation', 'platform': 'cli',
        'host': 'localhost', 'ssh_user': os.environ['USER'], 'os': 'darwin',
        'slots': [{'id': 'electron-validation', 'enabled': True, 'repo': str(root),
                   'session': 'farmslot-electron-validation', 'resources': {}}]}
(base / 'pool/desktop-validation.json').write_text(json.dumps(pool))
values = {'FARMSLOT_ROOT': str(root), 'FARMSLOT_HOME': str(base / 'home'),
          'FARMSLOT_POOL_DIR': str(base / 'pool'), 'FARMSLOT_PROJECTS_DIR': str(base / 'projects'),
          'FARMSLOT_RUNS_DIR': str(base / 'runs'), 'FARMSLOT_DISABLE_ORCHESTRATION': '1',
          'GATEWAY_HOST': '127.0.0.1', 'GATEWAY_PORT': '8977',
          'FARMSLOT_GATEWAY': 'ws://127.0.0.1:8977', 'FARMSLOT_CDP_PORT': '9473',
          'FARMSLOT_DESKTOP_CDP_PORT': '9473',
          'FARMSLOT_DESKTOP_USER_DATA': str(base / 'desktop-profile')}
(root / '.env.ports').write_text('\n'.join(k + '=' + shlex.quote(v) for k, v in values.items()) + '\n')
with (root / '.env.local-auth').open('x') as auth:
    os.chmod(auth.name, 0o600)
    auth.write('FARMSLOT_GATEWAY_TOKEN=' + secrets.token_hex(32) + '\n')
PY
set -a; source .env.ports; source .env.local-auth; set +a
tmux new-session -d -s farmslot-electron-validation -c "$PWD"
yarn workspace @farmslot/gateway start
```

In a second terminal at the same root, load the two env files as above, then build and start the desktop app. In a third terminal with the same environment:

```sh
yarn workspace @farmslot/protocol build
yarn workspace @farmslot/recipe-harness build
node apps/command-center/scripts/agentic/run-recipe.mjs \
  docs/examples/recipes/farmslot/electron-client.recipe.json \
  --project-root "$PWD" --artifacts-dir temp/electron-recipe \
  --action-manifest docs/examples/recipes/farmslot-v1.action-manifest.json \
  --cdp-port 9473 --gateway-port 8977
```

The helper uses real inputs and gateway reads, deletes its temporary backlog item, and writes screenshots plus `temp/electron-client-live/result.json`. It validates synthetic H.264 decoding, not a physical device stream. Quit/relaunch, gateway restart, and OS sleep/resume are separate lifecycle checks. To stop this fixture, quit its app, stop its gateway terminal, and run `tmux kill-session -t farmslot-electron-validation`.
