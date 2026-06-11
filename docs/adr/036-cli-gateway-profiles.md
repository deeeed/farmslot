# ADR-036: CLI Gateway Profiles and Auth

**Status:** Proposed
**Date:** 2026-06-12
**Relates to:** [ADR-008](008-remote-communication.md), [ADR-013](013-gateway-mediated-orchestration.md), [ADR-033](033-mobile-tmux-worker-control.md)

## Context

The `farmslot` CLI talks to exactly one gateway, addressed by a raw WebSocket URL
(`--url` / `GW_URL`, default `ws://localhost:7777`), with no authentication and no
persistent notion of "which gateway am I managing". Command Center has the same
single-gateway assumption.

The Companion mobile app already solved the multi-gateway problem: the 2026-05-22
sprint shipped authenticated gateway profiles/pairing (ADR-033 lane) — named
gateway entries, a pairing/auth handshake, and authenticated node redeploys. The
gateway-side machinery exists; the CLI never adopted it.

Operators increasingly run more than one gateway (workstation, lab machine,
remote node host) and want to manage all of them from one terminal without
remembering URLs or exporting env vars per shell.

## Decision

Make the CLI a first-class multi-gateway client by reusing the Companion's
profile/auth model:

1. **Profiles (kubeconfig-style contexts).**
   - `farmslot gateway add <name> --url <ws-url>` / `remove <name>` / `list`
   - `farmslot gateway use <name>` sets the active profile;
     `--gateway <name>` overrides per invocation; `--url` keeps working for
     ad-hoc targets.
   - Stored in `~/.farmslot/gateways.json` (machine-level, workspace-independent
     — operators manage fleets from anywhere; onboarding workspaces stay
     self-contained).
2. **Auth lifecycle.**
   - `farmslot login [<profile>]`, `farmslot logout [<profile>]`,
     `farmslot auth status`.
   - Reuses the existing gateway pairing/auth flow the Companion ships against;
     no new gateway protocol surface. Tokens live next to the profile entry with
     file permissions hardening.
3. **Doctor integration.** Doctor gains a Gateways section: per-profile
   reachability + auth state with login hints, mirroring the runner
   missing/inactive/authenticated model from onboarding.

Out of scope for this ADR: publishing `@farmslot/cli` to npm. The CLI currently
runs from the workspace clone via tsx; a published standalone client is a
separate decision that depends on a build/bundling step and follows once
profiles/auth prove out.

## Consequences

- One terminal manages many gateways; scripts pin `--gateway <name>` instead of
  copying URLs.
- Local single-gateway flows are unchanged: with no profiles configured the CLI
  behaves exactly as today (default localhost URL, no auth required by local
  gateways that don't enforce it).
- The pairing/auth flow gets a second consumer, hardening it beyond the
  Companion.
- Profile/token storage adds a small secret-handling surface to the CLI
  (`~/.farmslot/` permissions, no tokens in `--json` output or logs).
