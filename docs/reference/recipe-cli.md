# Recipe CLI reference

Generated from the command registration used by `--help` and shell completion. Do not edit this page by hand.

Start with [Recipe concepts](./recipe-concepts.md). Run `farmslot --help` for global options.

Project-specific launch and execution flags come from the selected provider's strict command grammar. The host validates those flags before constructing the provider.

## farmslot recipe

```text
Usage: farmslot recipe [options] [command]

Checkout recipes and artifact helpers

Options:
  -h, --help                       display help for command

Commands:
  quality                          Build canonical quality artifacts or request
                                   explicit project advice
  actions [options] [query]        Discover actions from the selected project provider
                                   and libraries
  status [options]                 Status the selected project runtime
  launch [options] [args...]       Launch the selected project runtime
  reload [options]                 Reload the selected project runtime
  stop [options]                   Stop the selected project runtime
  logs [options]                   Logs the selected project runtime
  call [options] [args...]         Run one action through the selected project provider
  validate [options] <recipes...>  Validate one or more recipe graphs (and an optional
                                   artifact package) against the Farmslot Recipe v1
                                   contract
  artifacts [options] [directory]  Inspect, validate or render retained recipe evidence
  project-hook                     Inspect or execute Recipe v1 project hooks through
                                   the Farmslot gateway
  run [options] [args...]          Run a recipe through the selected project provider
  help [command]                   display help for command
```

## farmslot recipe quality

```text
Usage: farmslot recipe quality [options] [command]

Build canonical quality artifacts or request explicit project advice

Options:
  -h, --help                display help for command

Commands:
  build [options]           Validate and build the quality artifact
  plan [options]            Request explicit recipe plan
  advise [options]          Request explicit recipe advise
  advisor-status [options]  Inspect advisor policy without requesting advice
  help [command]            display help for command
```

## farmslot recipe quality build

```text
Usage: farmslot recipe quality build [options]

Validate and build the quality artifact

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --target <path>                Product checkout
  --input <path>                 Compact quality verdict
  --output <path>                Output artifact
  -h, --help                     display help for command
```

## farmslot recipe quality plan

```text
Usage: farmslot recipe quality plan [options]

Request explicit recipe plan

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --target <path>                Product checkout
  --input <path>                 Compact quality verdict
  --output <path>                Output artifact
  --recipe <path>
  --task <path>
  --evidence <path>
  --params <json>
  --advisor <provider>
  --advisor-model <model>
  --advisor-stages <csv>
  -h, --help                     display help for command
```

## farmslot recipe quality advise

```text
Usage: farmslot recipe quality advise [options]

Request explicit recipe advise

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --target <path>                Product checkout
  --input <path>                 Compact quality verdict
  --output <path>                Output artifact
  --recipe <path>
  --task <path>
  --evidence <path>
  --params <json>
  --advisor <provider>
  --advisor-model <model>
  --advisor-stages <csv>
  -h, --help                     display help for command
```

## farmslot recipe quality advisor-status

```text
Usage: farmslot recipe quality advisor-status [options]

Inspect advisor policy without requesting advice

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --target <path>                Product checkout
  --input <path>                 Compact quality verdict
  --output <path>                Output artifact
  --recipe <path>
  --task <path>
  --evidence <path>
  --params <json>
  --advisor <provider>
  --advisor-model <model>
  --advisor-stages <csv>
  -h, --help                     display help for command
```

## farmslot recipe actions

```text
Usage: farmslot recipe actions [options] [query]

Discover actions from the selected project provider and libraries

Arguments:
  query                          Search the action catalog

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --target <path>                Checkout to inspect
  --action <name>                Show one action and its input schema
  --category <name>              Filter by action category
  --categories                   List action categories
  --matrix                       Show action support across the provider runtimes
  --raw                          Print the resolved action manifest
  --action-manifest <path>       Select an action manifest
  -h, --help                     display help for command
```

## farmslot recipe status

```text
Usage: farmslot recipe status [options]

Status the selected project runtime

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --target <path>                Checkout to inspect or operate
  --fast                         Skip live readiness probes
  --watch                        Watch the current task without changing it
  --task <path>                  Inspect a specific task
  --all-devices                  Include all discovered devices
  -h, --help                     display help for command
```

## farmslot recipe launch

```text
Usage: farmslot recipe launch [options] [args...]

Launch the selected project runtime

Arguments:
  args                           Provider-specific launch options

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --target <path>                Checkout to inspect or operate
  --verify                       Verify the launched runtime is ready
  --json-stream                  Stream JSONL progress and a terminal result
  --heal <policy>                Healing policy (choices: "off", "infra-only", "auto")
  -h, --help                     display help for command
```

## farmslot recipe reload

```text
Usage: farmslot recipe reload [options]

Reload the selected project runtime

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --target <path>                Checkout to inspect or operate
  -h, --help                     display help for command
```

## farmslot recipe stop

```text
Usage: farmslot recipe stop [options]

Stop the selected project runtime

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --target <path>                Checkout to inspect or operate
  -h, --help                     display help for command
```

## farmslot recipe logs

```text
Usage: farmslot recipe logs [options]

Logs the selected project runtime

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --target <path>                Checkout to inspect or operate
  --source <name>                Select one runtime log source
  --full                         Follow the entire selected log without filtering
  --lines <count>                Number of initial raw log lines
  --events <count>               Number of compact events to follow
  --window                       Reopen the owned primary log window
  --follow                       Follow the selected log until interrupted
  -h, --help                     display help for command
```

## farmslot recipe call

```text
Usage: farmslot recipe call [options] [args...]

Run one action through the selected project provider

Arguments:
  args                           Action followed by key=value inputs

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --target <path>                Checkout to execute against
  --artifacts-dir <path>         Checkout-relative artifact directory
  --action-manifest <path>       Select an action manifest
  --heal <policy>                Healing policy (choices: "off", "infra-only", "auto")
  --hud <mode>                   Evidence HUD (choices: "show", "hide")
  --record-video [mode]          Record evidence (choices: "full-run", "off")
  --recording-reason <text>      Explain an explicit recording opt-out
  --source-trust <trust>         Explicit recipe source trust
  --source-kind <kind>           Explicit recipe source kind
  --source-name <name>           Recipe source name
  --source-digest <digest>       Recipe source digest
  --approve-plan <digest>        Approve an exact execution plan
  --list                         List callable actions
  --domain <name>                Filter listed actions by domain
  --source <name>                Filter listed actions by source
  --sort <field>                 Group listed actions (choices: "domain", "name",
                                 "library")
  -h, --help                     display help for command
```

## farmslot recipe validate

```text
Usage: farmslot recipe validate [options] <recipes...>

Validate one or more recipe graphs (and an optional artifact package) against the
Farmslot Recipe v1 contract

Arguments:
  recipes                     Path(s) to recipe.json files

Options:
  --action-manifest <path>    Path to runner action manifest to validate recipe actions
  --artifact-manifest <path>  Path to artifact-manifest.json to validate (single recipe
                              only)
  --artifact-dir <path>       Artifact directory; validates required package files and
                              manifest paths (single recipe only)
  --library-source <spec>     Recipe library source (name=path or path,
                              colon-separated); repeatable. call.refs resolvable here
                              are not reported as unresolved. (default: [])
  -h, --help                  display help for command
```

## farmslot recipe artifacts

```text
Usage: farmslot recipe artifacts [options] [command] [directory]

Inspect, validate or render retained recipe evidence

Arguments:
  directory                           Artifact package or task directory; defaults to
                                      the latest proof

Options:
  --project <name>                    Select a registered project
  --projects-dir <path>               Operator-owned project registry
  --authorize-provider <module>       Authorize an exact discovered provider source
                                      (default: [])
  --adapter <name>                    Select the project runtime
  --app <name>                        Select a monorepo app
  --slot <id>                         Select one pool slot
  --device <id>                       Select one device
  --platform <name>                   Select a provider platform
  --watcher-port <port>               Select the app transport port
  --cdp-port <port>                   Select the CDP transport port
  --runtime-dir <path>                Target-relative recipe runtime directory
  --library <name=path>               Override a recipe library (default: [])
  --target <path>                     Checkout whose latest proof to inspect
  --validate                          Validate the artifact package and runner
                                      provenance
  --format <format>                   Output format (choices: "text", "markdown")
  -h, --help                          display help for command

Commands:
  validate [options] <artifacts-dir>  Validate a Recipe v1 artifact package directory
```

## farmslot recipe artifacts validate

```text
Usage: farmslot recipe artifacts validate [options] <artifacts-dir>

Validate a Recipe v1 artifact package directory

Arguments:
  artifacts-dir                Directory containing summary.json, trace.json, and
                               artifact-manifest.json

Options:
  --recipe <path>              Resolved recipe.json used for node/artifact cross-checks
  --require-runner-provenance  Require runner provenance in summary, trace metadata,
                               and artifact manifest
  -h, --help                   display help for command
```

## farmslot recipe project-hook

```text
Usage: farmslot recipe project-hook [options] [command]

Inspect or execute Recipe v1 project hooks through the Farmslot gateway

Options:
  -h, --help                display help for command

Commands:
  command [options] <hook>  Print the expanded project hook command for a slot
  run [options] <hook>      Run a Recipe v1 project hook for a slot and check its
                            hook-level output contract
  help [command]            display help for command
```

## farmslot recipe project-hook command

```text
Usage: farmslot recipe project-hook command [options] <hook>

Print the expanded project hook command for a slot

Arguments:
  hook                    recipe_action_manifest, recipe_doctor, or recipe_run

Options:
  --project <project>     Farmslot project name
  --slot <slot>           Farmslot slot id
  --recipe-path <path>    Recipe path on the slot filesystem for recipe_run hooks
  --artifacts-dir <path>  Artifact output directory on the slot filesystem; required
                          for recipe_run hooks
  -h, --help              display help for command
```

## farmslot recipe project-hook run

```text
Usage: farmslot recipe project-hook run [options] <hook>

Run a Recipe v1 project hook for a slot and check its hook-level output contract

Arguments:
  hook                    recipe_action_manifest, recipe_doctor, or recipe_run

Options:
  --project <project>     Farmslot project name
  --slot <slot>           Farmslot slot id
  --recipe-path <path>    Recipe path on the slot filesystem for recipe_run hooks
  --artifacts-dir <path>  Artifact output directory on the slot filesystem; required
                          for recipe_run hooks
  --timeout-ms <ms>       Hook timeout in milliseconds; defaults to 60000
  -h, --help              display help for command
```

## farmslot recipe run

```text
Usage: farmslot recipe run [options] [args...]

Run a recipe through the selected project provider

Arguments:
  args                           Recipe followed by key=value inputs

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --target <path>                Checkout to execute against
  --artifacts-dir <path>         Checkout-relative artifact directory
  --action-manifest <path>       Select an action manifest
  --heal <policy>                Healing policy (choices: "off", "infra-only", "auto")
  --hud <mode>                   Evidence HUD (choices: "show", "hide")
  --record-video [mode]          Record evidence (choices: "full-run", "off")
  --recording-reason <text>      Explain an explicit recording opt-out
  --source-trust <trust>         Explicit recipe source trust
  --source-kind <kind>           Explicit recipe source kind
  --source-name <name>           Recipe source name
  --source-digest <digest>       Recipe source digest
  --approve-plan <digest>        Approve an exact execution plan
  --list                         List recipes
  --domain <name>                Filter listed actions by domain
  --source <name>                Filter listed actions by source
  --sort <field>                 Group listed actions (choices: "domain", "name",
                                 "library")
  --plan                         Validate the complete execution plan without running
                                 it
  --describe                     Describe one recipe and its dependencies
  --proof                        With --plan, preflight behavioral proof bindings
  --json-stream                  Stream JSONL progress and a terminal result
  --project-root <path>          Use explicit standalone core execution with a manifest
                                 and artifact directory
  --library-source <spec>        Standalone recipe library source; repeatable (default:
                                 [])
  -h, --help                     display help for command
```

## farmslot doctor

```text
Usage: farmslot doctor [options] [checkout]

Check installation or a checkout project and recipe conformance

Arguments:
  checkout                       Checkout to inspect

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --record-video [mode]          Record evidence (choices: "full-run", "off")
  --recording-reason <text>      Explain an explicit recording opt-out
  --target <path>                Checkout to inspect; alternative to the checkout
                                 argument
  --fix                          Repair declared project readiness problems
  --expect-live                  Require the selected runtime to be ready
  --print-ready                  Print the project health indicator when ready
  --all-devices                  Include all discovered devices in readiness output
  --json-stream                  Stream explicit repairs and their terminal result
  --action-manifest <path>       Select an action manifest
  --domain <name>                Select the recipe domain for conformance
  --conformance                  Check provider, libraries, handlers and full recipe
                                 preflight
  --live                         Execute one bounded smoke after conformance preflight
  --check-report <path>          Verify a saved report against current sources and
                                 retained proof
  --disposable                   Confirm this smoke target is disposable
  --smoke-target <id>            Declared runtime proof target to verify
  --teardown-target <id>         Declared proof target asserted in authored teardown
  --run <id>                     Existing Gateway run that owns the selected pool
                                 target
  --live-timeout-ms <ms>         Live smoke execution deadline in milliseconds
                                 (default: "120000")
  --approve-plan <digest>        Explicit approval of an execution plan
  --artifacts-dir <path>         Checkout-relative conformance report directory
  --report-name <name>           Conformance report filename within its artifact
                                 directory
  --recipe <ref>                 Check a specific invocation instead of the declared
                                 defaults (default: [])
  --param <key=value>            Supply checked invocation parameters (default: [])
  --source-trust <trust>         Explicit recipe source trust
  --source-kind <kind>           Explicit recipe source kind
  -h, --help                     display help for command
```

## farmslot task

```text
Usage: farmslot task [options] [command]

Initialize, verify and close tasks with retained tooling

Options:
  -h, --help                                  display help for command

Commands:
  init [options] <task-dir>                   Create a task from an execution template
  verify <task-dir>                           Verify retained task tooling without
                                              running it
  mark [options] <task-dir> <step> [args...]  Mark task progress through provider gates
  closeout [options] <task-dir>               Stage task closeout under project policy
  help [command]                              display help for command
```

## farmslot task init

```text
Usage: farmslot task init [options] <task-dir>

Create a task from an execution template

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --target <path>                Product checkout
  --flow <flow>                  Execution flow
  --template <id>                Execution template
  --title <text>                 Task title
  --run-mode <mode>              Execution mode (choices: "interactive", "autonomous",
                                 "validation")
  --domain <name>                Domain selection
  --task-text <text>             Task description
  --task-file <path>             Read the task description
  --ticket <key>                 Ticket identity
  --source-ref <ref>             Task source
  --surface <surface>            Task surface
  --repo <owner/name>            Repository identity
  --attempt-id <id>              Attempt identity
  --task-dir-label <label>       Rendered task directory
  --mode-preamble <text>         Mode instructions
  --addendum-file <path>         Authored task addendum
  --project-worker <path>        Project worker templates
  --project-name <name>          Project template identity
  --package-templates <path>     Package template catalog
  --package-id <id>              Package template identity
  --dir <path>                   Template source (default: [])
  --domain-dir <name=path>       Domain templates (default: [])
  --var <key=value>              Template variable (default: [])
  --acceptance <criterion>       Acceptance criterion (default: [])
  -h, --help                     display help for command
```

## farmslot task verify

```text
Usage: farmslot task verify [options] <task-dir>

Verify retained task tooling without running it

Options:
  -h, --help  display help for command
```

## farmslot task mark

```text
Usage: farmslot task mark [options] <task-dir> <step> [args...]

Mark task progress through provider gates

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --reason <text>
  --checklist <path>
  --signal <path>
  --who <name>
  --report <path>
  --skip-learnings
  --mark-last
  --already-fixed
  --no-review
  --skip-checklist
  --allow-empty
  --step <number>
  --from <path>
  --var <key=value>              Subtask template variable (default: [])
  -h, --help                     display help for command
```

## farmslot task closeout

```text
Usage: farmslot task closeout [options] <task-dir>

Stage task closeout under project policy

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --share                        Explicitly share the staged learning package
  --config <path>
  --destination <path>
  --metadata <json>
  -h, --help                     display help for command
```

## farmslot review

```text
Usage: farmslot review [options] [command]

Compose review rules from the selected project and libraries

Options:
  -h, --help           display help for command

Commands:
  checklist [options]  Materialize a review checklist
  domain [options]     Resolve ownership of changed files
  help [command]       display help for command
```

## farmslot review checklist

```text
Usage: farmslot review checklist [options]

Materialize a review checklist

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --target <path>                Checkout to review
  --domain <name>                Declared domain
  --base <ref>                   Diff base
  --since <ref>                  Incremental review since this revision
  --out <path>                   Write the generated checklist
  -h, --help                     display help for command
```

## farmslot review domain

```text
Usage: farmslot review domain [options]

Resolve ownership of changed files

Options:
  --project <name>               Select a registered project
  --projects-dir <path>          Operator-owned project registry
  --authorize-provider <module>  Authorize an exact discovered provider source
                                 (default: [])
  --adapter <name>               Select the project runtime
  --app <name>                   Select a monorepo app
  --slot <id>                    Select one pool slot
  --device <id>                  Select one device
  --platform <name>              Select a provider platform
  --watcher-port <port>          Select the app transport port
  --cdp-port <port>              Select the CDP transport port
  --runtime-dir <path>           Target-relative recipe runtime directory
  --library <name=path>          Override a recipe library (default: [])
  --target <path>                Checkout to review
  --domain <name>                Declared domain
  --base <ref>                   Diff base
  -h, --help                     display help for command
```
