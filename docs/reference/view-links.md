# Current-view links

**Status:** Proposed under [ADR-033 Amendment 1](../adr/033-mobile-tmux-worker-control.md#amendment-1-share-the-current-companion-view-2026-10-24). No implementation or native association is claimed.

## Public surface

Extend `@farmslot/protocol/surfaces/view-links` with an experimental `resolveSharedViewLink` model and named input/result types. Its inputs are a Companion route plus displayed selection, a CC route or an incoming HTTPS view URL, with an explicit Command Center web base. Its result is an available canonical HTTPS URL, CC route and view identity, or a typed unavailable reason. The model owns the allowlisted route/parameter mapping and validation. Clients extract navigation state and render actions; they must not maintain parallel conversion tables.

Named phase 1 consumers are Companion's single quick-action controller for generation and CC's shared-link navigation adapter for receipt. No browser Copy action is added. Desktop Copy continues producing its current custom-scheme links through `validViewRoute`, `viewLinkFromRoute` and `viewRouteFromLink`; it does not switch to HTTPS. Any additive protocol export ships through the owning package's normal versioned release. There are no new CLI commands/flags, gateway methods or harness extension points. External harnesses use ordinary navigation, clipboard/share interactions and authenticated read endpoints.

## Web URL and authority

- Add optional `commandCenterUrl` metadata to the saved gateway profile. Deployment configuration supplies the same explicit value for its configured gateway profile; it must not supply a default for unrelated saved gateways. The operator can enter or correct it once in connection settings. No new pairing or credential exchange is required in phase 1.
- Accept an absolute HTTPS base with no username, password, query or fragment. Preserve a deployment path prefix. Refuse localhost and loopback destinations. Never infer a base from the gateway WebSocket URL, a port convention or another profile.
- Canonical URLs use the existing CC hash route below that base, for example `https://cc.example.org/#run/run-123?sharedView=1`. The model adds the allowlisted navigation marker `sharedView=1`; its named consumer is CC's shared-link navigation adapter. Only allowlisted navigation selectors belong in the URL. Credentials, pairing codes, arbitrary connection URLs, command leases, unsaved text and recordings must not appear.
- Phase 1 requires each web base to serve one gateway, with that endpoint and any equivalent aliases explicitly pinned in the deployment configuration. CC compares its selected gateway, including a saved browser value, to that binding before resolving the shared route or issuing resource reads. A missing binding or mismatch retains the requested route and shows the connection error; it must not switch gateways automatically. Multi-gateway bases are unavailable in phase 1. The profile/base pairing is trusted operator configuration, not an identity discovered or authenticated from the link.
- The adapter applies this binding check to `sharedView=1` routes. Ordinary CC routes retain their existing connection behavior. The marker conveys no authority; all navigation still requires normal authentication and authorization.
- Opening the URL uses normal web authentication and resource authorization. A link never installs credentials, silently selects another gateway or executes an action. Preserve the requested identity through sign-in. Existing [ADR-048 navigation-only rules](../adr/048-interactive-operator-packets.md#surface-behavior) apply.
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

One floating button replaces the separate floating microphone and Co-Pilot entries, including terminal screens. Tap opens Copy link, Share, Voice in that order. Long press invokes Voice directly and must not also open the menu. Provide accessible menu/voice actions and hit areas of at least 44 pt on iOS / 48 dp on Android, independently of visual icon size. Preserve dragging, keyboard clearance and safe areas; opening the menu must not record or send.

Copy writes the model's URL to the clipboard. Share passes that same URL to the native share sheet. Both actions use the current displayed view/profile and expose failures without substituting another destination. Route/profile changes must invalidate an open menu's stale target.

On slot/worker terminals, either Voice gesture uses that screen's recorder and current target. Off-terminal, preserve the existing `buildWorkspaceCopilotDraftForRoute` context handoff, resolve the already-running Co-Pilot's `terminalWorker` through its existing status flow, and open its worker terminal with that pending draft. Once the same profile/target passes existing foreground voice checks, invoke that terminal's recorder from the explicit gesture intent. If disconnected, missing or not eligible, open the existing Co-Pilot status/setup screen with the pending draft and reason; never launch a worker, choose another worker or start recording implicitly. Preserve the Co-Pilot screen's existing terminal/native choices. Clear the voice-start intent on cancellation or profile/target change; it is never part of a shared URL. Review/edit and explicit Send remain required. Do not add another recorder or background voice behavior.

## Acceptance and phases

Phase 1 requires real Android UI and authenticated CC web proof:

1. Open an actual run, tap Copy link and retain the actual clipboard value. Open that exact HTTPS URL in CC web through normal navigation; screenshots/video and observed protocol reads must identify the same run and supported selection.
2. Open Share on that view and prove the native sheet receives the identical URL. From the run page, prove both Voice gestures reach the already-running Co-Pilot worker's foreground recorder with the same pending run context and explicit Send. On a terminal, prove its own current target/recorder remains in use. Prove the unavailable Co-Pilot path retains context and does not launch or record.
3. Repeat route-inventory round trips, stale/offline sharing, missing/invalid URL and unsupported views. Prove a saved CC gateway conflicting with the web base's configured binding is refused before resource reads, including colliding slot IDs, and that missing/multi-gateway bindings are unavailable. Include malformed/credential-bearing URL refusal and an unauthenticated open. Verify no command execution, queued mutation or replay follows sharing/reconnection.

Unit tests cover shared mappings and refusals but cannot replace clipboard, mounted-view, share-sheet or protocol evidence. Use launch-time setup fixtures and real interactions, never injected UI/cache state. Every unavailable route must match the inventory; it is not a successful same-view round trip.

Phase 2 adds Android App Links and iOS Universal Links after the HTTPS domain and native signing owners are named. It requires hosted association verification, matching native builds and warm/cold opens of the same URL into the same Companion view under normal profile/auth checks. Custom-scheme or browser-only proof does not establish OS association. Phase 1 must not claim this deferred behavior.
