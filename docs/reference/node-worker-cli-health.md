# Node worker CLI verification health

Node deployment verifies the deployed CLI in a worker shell. Every tmux client used by that probe, including cleanup, has a deadline of at most five seconds, shortened by an explicitly smaller `CLI_VERIFY_TIMEOUT_SECONDS`. Deadline expiry fails the deployment with `tmux server unresponsive on <machine>`. It must never fall back to a plain shell after an unresponsive server. A missing server still uses the existing plain-shell fallback. Only the probe client is terminated; the tmux server is never killed.

The existing CLI-body deadline remains 120 seconds by default. Probe cleanup has its own bounded tmux call. No tmux operation may execute outside that wrapper.

A dev deployment atomically records its worker verification result at the dev node's selected home, `node-worker-cli-health.json`. Cleanup failure overrides an otherwise successful result. The next node metrics sample carries `workerCliHealth` outside the system gauges. A failed result makes machine headroom red and appears as a critical resource-pressure concern. Only a subsequent successful verification clears it. An absent receipt means this deployment has not published a result; it does not invent a failure or a pass. Unreadable or invalid receipts report a failure.

## Public surface

Existing `node.health`, `node.health.all` and `fleet.status` responses gain optional `WorkerCliHealth` diagnostics through `@farmslot/protocol` types. The private node sampler produces them; gateway fleet and pressure readers consume them. No new RPC, provider contract or harness flag is introduced. `scripts/deploy-node.sh --instance dev` writes the receipt using the dev instance's existing home selection.
