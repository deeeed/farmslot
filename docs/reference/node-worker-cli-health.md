# Node worker CLI verification health

Node deployment verifies the deployed CLI in a worker shell. Every tmux client used by that probe, including cleanup, has a deadline of at most five seconds, shortened by an explicitly smaller `CLI_VERIFY_TIMEOUT_SECONDS`. Deadline expiry fails the deployment with `tmux server unresponsive on <machine>`. It must never fall back to a plain shell after an unresponsive server. A missing server still uses the existing plain-shell fallback. Only the probe client is terminated; the tmux server is never killed.

The existing CLI-body deadline remains 120 seconds by default. Probe cleanup has its own bounded tmux call. No tmux operation may execute outside that wrapper.

A dev deployment atomically records its worker verification result at the dev node's selected home, `node-worker-cli-health.json`. Cleanup failure overrides an otherwise successful result. The next node metrics sample carries `workerCliHealth` outside the system gauges. A failed result makes machine headroom red and appears as a critical resource-pressure concern. Only a subsequent successful verification clears it. An absent receipt means this deployment has not published a result; it does not invent a failure or a pass. Unreadable or invalid receipts report a failure.

## Public surface

Existing `node.health`, `node.health.all` and `fleet.status` responses gain optional `WorkerCliHealth` diagnostics through `@farmslot/protocol` types. The private node sampler produces them; gateway fleet and pressure readers consume them. No new RPC, provider contract or harness flag is introduced. `scripts/deploy-node.sh --instance dev` writes the receipt using the dev instance's existing home selection.

## Peer version compatibility

Proposed under [ADR-008 Amendment 2](../adr/008-remote-communication.md#amendment-2-declared-peer-version-compatibility-2026-11-07).

Each new `node.connect` request and successful reply MUST declare `protocolVersion`, `minimumProtocolVersion`, `runtimeVersion` and `minimumRuntimeVersion`. Versions are published numeric `major.minor.patch` releases. `minimumProtocolVersion` and `minimumRuntimeVersion` name the oldest peer releases that side supports. The installed runtime package manifest supplies `runtimeVersion`; task pins are not rewritten.

For each protocol/runtime pair, admission MUST accept exactly when neither supplied version is below the other side's declared minimum. It MUST NOT infer a break from a different minor or major number. The initial floors are protocol `0.76.0` and runtime `0.42.0`. A missing legacy version or floor is unverified, not an invented incompatibility. A malformed supplied declaration is an explicit configuration error.

`nodes.list.gatewayCompatibility` carries the gateway's four declarations; each `NodeInfo` carries the node's declarations and optional `compatibilityReason`.

The gateway handshake, node handshake and worker source preflight MUST consume one shared comparison. A declared break MUST refuse before worker launch with the component, actual version and unmet minimum. The gateway MUST check both bounds from the `node.connect` request before changing registry, native-owner or conversation state, so an incompatible reconnect cannot displace a healthy connection. Refusal uses `PROTOCOL_INCOMPATIBLE`; malformed declarations use `INVALID_PARAMS`. Both are deterministic handshake failures. A node that receives an incompatible reply MUST close its connection and use deterministic backoff. Legacy gateways retain their existing checks until the single coordinated activation; this change does not certify an old binary as upgraded.

The protocol `0.76.0` floor covers additive or capability-gated node-facing changes through this cut. The runtime `0.42.0` floor protects the selected runtime imported by the worker probe across the cleanup Promise boundary; it does not rewrite task pins.

| Consumer                                                         | Required behavior                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway registration, inventory and `node.version.mismatch`      | Check declared bounds before side effects; expose all four fields through `nodes.list`; `versionMatch` and mismatch events report declared compatibility, never raw inequality.                                                                                                                                                              |
| Worker source probe                                              | Report selected protocol version/floor and runtime manifest version/floor as facts. The gateway applies the shared comparison; legacy selected packages need not export the new helper. Retained provenance checks still run. Package-version warnings remain diagnostic and MUST NOT downgrade otherwise verified compatibility/provenance. |
| CLI, Command Center version displays and orchestration heartbeat | Consume the gateway compatibility result and refusal reason, without recomputing equality. Missing legacy results stay unverified.                                                                                                                                                                                                           |
| Committed node-inventory proofs                                  | Send valid release versions and floors; use the existing PID/connection identity to distinguish replacements instead of synthetic version labels.                                                                                                                                                                                            |

Feature capabilities, retained source hashes, frozen task contracts and publication gates MUST remain unchanged.

Regressions MUST accept node `0.77.0` with gateway `0.76.0` and the reverse when both floors allow it, and refuse either direction when a declared floor excludes the other peer. Worker-probe coverage MUST preserve retained-provenance checks for compatible newer versions.
