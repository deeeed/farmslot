# Native ACP client

Proposed specification under ADR-057 Amendment 16 and the ACP boundary in ADR-008 Amendment 3. Implementation is authorised; acceptance requires the shared review and live proof below.

The existing ACP process/RPC client is the single decoder for registered agents. Registration owns executable/arguments, account context and normal interaction-mode mapping. UI callers continue to send the existing native target, cwd, runner, model, effort, mode and approvalMode. They cannot provide executable, credentials or an ownership override.

An adapter configured for existing authentication starts its session without inventing an authentication method or running login. Explicit auth-method bindings retain their negotiated method checks. Model configuration prefers a declared model option; effort uses the registered agent's declared thought-level option. Confirm returned values. Legacy bindings may retain their existing model method; do not silently downgrade a failed configuration request.

Ask/Bypass uses the existing per-session setter and idle-policy fence. An automatic permission decision is a durable approval-resolution event with the original request, command/turn identity, automatic marker and policy. Emit it before writing the operation-scoped ACP approval. Ask continues through the existing approval cards and response RPC, including deny. A stop, stale generation or expired request cannot be answered later. Worker and publication authority do not change.

`NativeToolDiff` contains `path`, nullable `oldText` for a new file and `newText`. The adapter validates ACP diff content and retains it across partial tool updates. Shared rendering formats that generic content; it does not decode runner protocols. Existing bounded stream metadata and original-journal omission/paging apply. Diff disclosure uses the shared URL/view-state owner and existing viewers, with stable layout and no new background reads.

A registered agent may expose only capabilities its protocol confirms. The first binding preserves existing provider authentication and makes Default/Plan, model/effort, cwd, resume, interruption and close available through the ordinary native lifecycle. No additional harness loop or installer UI is part of this specification.

Validation includes old-source failing tests for no-auth-method session creation, model/effort configuration, audited Bypass and native diff projection; regressions for the three existing ACP bindings; and authenticated CC plus real Companion proof using only the initial adapter. The live recipe covers Ask approve/deny, a Bypass write without a prompt, returning to Ask, selected configuration, resume/stop and closed owned processes. Deploy only through the designated release owner.

The initial registration is `claude-acp`; `claude` keeps its SDK transport. Install the pinned adapter separately, without its optional bundled CLI, and set `FARMSLOT_CLAUDE_ACP_EXECUTABLE` in the native host's login environment. `CLAUDE_CODE_EXECUTABLE` selects the already installed provider CLI. Existing named profiles and login context still select its account. An absent adapter remains unavailable on that target.

Run the existing isolated Aqua `scripts/runner-validation/gateway/live-conversations.mts` with `FARMSLOT_STREAM_PROOF_RUNNERS=claude-acp`. The companion `native-acp-controls.mts` and `native-acp-resume.mts` scripts drive Ask/Bypass, file effects, retained-context Resume and Stop through that private gateway and Command Center. `apps/companion/scripts/agentic/native-acp-proof.mts` uses the same private authority on a real Android device; it checks receipt/file effects as well as visible stream, diff and approval controls. These scripts refuse non-proof account/workspace inputs. Complete the existing release-mode Android jank recipe before review.

This changes runtime and protocol packages, gateway registration and both clients. Publish reviewed merged bytes and roll out matching readers through the designated release owner. The adapter installation alone does not activate source changes or restart a host.
