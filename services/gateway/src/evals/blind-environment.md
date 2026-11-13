# Blind worker environment

Fresh launches and retained reloads use `withBlindTrialBoundary`. After machine,
project and task exports, `/usr/bin/env -i` constructs the sandboxed child's
entire environment from exact names. Non-blind launches keep their environment.
Unset names stay unset; empty values, whitespace and newlines are preserved.

No wildcard is admitted. In particular `*_PAT`, `*_TOKEN`, `GH_*`, `GITHUB_*`,
`NPM_*`, npm auth configuration, registry auth, cloud credentials and unknown
provider keys are absent unless an exact runner authentication exception below
requires the name. `GH_CONFIG_DIR` is replaced with an empty capsule directory.
`TMUX`, `TMUX_TMPDIR`, SSH agents, `NODE_OPTIONS`, shell startup variables and
inherited Git configuration cannot cross the boundary.

| Entry                             | Reason                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `PATH`                            | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
| `HOME`                            | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
| `USER`                            | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
| `LOGNAME`                         | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
| `SHELL`                           | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
| `TMPDIR`                          | Assigned by the boundary to the trial's private temporary directory.                                |
| `TMP`                             | Assigned by the boundary to the same private temporary directory.                                   |
| `TEMP`                            | Assigned by the boundary to the same private temporary directory.                                   |
| `LANG`                            | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
| `LC_ALL`                          | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
| `LC_CTYPE`                        | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
| `LC_MESSAGES`                     | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
| `TZ`                              | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
| `TERM`                            | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
| `COLORTERM`                       | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
| `NO_COLOR`                        | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
| `TMUX_PANE`                       | Identifies the pane for runner hooks; no socket access is granted.                                  |
| `DISABLE_OMC`                     | Keeps inherited runner plugins disabled.                                                            |
| `DISABLE_OMX`                     | Keeps inherited runner plugins disabled.                                                            |
| `FARMSLOT_HOME`                   | Locates task tools, task state or slot identity; Seatbelt still denies gateway credentials and RPC. |
| `FARMSLOT_CONFIG_DIR`             | Locates task tools, task state or slot identity; Seatbelt still denies gateway credentials and RPC. |
| `FARMSLOT_ROOT`                   | Locates task tools, task state or slot identity; Seatbelt still denies gateway credentials and RPC. |
| `FARMSLOT_CLI`                    | Locates task tools, task state or slot identity; Seatbelt still denies gateway credentials and RPC. |
| `FARMSLOT_TASK_DIR`               | Locates task tools, task state or slot identity; Seatbelt still denies gateway credentials and RPC. |
| `FARMSLOT_SLOT_ID`                | Locates task tools, task state or slot identity; Seatbelt still denies gateway credentials and RPC. |
| `FARMSLOT_MACHINE`                | Locates task tools, task state or slot identity; Seatbelt still denies gateway credentials and RPC. |
| `FARMSLOT_RUN_ID`                 | Locates task tools, task state or slot identity; Seatbelt still denies gateway credentials and RPC. |
| `FARMSLOT_NODE22_BIN`             | Locates task tools, task state or slot identity; Seatbelt still denies gateway credentials and RPC. |
| `FARMSLOT_PROJECTS_DIR`           | Locates task tools, task state or slot identity; Seatbelt still denies gateway credentials and RPC. |
| `FARMSLOT_POOL_DIR`               | Locates task tools, task state or slot identity; Seatbelt still denies gateway credentials and RPC. |
| `FARMSLOT_RUNS_DIR`               | Locates task tools, task state or slot identity; Seatbelt still denies gateway credentials and RPC. |
| `FARMSLOT_NATIVE_STATE_DIR`       | Locates task tools, task state or slot identity; Seatbelt still denies gateway credentials and RPC. |
| `FARMSLOT_LOG_DIR`                | Locates task tools, task state or slot identity; Seatbelt still denies gateway credentials and RPC. |
| `FARMSLOT_SOURCE_RECEIPT`         | Locates and verifies the admitted immutable task source.                                            |
| `FARMSLOT_SOURCE_LOCK_DIGEST`     | Locates and verifies the admitted immutable task source.                                            |
| `FARMSLOT_SOURCE_PACK_ID`         | Locates and verifies the admitted immutable task source.                                            |
| `FARMSLOT_SOURCE_PACK_ENTRY`      | Locates and verifies the admitted immutable task source.                                            |
| `FARMSLOT_RECIPE_SOURCE_TRUST`    | Preserves the task recipe trust classification.                                                     |
| `FARMSLOT_RECIPE_SOURCE_KIND`     | Preserves the task recipe trust classification.                                                     |
| `FARMSLOT_RECIPE_SOURCE_NAME`     | Preserves the task recipe trust classification.                                                     |
| `PI_CODING_AGENT_DIR`             | Locates runner-owned configuration or preserves the runner question-tool policy.                    |
| `CODEX_HOME`                      | Locates runner-owned configuration or preserves the runner question-tool policy.                    |
| `CLAUDE_CONFIG_DIR`               | Locates runner-owned configuration or preserves the runner question-tool policy.                    |
| `CLAUDE_SECURESTORAGE_CONFIG_DIR` | Locates runner-owned configuration or preserves the runner question-tool policy.                    |
| `CURSOR_CONFIG_DIR`               | Locates runner-owned configuration or preserves the runner question-tool policy.                    |
| `CURSOR_DATA_DIR`                 | Locates runner-owned configuration or preserves the runner question-tool policy.                    |
| `XDG_CONFIG_HOME`                 | Locates runner-owned configuration or preserves the runner question-tool policy.                    |
| `XDG_DATA_HOME`                   | Locates runner-owned configuration or preserves the runner question-tool policy.                    |
| `XDG_CACHE_HOME`                  | Locates runner-owned configuration or preserves the runner question-tool policy.                    |
| `GROK_HOME`                       | Locates runner-owned configuration or preserves the runner question-tool policy.                    |
| `OPENCODE_CONFIG`                 | Locates runner-owned configuration or preserves the runner question-tool policy.                    |
| `OPENCODE_CONFIG_DIR`             | Locates runner-owned configuration or preserves the runner question-tool policy.                    |
| `GROK_ASK_USER_QUESTION`          | Locates runner-owned configuration or preserves the runner question-tool policy.                    |
| `OPENCODE_PERMISSION`             | Locates runner-owned configuration or preserves the runner question-tool policy.                    |
| `RECIPE_LIBRARY_PATH`             | Locates project recipe inputs, browser binary or application development server.                    |
| `RECIPE_RUNTIME_DIR`              | Locates project recipe inputs, browser binary or application development server.                    |
| `RECIPE_PROJECT_ROOT`             | Locates project recipe inputs, browser binary or application development server.                    |
| `RECIPE_WALLET_FIXTURE`           | Locates project recipe inputs, browser binary or application development server.                    |
| `RECIPE_WEB_DAPP_POLICY`          | Locates project recipe inputs, browser binary or application development server.                    |
| `RECIPE_HARNESS_CHROME_BIN`       | Locates project recipe inputs, browser binary or application development server.                    |
| `RECIPE_HARNESS_BROWSER`          | Locates project recipe inputs, browser binary or application development server.                    |
| `TERMINAL_CHROME_BIN`             | Locates project recipe inputs, browser binary or application development server.                    |
| `WATCHER_PORT`                    | Locates project recipe inputs, browser binary or application development server.                    |
| `METRO_PORT`                      | Locates project recipe inputs, browser binary or application development server.                    |
| `RECIPE_WATCHER_PORT`             | Locates project recipe inputs, browser binary or application development server.                    |
| `TERMINAL_APP_PORT`               | Locates project recipe inputs, browser binary or application development server.                    |
| `SIMULATOR_UDID`                  | Selects the assigned Mobile device.                                                                 |
| `DEVICE_UDID`                     | Selects the assigned Mobile device.                                                                 |
| `ADB_SERIAL`                      | Selects the assigned Mobile device.                                                                 |
| `ANDROID_SERIAL`                  | Selects the assigned Mobile device.                                                                 |
| `ANDROID_HOME`                    | Selects installed toolchains or project build mode.                                                 |
| `ANDROID_SDK_ROOT`                | Selects installed toolchains or project build mode.                                                 |
| `JAVA_HOME`                       | Selects installed toolchains or project build mode.                                                 |
| `DEVELOPER_DIR`                   | Selects installed toolchains or project build mode.                                                 |
| `SDKROOT`                         | Selects installed toolchains or project build mode.                                                 |
| `ASDF_DATA_DIR`                   | Selects installed toolchains or project build mode.                                                 |
| `NVM_DIR`                         | Selects installed toolchains or project build mode.                                                 |
| `VOLTA_HOME`                      | Selects installed toolchains or project build mode.                                                 |
| `COREPACK_HOME`                   | Selects installed toolchains or project build mode.                                                 |
| `CI`                              | Selects installed toolchains or project build mode.                                                 |
| `NODE_ENV`                        | Selects installed toolchains or project build mode.                                                 |
| `PYTHONDONTWRITEBYTECODE`         | Selects installed toolchains or project build mode.                                                 |
| `GH_CONFIG_DIR`                   | Assigned by the boundary wrapper; prevents inherited transport or browser authority.                |
| `ZDOTDIR`                         | Assigned by the boundary wrapper to the empty, read-only `boundary/shell`; zsh reads no home rc.    |
| `GIT_TERMINAL_PROMPT`             | Assigned by the boundary wrapper; prevents inherited transport or browser authority.                |
| `FARMSLOT_CI_BASE_REF`            | Assigned by the boundary wrapper; prevents inherited transport or browser authority.                |
| `FARMSLOT_BLIND_SEATBELT`         | Assigned by the boundary wrapper; prevents inherited transport or browser authority.                |
| `CDP_PORT`                        | Assigned by the boundary wrapper; prevents inherited transport or browser authority.                |
| `RECIPE_CDP_PORT`                 | Assigned by the boundary wrapper; prevents inherited transport or browser authority.                |
| `GIT_TRACE2_EVENT`                | Assigned by the boundary wrapper; prevents inherited transport or browser authority.                |
| `GIT_TRACE2_EVENT_NESTING`        | Assigned by the boundary wrapper; prevents inherited transport or browser authority.                |
| `GIT_SSH_COMMAND`                 | Assigned by the boundary wrapper; prevents inherited transport or browser authority.                |
| `GIT_CONFIG_COUNT`                | Assigned by the boundary wrapper; prevents inherited transport or browser authority.                |
| `GIT_CONFIG_KEY_0`                | Assigned by the boundary wrapper; prevents inherited transport or browser authority.                |
| `GIT_CONFIG_VALUE_0`              | Assigned by the boundary wrapper; prevents inherited transport or browser authority.                |
| `GIT_CONFIG_KEY_1`                | Assigned by the boundary wrapper; prevents inherited transport or browser authority.                |
| `GIT_CONFIG_VALUE_1`              | Assigned by the boundary wrapper; prevents inherited transport or browser authority.                |

The runner registry's `blindModelEnvironment` capability adds the runner's
model authentication, endpoint and provider configuration variables. Authentication
entries are deliberate credential exceptions. Native runner keys stay visible to
that model's tools just as its own login files are. Pi's provider extension holds
the router, LiteLLM and Ollama keys it registers and removes them from its
environment before any tool shell starts; Pi's built-in providers read their keys
from the environment per request, so those remain visible to Pi's tool shells.

| Runner or selected provider            | Additional exact entries                                                                     | Reason                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Claude                                 | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` | Authenticate the Claude runner and select its endpoint.                                                  |
| Codex                                  | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, `CODEX_LB_API_KEY`                     | Authenticate the Codex runner and its configured model endpoint.                                         |
| Cursor                                 | `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`                                                        | Authenticate Cursor.                                                                                     |
| Grok                                   | `GROK_API_KEY`, `XAI_API_KEY`                                                                | Authenticate Grok.                                                                                       |
| Pi or OpenCode, `openai/…`             | `OPENAI_API_KEY`, `OPENAI_BASE_URL`                                                          | Authenticate only the selected provider.                                                                 |
| Pi or OpenCode, `anthropic/…`          | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`                                                    | Authenticate only the selected provider.                                                                 |
| Pi or OpenCode, `xai/…`                | `XAI_API_KEY`, `XAI_BASE_URL`                                                                | Authenticate only the selected provider.                                                                 |
| Pi or OpenCode, `groq/…`               | `GROQ_API_KEY`                                                                               | Authenticate only the selected provider.                                                                 |
| Pi or OpenCode, `google/…`             | `GEMINI_API_KEY`                                                                             | Authenticate only the selected provider.                                                                 |
| Pi or OpenCode, `openrouter/…`         | `OPENROUTER_API_KEY`                                                                         | Authenticate only the selected provider.                                                                 |
| Pi or OpenCode, `litellm/…`            | `LITELLM_API_KEY`, `LITELLM_BASE_URL`                                                        | Authenticate only the selected provider.                                                                 |
| Pi or OpenCode, `codex-lb/…`           | `CODEX_LB_API_KEY`                                                                           | Authenticate only the selected provider.                                                                 |
| Pi, configured router id or `router/…` | `FARMSLOT_PI_ROUTER_KEY`                                                                     | Authenticate only the selected router.                                                                   |
| Pi, `ollama/…`                         | `OLLAMA_API_KEY`                                                                             | Authenticate only Ollama.                                                                                |
| Other providers                        | None                                                                                         | Use runner-owned model/auth configuration; never infer credential names from arbitrary parent variables. |

Pi admits shared non-secret timeout, mode, debug and workspace trust settings
from `PI_CONFIG_ENVIRONMENT`. The extension's `piProviderEnvironment` export adds
only the selected provider's endpoint, authentication and context, token,
reasoning and per-model limit settings. Router selection uses the configured
machine router id, including `sparks` or `localsparks`, or its `router` alias.
Unselected provider configuration and keys remain absent. Blind discovery uses
`FARMSLOT_MODEL` to restrict sources, including default Ollama discovery, and
never falls back from the router key to the LiteLLM key.

Pi's default and unqualified `grok-*` models resolve to `xai/…` through its shared
model adapter. Custom providers that require another environment name must add
an exact capability entry and a regression test. Prefer the runner's own config
for custom provider authentication.

## Shell startup files

`BASH_ENV`, `ENV` and the operator's `ZDOTDIR` never cross `env -i`. The wrapper
sets `ZDOTDIR` to the capsule's empty `boundary/shell`. Seatbelt also denies reads
and writes of the operator's zsh and bash startup files and histories,
`~/.config/secrets`, `~/.netrc`, `~/.npmrc`, `~/.yarnrc(.yml)`, `~/.pypirc`,
`~/.docker/config.json`, `~/.git-credentials`, `~/.aws`, `~/.kube/config`,
`~/.gnupg` and the checkout's `.agent/.launch` scripts, with each resolved symlink
target. A worker that resets `ZDOTDIR` or runs `bash -l` still reads none of them.
Tools that read those files for registry authentication see them as absent.

Tmux launch scripts live in the slot runtime beside each checkout
(`<parent>/.farmslot-runtime/<slot>/.agent/.launch`, from `runnerLaunchDir`), and
a non-blind one inlines its pool credentials. The gateway passes every slot's
launch directory to the boundary. Seatbelt denies reads, writes and links in each
`.farmslot-runtime` tree except the trial's own slot runtime, which holds its
runner homes and observability bundle. It also denies every launch directory,
the trial's own included, and any `.farmslot-runtime/*/.agent/.launch` path.
Boundary preparation creates the own slot runtime, since the worker cannot create
it inside the denied tree. Measured in a live launch, the worker writes only
`.agent/.observability` there; the gateway writes `.agent/.launch` from outside.

## Launch shells

A blind tmux launch (fresh dispatch, retained reload and parked-worker reload)
starts its pane as `exec bash --noprofile --norc -c <stage>`. The stage execs
`/usr/bin/env -i` into a startup-file-free bash holding only `HOME`, `USER`,
`LOGNAME`, `PATH`, `SHELL`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`,
`LC_MESSAGES`, `TZ`, `TERM`, `COLORTERM`, `NO_COLOR`, `TMUX` and `TMUX_PANE`. The
values of the worker's exact names (the table above plus its model entries) reach
the launch script on fd 3. The script keeps them in an unexported array and
exports them only inside the worker subshell, which then runs the boundary's
`env -i`. Pool `env` entries outside those names are not written into the
launch script. The script body runs in that shell, never in a child's argv.

The pane's own shell and the stage are replaced by `exec`. The stage's
substitution child, which writes the values to fd 3, exits once they are
written. The long-lived
ancestors of the sandboxed worker are the launch bash and its worker subshell.
Both start with only the names above, and neither argv carries a value. Only
the sandboxed chain (`sandbox-exec`'s `/bin/sh` and the runner) holds the model
key. Non-blind launches are unchanged: they still run `bash <script>` and
`bash -lc`.

The launch body no longer runs as a login shell, so `~/.bash_profile` does not
add to `PATH`. A blind worker's `PATH` is the pane's `PATH` plus the pool's.

`blind-launch-env.live.ts` launches a synthetic Pi worker through both production
paths on a private tmux server. It reads every ancestor up to the server through
`KERN_PROCARGS2`. macOS returns no environment for Apple platform binaries such
as `/bin/sh` and `/bin/bash`, so that test runs the launch shells with a
Homebrew bash, as an operator's `PATH` usually does.

## Trial browser routing

`FARMSLOT_BLIND_CDP_PORT` carries the boundary's allocated browser port separately
from the generic adapter variables. Recipe slot hydration and explicit recipe
CDP flags use that allocation. Application and Metro ports retain their existing
selection rules. Non-blind recipes retain slot and explicit-flag precedence.

| Entry                                         | Reason                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `FARMSLOT_BLIND_CDP_PORT`                     | Assigned by the launch boundary; preserves trial browser ownership across adapter slot hydration. |
| `RECIPE_TASK_DIR`                             | Locates the admitted recipe task and its artifacts.                                               |
| `RECIPE_SLOT_ID`                              | Identifies the recipe slot to adapter tools.                                                      |
| `IOS_SIMULATOR`, `SIM_UDID`, `ANDROID_DEVICE` | Preserve the assigned Mobile device names consumed by adapter tools.                              |

## Trial temporary files and Mobile broker

The boundary allocates a mode-0700 directory under `/private/tmp/fs-blind-*`,
retains its protected `boundary/tmp` link across launches, and removes the
directory during restoration. The wrapper assigns `TMPDIR`, `TMP`, `TEMP` and
`MAC_CHROMIUM_TMPDIR` from that link, replacing ambient values. Chromium on macOS
uses the latter for its singleton socket directory; `TMPDIR` alone does not
redirect it. The boundary also creates a fixed `broker` child directory and sets
`FARMSLOT_BLIND_BROKER_DIR` there. The shared broker package puts hashed socket
paths there and ownership sidecars in general trial temp, outside `broker`.
Non-blind broker paths remain independent of `TMPDIR`.

Seatbelt denies shared temporary writes, including `/tmp`, `/var/tmp` and
`/var/folders`, then admits the trial directory and existing task write scope.
Outbound Unix connections admit the resolver and direct children of `broker`,
using an anchored regex with escaped literal paths from the validated physical
allocation and its `/tmp` alias. Logical capsule paths grant no connect access.
That directory admits only socket vnodes, so
workers cannot create or import directories, regular files or symlinks there,
or move or replace the directory itself. Other
trials' socket connections, writes, chmod, unlink and directory renames remain
denied, including through symlinks in the admitted directory. The boundary bin,
routing link and existing private inputs remain protected after these allowances.
Seatbelt denies writes and hardlinks on socket vnodes outside the trial directory.
It also denies socket unlink and hardlink outside `broker`, so moving a containing
directory into general temp cannot enable a second-step socket import. Chromium
can bind its singleton in general temp, but that socket has no connect allowance.
The harness reuses its browser through TCP CDP; Metro also uses TCP. Neither
needs another Unix-connect exception.

macOS refuses the setuid `/bin/ps` inside Seatbelt, and the profile also denies
executing it. Boundary preparation copies the installed system binary to
`boundary/libexec/ps`, removes setuid and signs the copy ad hoc. The protected
`boundary/bin/ps` on PATH is a wrapper for harness identity and health calls
(`-o lstart=`, `-axo pid=,command=` and similar). It refuses every
environment-printing form: `-E`, BSD-style `e` in any cluster (`eww`, `axe`),
and `-e`, which legacy mode reads as environment (use `-A`). It runs the copy
with `COMMAND_MODE=unix2003`. It gains no process-info allowance. Seatbelt
target filters do not restrict `ps`'s sysctl process-table reads, so process
listing is not confined to the trial's descendants. No outside-sandbox process
helper is used.

### Residual: other processes' environments

The wrapper closes the casual route only. The worker runs as the operator's uid,
and the kernel returns any same-uid process's start-up environment through the
`KERN_PROCARGS2` sysctl. A deliberate numeric read (for example `python3`
ctypes, or running `boundary/libexec/ps` directly) still shows the gateway's,
the tmux server's and other panes' environments. The trial's own launch shells
hold no credential (see Launch shells). The tmux server keeps the environment of
whoever started it, which usually includes operator credentials. Seatbelt cannot block it on
macOS 27.2. Measured on a fake process with these rules added: `(deny
process-info* (target others))`, `(deny process-info-pidinfo (target others))`,
`(deny sysctl-read (sysctl-name "kern.procargs2"))`, `sysctl-name-prefix
"kern.procargs"` and `"kern.proc"`, and `(deny syscall-unix (syscall-number
202))` all leave the read working. `(deny sysctl-read)` stops `ps` only because
it reads `kern.argmax` first, still leaves the numeric read working, and aborts
Node. `(deny process-info*)` aborts Python. The fix is to run blind workers
under a separate macOS uid; that is follow-up work.

Mobile producers and clients must use a broker package version supporting this
directory override. A harness pinned to an earlier package still uses `/tmp` and
will fail closed. Changing `TMPDIR` alone cannot redirect that older broker.

## Review regressions

The manual `blind-seatbelt.live.ts` scenarios execute the production fresh and
retained Pi launch commands with synthetic pool-only provider configuration.
They assert registered provider identity, model limits/reasoning, selected auth
and absence of registry and unselected auth keys. The hosted static scenario
initializes through the production CLI source snapshot, re-initializes the same
retained receipt, and runs `./mark` inside Seatbelt after each initialization.
Both mark checks must pass while the boundary source stays outside the pin.
The lookalike capsule regression renames a synthetic external socket's directory
into `_farmslot-blind-evals/.../boundary/tmp/broker` and checks that a relative
connect fails with `EPERM`, while both physical broker aliases still connect.
