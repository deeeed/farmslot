# Recover native runs

This is operator guidance for the lifecycle in [runner execution](../PRD-runner-execution-canonical.md). Keep it current with the gateway and CLI contracts.

Inspect a failed or blocked run with `farmslot run get <runId>`. Native session records include observed exit code, signal, a bounded redacted stderr tail, and process-closure evidence. A missing process whose descendants cannot be accounted for remains unavailable for automatic recovery.

Use `farmslot run resume <runId>` for a blocked native worker with a pending recovery decision. It resumes the saved conversation through that decision. A refusal includes the decision ID, available action IDs, and `farmslot decision resolve <id> <action>` commands. Check the actions before choosing one.

Legacy native journals may lack descendant identities. After checking that those descendants have stopped, explicitly confirm cleanup with `farmslot run resume <runId> --confirm-stopped` or add `--confirm-stopped` to adoption. The host refuses confirmation while the recorded process, group, or any known descendant survives. It records `process-missing-attested` and preserves queued input for recovery. Older nodes and hosts remain readable and report an upgrade requirement for this operation.

If recovery happened outside the gateway, register it with:

```sh
farmslot run adopt <runId> --tmux <session>
```

Adoption requires the paused or blocked run to own its slot. The existing native worker must have stopped, and the external worker must prove the same saved conversation in the slot repository. Unsupported or ambiguous identity fails closed. Adoption starts task monitoring and preserves checklist and signal timing. It does not create or restart the external session.

Steering a busy native session queues the message for the next turn boundary. The receipt includes `queued: true` and the command ID. Queuing is distinct from submission and native acceptance. Interrupt remains an explicit operation. Reuse the command ID when reconciling a lost reply; never submit the same instruction with a fresh ID just because the reply was lost.

Closing a session cancels its queued input even when process cleanup still needs verification. Task-lease transfer refuses queued input; close it to discard the queue or resume the same lease to deliver it.

Cancellation and force-completion stop the run's native task leases. Capability release targets only that run and keeps providers warm. Slot ownership resets only while the owner and epoch still match. Cleanup is skipped when another run or process uses the repository, or when a tmux session has no run-owned creation identity. The run records `slotTeardownSkipped`. Use explicit slot controls only after checking its occupants.

Tmux cleanup verifies and stops the run's exact saved conversation while preserving the pane and session. Shared workspaces retain their busy state, but the terminal run's slot pointer and unused lease ownership are removed. Providers left running for unowned occupants carry `providerCleanupDeferred`; automatic reacquisition refuses them until an operator verifies occupancy and explicitly stops the retained provider. Watch and transcript cleanup stays scoped to the run. This narrows terminal cleanup under ADR-054 to the ownership the ending run can prove.

## Upgrade task-path handling

Update the Farmslot CLI on **every node first**, then upgrade the gateway. The updated CLI resolves `run create --task` against the caller's working directory and sends an absolute path. The updated gateway rejects new relative paths with an upgrade hint. Older CLIs deliberately send relative paths and must be upgraded before that gateway is deployed.

Existing stored runs with relative paths remain readable. This change validates new creation requests and does not migrate historical records. A pre-written task receives the shared marker, handoff, and terminal runtime without replacing its authored task or checklist.
