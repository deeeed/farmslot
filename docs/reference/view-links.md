# Current-view links

**Status:** Proposed under [ADR-033 Amendment 1](../adr/033-mobile-tmux-worker-control.md#amendment-1-share-the-current-companion-view-2026-10-24). No implementation or native association is claimed.

## Public surface

Extend `@farmslot/protocol/surfaces/view-links` with an experimental `currentViewLink` model and named input/result types. Its inputs are a CC route or Companion route plus displayed selection and an explicit Command Center web base. Its result is an available canonical HTTPS URL and view identity, or a typed unavailable reason. The model owns the allowlisted route/parameter mapping and validation. Clients extract navigation state and render actions; they must not maintain parallel conversion tables.

Named consumers are CC's existing Copy link component and Companion's single quick-action controller. The existing `validViewRoute`, `viewLinkFromRoute` and `viewRouteFromLink` desktop contract remains compatible. Any additive protocol export ships through the owning package's normal versioned release. There are no new CLI commands/flags, gateway methods or harness extension points. External harnesses use ordinary navigation, clipboard/share interactions and authenticated read endpoints.

## Web URL and authority

- Add optional `commandCenterUrl` metadata to the saved gateway profile. Deployment configuration supplies the same explicit value for its configured gateway profile; it must not supply a default for unrelated saved gateways. The operator can enter or correct it once in connection settings. No new pairing or credential exchange is required in phase 1.
- Accept an absolute HTTPS base with no username, password, query or fragment. Preserve a deployment path prefix. Refuse localhost and loopback destinations. Never infer a base from the gateway WebSocket URL, a port convention or another profile.
- Canonical URLs use the existing CC hash route below that base, for example `https://cc.example.org/#run/run-123`. Only allowlisted navigation selectors belong in the URL. Credentials, pairing codes, arbitrary connection URLs, command leases, unsaved text and recordings must not appear.
- Opening the URL uses normal web authentication and resource authorization. A link never installs credentials, silently selects another gateway or executes an action. Preserve the requested identity through sign-in; refuse an unconfigured/mismatched deployment rather than showing a same-named resource on another gateway. Existing [ADR-048 navigation-only rules](../adr/048-interactive-operator-packets.md#surface-behavior) apply.
- An unset base disables Copy and Share and shows "Web link unavailable: set the Command Center URL" with a settings action. An invalid base or unsupported view has its own precise reason. Voice remains available under its existing guards.

## View identity and coverage

Use the displayed route and selected resource, including retained offline data. Do not replace a historical run/session with a slot's latest run/session, refresh data to create a link, or require live command readiness. Sharing describes navigation, not data freshness or permission to act.

Before implementation acceptance, retain a route inventory covering every Companion screen and relevant CC route/parameter consumer. For each, record its exact equivalent and identity selectors, or its disabled reason. Prioritize these families:

| View                                   | Identity to preserve                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Run and family                         | Exact run/family, selected timeline/evidence/gate/files/diff tab                                                           |
| Session and worker terminal            | Exact session and execution node or explicit worker target, with run/context correlation when needed; no command authority |
| Gate/decision                          | Exact selected decision and run, never merely the current gate                                                             |
| Evidence, artifacts and visual review  | Run, selected artifact/recipe result/step and relevant viewer selection                                                    |
| Slot and terminal                      | Exact slot and selected terminal/workspace view                                                                            |
| Planning, PR and collection views      | Selected item/PR/project and supported filters or subview                                                                  |
| Settings, connection and other screens | Exact counterpart where one exists; otherwise a precise disabled reason                                                    |

Do not treat a valid parent route as an exact mapping. For example, a session picker is not a selected session, and a run summary is not its selected evidence item. Missing support remains visible in the inventory and UI. Form contents, device permissions and local-only setup state are not shareable view identity. Development-only routes are not product views.

## Companion interaction

One floating button replaces the separate floating microphone and Co-Pilot entries, including terminal screens. Tap opens Copy link, Share, Voice in that order. Long press invokes the existing voice handler directly and must not also open the menu. Provide accessible menu/voice actions and touch targets of at least 44 points. Preserve dragging, keyboard clearance and safe areas; opening the menu must not record or send.

Copy writes the model's URL to the clipboard. Share passes that same URL to the native share sheet. Both actions use the current displayed view/profile and expose failures without substituting another destination. Route/profile changes must invalidate an open menu's stale target. Voice from either gesture calls the existing foreground handler with its existing context, review/edit and explicit Send guards. Do not add a second recorder or background voice behavior.

## Acceptance and phases

Phase 1 requires real Android UI and authenticated CC web proof:

1. Open an actual run, tap Copy link and retain the actual clipboard value. Open that exact HTTPS URL in CC web through normal navigation; screenshots/video and observed protocol reads must identify the same run and supported selection.
2. Open Share on that view and prove the native sheet receives the identical URL. Prove tap-menu Voice and direct long-press Voice, with foreground recording and explicit Send preserved.
3. Repeat route-inventory round trips, stale/offline sharing, missing/invalid URL, unsupported view and profile/deployment mismatch. Include malformed/credential-bearing URL refusal and an unauthenticated open. Verify no command execution, queued mutation or replay follows sharing/reconnection.

Unit tests cover shared mappings and refusals but cannot replace clipboard, mounted-view, share-sheet or protocol evidence. Use launch-time setup fixtures and real interactions, never injected UI/cache state. Every unavailable route must match the inventory; it is not a successful same-view round trip.

Phase 2 adds Android App Links and iOS Universal Links after the HTTPS domain and native signing owners are named. It requires hosted association verification, matching native builds and warm/cold opens of the same URL into the same Companion view under normal profile/auth checks. Custom-scheme or browser-only proof does not establish OS association. Phase 1 must not claim this deferred behavior.
