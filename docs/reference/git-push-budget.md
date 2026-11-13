# Git push budget

Farm-owned Git commands using OpenSSH add SSH `ServerAliveInterval=20` and
`ServerAliveCountMax=30`. They preserve the existing `GIT_SSH_COMMAND`,
`core.sshCommand`, or `GIT_SSH` transport and its arguments. Existing SSH options
take precedence. Git's `ssh.variant` and `GIT_SSH_VARIANT` select the transport
contract, with Git-compatible command detection and `-G` probing for auto.
Plink, PuTTY and simple transports keep their original arguments. HTTPS keeps its normal transport. No Git or SSH configuration
files are changed.

Publication and branch-maintenance pushes allow 900000 milliseconds, fifteen
minutes, including repository pre-push hooks. Worker commands generated in
TASK.md, inline CI fixes and gateway pushes share the same helper. Generated
worker commands carry the effective project or pool budget; standalone runtime
commands read the setting from their environment. Fetch and verification probes keep
their shorter budgets. Hooks run normally.

Set `FARMSLOT_GIT_PUSH_TIMEOUT_MS` to a positive integer string in project.json
`command_env.set` or pool JSON `env`. Pool values take precedence. Values above
2147483647 milliseconds are rejected because Node timers cannot represent them.
For example, this project setting gives hooks and the push twenty minutes:

```json
{
  "command_env": {
    "set": { "FARMSLOT_GIT_PUSH_TIMEOUT_MS": "1200000" }
  }
}
```

A timed-out push reports the effective budget and the setting to increase.
Publication stops before PR metadata is published.
