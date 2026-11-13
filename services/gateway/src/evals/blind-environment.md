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
| `TMPDIR`                          | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
| `TMP`                             | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
| `TEMP`                            | Standard process identity, executable search, temporary storage, locale or terminal rendering.      |
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

The runner registry's `blindModelEnvironment` capability adds only the runner's
model authentication and endpoint variables. These are deliberate credential
exceptions, visible to that model's tools just as its own login files are.

| Runner or selected provider           | Additional exact entries                                                                     | Reason                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Claude                                | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` | Authenticate the Claude runner and select its endpoint.                                                  |
| Codex                                 | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, `CODEX_LB_API_KEY`                     | Authenticate the Codex runner and its configured model endpoint.                                         |
| Cursor                                | `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`                                                        | Authenticate Cursor.                                                                                     |
| Grok                                  | `GROK_API_KEY`, `XAI_API_KEY`                                                                | Authenticate Grok.                                                                                       |
| Pi or OpenCode, `openai/…`            | `OPENAI_API_KEY`, `OPENAI_BASE_URL`                                                          | Authenticate only the selected provider.                                                                 |
| Pi or OpenCode, `anthropic/…`         | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`                                                    | Authenticate only the selected provider.                                                                 |
| Pi or OpenCode, `xai/…`               | `XAI_API_KEY`, `XAI_BASE_URL`                                                                | Authenticate only the selected provider.                                                                 |
| Pi or OpenCode, `groq/…`              | `GROQ_API_KEY`                                                                               | Authenticate only the selected provider.                                                                 |
| Pi or OpenCode, `google/…`            | `GEMINI_API_KEY`                                                                             | Authenticate only the selected provider.                                                                 |
| Pi or OpenCode, `openrouter/…`        | `OPENROUTER_API_KEY`                                                                         | Authenticate only the selected provider.                                                                 |
| Pi or OpenCode, `litellm/…`           | `LITELLM_API_KEY`, `LITELLM_BASE_URL`                                                        | Authenticate only the selected provider.                                                                 |
| Pi or OpenCode, `codex-lb/…`          | `CODEX_LB_API_KEY`                                                                           | Authenticate only the selected provider.                                                                 |
| Other providers, including `sparks/…` | None                                                                                         | Use runner-owned model/auth configuration; never infer credential names from arbitrary parent variables. |

Pi's default and unqualified `grok-*` models resolve to `xai/…` through its shared
model adapter. Custom providers that require another environment name must add
an exact capability entry and a regression test. Prefer the runner's own config
for custom provider authentication.

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
