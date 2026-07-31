# ADR-051: Principal and Credential Model

**Status:** Accepted (not yet implemented)
**Date:** 2026-07-25
**Relates to:** [ADR-036](036-cli-gateway-profiles.md) (supersedes its single-secret assumption), [ADR-046](046-mandatory-local-node.md), [ADR-008](008-remote-communication.md), [ADR-013](013-gateway-mediated-orchestration.md), [ADR-023](023-runner-agnostic-tui-execution.md) (safety tiers become an authorization axis), [ADR-037](037-prepare-profiles.md), [ADR-040](040-work-graph-orchestration.md)

## Context

The gateway authenticates **connections**, not **actors**, and every authenticated connection is
equally and fully authorized.

`resolveGatewayAuth()` (`services/gateway/src/security/auth.ts:97`) resolves one of three modes from
the environment — `none` (the default), `token`, or `password`. `authenticateGatewayClient()`
compares the presented secret against the configured one and returns a `GatewayAuthResult`
(`auth.ts:28`, `:142`). On success `auth.connect` stamps
`{authenticated, clientKind, authMode, authenticatedAt}` onto the connection's `ClientState`
(`server/client-state.ts:37`), and `server.ts` calls `requireAuthenticatedSession()` once before
dispatching into `routeMethod()`.

That is a single bit of authority. Three consequences follow.

**There is exactly one secret, and holding it is total.** `clientKind` —
`'ui' | 'companion' | 'node'` — records which program dialed in, is self-asserted, and constrains
nothing except `node.connect`. Every other method is reachable by any authenticated connection.
There is no way to give a second person the ability to observe and dispatch work without also giving
them the ability to reconfigure what the gateway executes.

**Pairing hands out that secret whole.** `pairingExchange()` (`fleet/pairing.ts:106`) returns the
gateway's own token or password verbatim in the profile payload. Pairing a phone grants permanent,
unrestricted control, revocable only by rotating the secret and re-pairing everything else.

**Access is unrecorded, so it cannot be withdrawn selectively.** Revocation is rotation, and
rotation is collateral.

The constraint shaping any answer is the solo path. A gateway on loopback with no credential is the
normal, correct, zero-config way to run Farmslot, and today it is *more* permissive than the above
suggests: with `auth.mode === 'none'`, `server.ts:110` marks every new socket `authenticated: true`
at connection time and sends the privileged hello immediately — `auth.connect` is never called.
Meanwhile `assertGatewayBindAllowed()` (`auth.ts:123`) already encodes the principle that makes this
safe: loopback without auth is fine, non-loopback without auth is refused with an error naming the
fix.

## Goal and scope

**The goal is narrow: let a second person use the gateway without giving them total control, and let
that access be withdrawn without disturbing anyone else's.**

A boundary a determined operator can step over is not a boundary. The gateway is an orchestrator of
shell execution, so the honest question is not "is there a boundary" but "where exactly does it sit,
and what does it not cover". Two claims of different strength, kept separate:

- **What v2 guarantees.** No execution reachable by a non-admin principal escapes the ceiling in
  §5.2 — because non-admin access is a proven allowlist (§5.1), not a list of blocked methods.
- **What v2 does not guarantee.** An operator who can write repository content can have that content
  executed unsandboxed by a later admin-initiated or system-scheduled step. Only containment — a
  deferred ADR that is a **dependency of the strong claim** — closes that (§5.6).

Farm scoping, verified node identity, and full run attribution are deliberately **not** decided
here. They appear as follow-on ADRs at the end.

## Decision

Separate **identity** from **credentials**, persist both, and authorize by **subject**, **role
binding**, and **proven conformance** — with default-deny as the organizing principle.

### 1. Principals, subjects, and role bindings

A **principal** is who is acting. It is stable and outlives any secret used to authenticate as it.

```ts
interface Principal {
  id: string;
  subject: PrincipalSubject;
  roles: RoleBinding[];
}

type PrincipalSubject =
  | { type: 'person'; displayName: string }
  | { type: 'service'; displayName: string }
  | { type: 'node'; displayName: string; machine: string };

interface RoleBinding {
  role: Role;
  scope: RoleScope;
}

type Role = 'admin' | 'operator';
type RoleScope = { kind: 'global' };
```

**Subject type says what a principal is; role bindings say what it may do, and where.** Three
separations are load-bearing:

- **Subject versus role.** Adding a role adds a value to `Role`; adding a subject kind adds a
  variant to the union. Neither migrates stored records.
- **Role versus scope.** `RoleScope` is a discriminated union whose only member today is the
  explicit literal `{ kind: 'global' }`; there is no absent-means-global rule. Farm scoping later
  adds a farm scope **representation** — whether as a further variant or as a term in a composable
  set is that ADR's choice — letting a principal hold `admin` on one farm and `operator` on another,
  because authority was already a *list of bindings*. The property that matters here holds either
  way: a representation is added without touching a stored record.
- **Identity versus credential.** Many credentials may authenticate as one principal (§2), so
  rotating a secret is not a change of who acted.

`roles` is authority in one place — on the principal, never on a credential. An empty `roles` array
is legal and authorizes nothing; no code path may read absence or emptiness as permission.

- **`admin`** — everything.
- **`operator`** — exactly the proven allowlist in §5.3, and nothing else.

Two roles is a vocabulary, not a headcount: any number of `person` principals may exist and any
number of them may hold `admin` — §3's last-admin invariant presupposes exactly that.

**Node subjects hold no roles.** A `node`-subject principal has `roles: []` and is authorized by its
subject alone, for exactly the node surface (§6). Roles are meaningful only for `person` and
`service` subjects.

`clientKind` is unchanged and keeps meaning which program dialed in. A `ui` client may carry an
operator or an admin principal; the axes stay orthogonal.

The `node` subject variant carries `machine` **required inside the variant**, so the record shape is
final. This ADR uses it for one check — that a principal may act as a node at all — and does not
verify that a connecting node *is* the machine it claims. That verification is deferred; because the
field already exists and is required, adding it changes an authorization rule and no stored data.

#### Virtual principals

**A virtual principal is a resolver answer with no stored record.** It is never persisted, never
credentialed, never issuable, and cannot be authenticated as. There are exactly three:

| Virtual principal | Subject                                    | Authority                                        | Returned when                                       |
| ----------------- | ------------------------------------------ | ------------------------------------------------ | --------------------------------------------------- |
| `local-admin`     | `person`, display name `local`             | `[{ role: 'admin', scope: { kind: 'global' } }]` | solo mode, connection is not a node (§3)            |
| `local-node`      | `node`, `machine` = the local machine name | `[]` — subject-authorized                        | solo mode, connection presents `clientKind: 'node'` |
| `system`          | `service`, display name `system`           | `[{ role: 'admin', scope: { kind: 'global' } }]` | the gateway acts on its own schedule over admin-authored work only (§5.5) |

**Every virtual principal's id is reserved**, and the store writer refuses to create a stored
principal bearing one — today that is `local-admin`, `local-node`, and `system`, and any virtual
principal added later inherits the reservation without needing this sentence rewritten. The reason
is one rule, not three cases: a stored principal sharing a virtual id could shadow it and inherit
its resolution, which is exploitable rather than merely untidy — most sharply for `system`, which
§5.5 grants admin over gateway-scheduled work. For the same reason the migrated env principal (§3)
must not take a display name that collides with `system`.

Authorization code sees ordinary `Principal` values in every case, **including their role bindings**
— `system` holds a real `admin`/`global` binding rather than a role-gating exemption, so the check
has no virtual-principal branch at all. Virtualness is a fact about where the value came from, not a
branch inside the check. Narrowing what automation may do later is then a change to that binding,
not a new mechanism.

### 2. Credentials and storage

A **credential** is a secret that authenticates as a principal. A person's laptop and their paired
phone are two credentials, one principal — so losing the phone revokes the phone.

```ts
interface CredentialRecord {
  id: string;
  principalId: string;
  displayName: string;
  secret: StoredSecret;
  origin: 'issued' | 'paired' | 'env-migrated';
  createdAt: string;
  revokedAt: string | null;
}

interface StoredSecret {
  scheme: 'scrypt-v1';
  salt: string;   // base64
  hash: string;   // base64
}
```

Every field is required. **`revokedAt` is the revocation tombstone** the authorization check reads
directly — deleting the record instead would let a re-used id resurrect access. **`createdAt` is the
credential's rotation age**, the operational "this key is old" signal, not derivable from a random
id. Virtual principals have no credential records, so there is no `origin: 'built-in'`.

A credential is **active** when `revokedAt === null`. Revocation leaves a tombstone, so a store can
hold many records and zero active credentials — a state §3 handles explicitly.

#### Store

One file, `<FARMSLOT_HOME>/credentials.json`:

```ts
interface CredentialStore {
  schemaVersion: 1;
  activatedAt: string | null;   // the activation latch (§3)
  principals: Principal[];
  credentials: CredentialRecord[];
}
```

`schemaVersion` costs one field now and buys the alternative to ad-hoc legacy detection at the first
evolution — and this store will evolve, since deactivation state, group bindings, and grant
provenance all touch it (see the deferred entries). **An absent or unrecognized version fails
closed** under the rule already stated below: the store is rejected at load with the file named, and
the gateway refuses to start rather than guessing at a shape it does not know.

Identity and credentials share one file because a role change and a credential issuance must not
half-apply on the authorization path. **Work-item provenance is deliberately not here** — it lives
with each work item, for the atomicity reason given in §5.5.

#### One identity domain per `FARMSLOT_HOME`

**The scope of everything in this ADR is one `FARMSLOT_HOME`, not one machine.** `farmslotHome()`
resolves the `FARMSLOT_HOME` environment variable and falls back to `~/.farmslot`
(`packages/protocol/src/node/farmslot-home.ts:11-15`); its own contract calls it "the single source
of truth for where gateway profiles, auth, logs, llm-config, and the gateway pid/log live", imported
by both CLI and gateway precisely so a custom value "can never half-apply". So the store is
machine-wide *by default*, not by design.

That matters because **the credential store, the activation latch, `credentials.lock`, and the
gateway presence marker all live in `FARMSLOT_HOME`** — they therefore share one scope by
construction and cannot disagree about which domain they are protecting. Every rule below about
locking, reconciliation, and offline safety inherits that single premise rather than needing its own
justification.

**The operator consequence runs in both directions, and surprises either way.** Deployments that
share a `FARMSLOT_HOME` share one identity domain: the same principals, the same activation state,
and one deployment's first issued credential ends solo mode for all of them. A deployment that wants
its own principals and its own solo-mode lifecycle **sets its own `FARMSLOT_HOME`** — that is the
supported separation mechanism, and it already exists.

- **Permissions** follow `gateway-profiles.ts:56`: `mkdirSync` mode `0o700`, `writeFileSync` mode
  `0o600`, explicit `chmodSync` after every save because the write mode only applies on create.
- **Atomicity.** Every mutation is a whole-file write to a temporary file in the same directory
  followed by `rename`.
- **Write exclusion — `credentials.lock`, held only for each read-modify-write.** Atomic rename
  prevents a torn read, not a lost update, so exclusion needs a lock, and **the lock's scope must be
  the store's scope**: it lives beside the store in `FARMSLOT_HOME` and *every* writer
  takes it — any running gateway, and the offline CLI. It is **exclusive but short-lived, held for
  the duration of a single read-modify-write and released**. This is all the store itself requires,
  and it is what keeps the lock compatible with the per-root, per-port gateway design: **a gateway
  never holds it while merely running**, so concurrent gateways — which that design permits — do not
  exclude one another. Concurrent writes serialize; running gateways do not contend.

  **The gateway singleton lock cannot serve this purpose**, which is a symptom of the two being
  different concerns: `acquireGatewaySingletonLock()` writes
  `<farmslotRoot>/.runs/gateway-<PORT>.pid` (`services/gateway/src/index.ts:100-144`), scoped per
  root *and* per port, so gateways with different roots or ports hold different locks while sharing
  one `credentials.json`. Rescoping the store to a farmslot root would fix the locking and break the
  identity model — one `FARMSLOT_HOME`, one set of principals — so the lock moves to the store, not the
  store to the lock.
- **Missing principal fails closed.** A credential whose `principalId` resolves to no principal does
  not authenticate. An unparseable record is rejected at load with the file named, and the gateway
  refuses to start rather than running with a silently truncated store.

#### Secret handling

- **Entropy.** 32 bytes from `randomBytes`, base64url-encoded.
- **Wire format.** `fs_<credentialId>_<secret>` — for **issued and paired** credentials the embedded
  id makes verification a single record lookup instead of a scan, which would either leak timing
  across records or force every record to be hashed on every attempt. The credential id is **hex**,
  because the base64url secret alphabet contains `_` and would make the delimiter ambiguous.
  **The legacy env secret is bounded structurally, not by cardinality**: it has no prefix and no
  embedded id, and additive-only reconciliation (§3) means `env-migrated` credentials accumulate
  across roots and rotations — so "there is at most one" is not available as a bound. Instead, **the
  non-prefixed path resolves only against this gateway's own boot-time environment secret.** Boot
  reconciliation already establishes which credential corresponds to that secret; the gateway holds
  that mapping for its process lifetime, compares a presented non-prefixed secret against that one
  value in constant time, and resolves to that one credential. No scan, no `scrypt` on this path, and
  no timing surface across records.

  The narrowing is real and worth stating: **an `env-migrated` credential is presentable only to a
  gateway configured with that secret.** Other roots' migrated credentials remain valid records in
  the store, but they are not authenticable through this gateway. That is correct rather than
  unfortunate — the environment variable *is* the presentation mechanism for that credential, and a
  gateway never given it has no way to know it.
- **Hash — `scrypt-v1` fully pinned**, because a version tag that does not name its parameters means
  nothing: `scrypt` from `node:crypto`, **N = 2^15 (32768), r = 8, p = 1, dkLen = 32, salt 16 random
  bytes**, `maxmem` set explicitly to 64 MiB because `128 · N · r` is exactly 32 MiB and sits on
  Node's default boundary. Unknown schemes are rejected; successful authentication may rehash in
  place to upgrade.
- **Comparison.** `timingSafeEqual` on derived keys, preserving the property `safeEqualSecret()`
  already has (`auth.ts:271`).

#### Presenting a credential over the wire

**A credential is presented as the existing token mode. There is no new auth mode and no transport
change.**

- On `auth.connect`, the credential secret is the `token` field and `authMode` is `'token'`.
- In stored profiles, `authMode: 'token'` and `secret` is the credential secret — which is what
  `profileCredential()` already does with a token-mode profile
  (`packages/cli/src/gateway-profiles.ts:100-105`), and what `PairingExchangeResult.profile` already
  permits, since its `authMode` is `Exclude<GatewayAuthMode, 'none'>`
  (`packages/protocol/src/rpc/auth.ts:60-67`).
- The gateway resolves the presented secret against the credential store instead of comparing it to
  one configured value. **Prefixed** secrets resolve by their embedded id, so that is a single record
  lookup; a **non-prefixed** secret takes the bounded env path above, resolving only against this
  gateway's own boot-time environment secret. One rule with one stated exception, not two rules.

**Password mode stays legacy-only**: it is reachable only through the env-configured admin path of
§3, and no credential is ever issued in password mode. Because credentials reuse token mode
verbatim, **the credential transport itself requires no contract change** — `pairing.exchange` is
untouched, and `auth.connect`'s change is purely additive (below).

**A principal must be able to see its own authority, or every denial is unactionable.** That is the
denials-teach invariant (§8) applied to identity itself: telling an operator "this requires admin"
is useless if they cannot discover what they hold. So `auth.connect`'s result gains a **`principal`
summary describing the caller only** — never another principal — specified in §7.

**Carrying it to `auth status` is CLI plumbing, and it does not exist today.** `probeGatewayAuth`
does not return the `auth.connect` result verbatim; it projects it down to
`{ state, authMode?, detail? }` (`packages/cli/src/gateway-auth.ts:13-17`), and the `auth status`
renderer maps only those three fields (`packages/cli/src/commands/auth.ts:181-190`). Both must widen
to carry the summary. The protocol change in §7 is what makes that possible; the CLI change is
recorded as assigned implementation work in the non-conformance record.

There is deliberately **no `principal.self` method and no new allowlist entry**: the summary rides
the frame that already establishes the session, so a caller learns its identity at the moment it
authenticates and never needs a separate authorized read. `principal.list` stays admin-only, because
enumerating *other* principals is a different capability from knowing your own.

`auth status` therefore reports `mode: token` — the transport — alongside the principal's display
name and role bindings — the authority. The two are reported separately because §1 keeps them
separate axes.

#### Revocation and invalidation

**The session stores an identifier, never an authority.** `ClientState` caches an
`AuthenticationRef` and nothing else; principal and role bindings resolve from the store on every
check. A cached role cannot outlive its record because there is no cached role.

```ts
/** Opaque to the session: how this session authenticated, never what it may do. */
type AuthenticationRef = { kind: 'credential'; credentialId: string };
```

**One variant in v2, and credential behaviour is exactly as described above** — the ref is a
discriminated union solely so that resolution strategies are additive. Solo mode stays derived
rather than stored (§3 resolves it from bind address and latch, caching no ref), and the deferred
SSO work adds a resolver-owned variant instead of replacing the resolver contract. That is the one
place this ADR can cheaply shrink its own self-admitted non-additive seam: the same wrapper leaves
§2's resolution rules and the attenuation-free authority rule untouched.

1. **Live lookup per check** — an in-memory map read with the file as source of truth.
2. **Authority changes invalidate live sessions.** Credential revocation, role-binding change, and
   the activation latch each close or downgrade every affected open session, including subscriptions.
3. **Verification may be cached; authority may not.** `authorizeHttpRequest()` authenticates *every*
   `/api/file` and `/api/run-artifact` request (`auth.ts:216-235`), and the Companion loads images
   through that path — so running `scrypt` at N = 2^15 per request would cost tens to hundreds of
   milliseconds each and is a visible regression. The gateway therefore keeps a **bounded in-memory
   cache of the secret→credential verification**, keyed by a fast digest of the presented secret.
   **This does not weaken invariant 1**, because what is reused is only the KDF result: the principal
   and its role bindings are still resolved on every check, so a revoked credential or a changed
   binding takes effect on the next request regardless of what is cached. The distinction is the
   whole point — caching *that this secret matches that credential* is safe; caching *what that
   credential may do* would not be.

   **Invalidation is change-based, not authorship-based**, and the difference matters because the
   store is shared across the identity domain: a gateway that only invalidated on **its own** writes would keep serving
   revoked authority after any external write — another gateway's, or an offline operation's. So a
   gateway invalidates its cached verification **and** its in-memory principal state on its own
   writes *and* whenever it observes that the store has changed underneath it. The observation is a
   cheap freshness check on store identity and modification metadata.

   **That check precedes every authority resolution, not merely every credential verification.** An
   established session authenticates once and then resolves authority on each request without
   re-verifying any secret, so a check placed only in front of the cache would never run for it —
   and another writer's revocation would not reach that session at all. Before **any** authorization
   decision the gateway confirms its cached principal state is current against the store and reloads
   when it is not. That is what invariant 1 actually promises; placed anywhere narrower it would hold
   only for new authentications, and only within one gateway's own view of the world.
4. **Outbound is authorized too.** The privileged hello and every broadcast are filtered by the
   receiving session's principal. Today `broadcast()` reaches every authenticated socket — and
   *every* socket when `auth.mode === 'none'` (`server.ts:624-633`) — while `sendHello()` fires
   immediately after `auth.connect` (`server.ts:541`). A session receives only surfaces its principal
   may read; a principal with no roles receives none.

### 3. Solo mode, activation, and recovery

**Activation is a latch, not a derived condition.** `activatedAt` latches on the first time a
credential is issued, the bind is non-loopback, or proxy-header trust is declared, and **never
silently unlatches**. A store holding only tombstones is a store that *was* activated, so revoking
the last credential does not return the gateway to solo mode — falling back would mean revocation
*increases* what an unauthenticated caller can do.

**The latch is stored, so it is shared by the whole identity domain (§2), and that has a consequence
worth meeting here rather than discovering later.** Issuing a credential from one deployment latches
activation for *every* deployment sharing that `FARMSLOT_HOME`: their virtual `local-admin` stops
resolving, and their co-launched nodes need issued credentials too. That is shared domain, shared
activation — the same rule as shared principals, seen from the lifecycle side. **A deployment that
needs its own solo-mode lifecycle sets its own `FARMSLOT_HOME`**, which is the same separation
mechanism §2 already describes, applied to activation rather than to identity.

The rows key on **active admin** presence, not on active credentials generally — a store can hold
active operator credentials and no admin, and that state needs its own answer.

| State                                    | Condition                                                  | Who may authenticate                                                       | Who may write the store                                    |
| ---------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Solo mode**                            | never latched; loopback-only bind; proxy trust off          | nobody needs to — resolver returns `local-admin` / `local-node` (§1)        | a running gateway, acting for the virtual admin over RPC    |
| **Never-latched, non-loopback**          | never latched; bind not loopback-only, or proxy trust on    | nobody — the bind is refused before serving                                 | offline CLI only (no gateway running)                       |
| **Activated, ≥1 active admin credential**| latched; at least one **admin** credential active           | holders of active credentials                                               | any running gateway over RPC, serialized on the store lock  |
| **Activated, no active admin credential**| latched; every admin credential revoked or demoted          | active non-admin holders, if any — otherwise nobody                         | offline CLI only (every gateway stopped)                    |

Rows one and two are unchanged. Row three narrows from "any active credential" to "any active
**admin** credential"; row four widens correspondingly, and now covers both the everything-revoked
case and the operators-but-no-admin case that has no other home.

The write column describes each state **while a gateway is serving**. Stopping every gateway hands
the store to the host owner in every row alike — that is the single rule below, not a property of
rows two and four.

Two mechanisms govern writing, and they answer different questions:

- **Any writer serializes on `credentials.lock`** (§2), held only for the duration of each
  read-modify-write. That is what makes the write safe. It does not care whether a gateway is
  running, and running gateways do not hold it, so **the design's per-root, per-port gateways may
  run concurrently** without excluding each other.
- **Offline operations additionally require that no gateway is running.** This is a *separate*
  requirement with a *different* reason: a running gateway holds in-memory state derived from the
  store — §2's verification cache and resolved principals. §2's invalidation is change-based, so a
  live gateway does converge on an external write, but only at its next freshness check; requiring
  quiescence removes the window entirely for operations performed deliberately out-of-band. So this
  protects **cache coherence, not write atomicity**, and it is why the store lock alone is
  insufficient.

**Proving "no gateway is running" must itself span the identity domain**, since gateways are
per-root and per-port and the singleton pidfile is scoped to one of each (§2). "No gateway running"
means none in this `FARMSLOT_HOME` — gateways under a different one are a different domain and are
irrelevant here. A **presence marker in
`FARMSLOT_HOME`** carries it: every running gateway holds it in **shared** mode for its lifetime, and
an offline operation must acquire it **exclusively**. Shared so gateways never exclude each other;
exclusive so an offline operation fails while any gateway is live, naming what is running:

```
Cannot modify the credential store: 2 gateways are running
(/Users/…/farmslot on port 7789, /Users/…/other-root on port 8808).
Next: stop them, then re-run this command.
```

**While any gateway is up, writing happens through RPC**: all issuance, revocation, and binding
changes go through a gateway, each serializing on `credentials.lock`, and in solo mode that RPC is
authorized by the virtual `local-admin`, which is why solo mode needs no offline path. **With every gateway stopped, the host owner may perform any
credential-store operation** — issue, revoke, or edit bindings — on the justification solo mode
already rests on: whoever can write a `0600` file in `FARMSLOT_HOME` is definitionally the gateway
owner, and no restriction placed there would constrain them.

That single rule replaces the narrower "offline issuance only when no admin is active" predicate,
which was wrong in a way worth recording: **losing or compromising an admin secret does not enter
row four at all.** The credential record stays active until something tombstones it, so the gateway
is still in row three, still accepting the compromised secret. Recovery is therefore *revoke, then
issue* — and a predicate permitting only issuance could never have performed the first step. One
coherent story: **stop every gateway, revoke the compromised credential, issue a replacement, start
them again.**

In row four the gateway keeps serving whatever its active non-admin credentials authorize. Refusing
to serve would convert a lost admin credential into a total outage for no security gain — the
operators already hold their credentials, and denying them changes nothing an attacker could
exploit. `farmslot doctor` reports the state so it is visible rather than merely survivable.

**Row four is reached two ways, and the gateway closes both.** The first is a *first* issuance that
mints only a non-admin credential: that latches activation while leaving no admin, so an operator
can authenticate and nobody can manage the store. The activation flow below closes it by minting an
admin credential for the owner alongside whatever was asked for — which is why that dual mint is a
correctness requirement, not a convenience. It survives only through an offline first issuance that
creates a non-admin and nothing else.

The second is revoking or demoting the last active admin, which a running gateway's writer refuses
— rejecting any revocation or role-binding removal that would leave zero active admin credentials:

```
Refusing to revoke credential 'owner-laptop': it is the last active admin credential,
and removing it would leave this gateway with no way to issue or revoke anything.
Next: issue a replacement admin credential first, then revoke this one:
  farmslot credential issue --principal owner --name owner-new
```

**That invariant binds a running gateway's writer only.** It is a guard against an admin locking
themselves out through the API, not a property of the file — and it deliberately does not apply
offline, because the offline path is the recovery path and an owner who has stopped every gateway in
the identity domain must be able to demote or revoke a compromised admin before issuing its
replacement. It holds for `credential.revoke` and `principal.revokeRole` alike (§7), since it lives
on the writer rather than in either handler.

Solo mode's rationale: whoever owns the gateway process already owns the machine — they can read
`credentials.json`, attach to the process, and run anything the gateway could run. Demanding a
credential from them proves nothing. This extends the rule `assertGatewayBindAllowed()` already
applies at the bind, one level up into authorization.

Two virtual principals serve solo mode because one cannot serve both ingress shapes: the node surface
requires a `node` subject (§6), the human surface a role-bearing subject (§1). The choice is made at
session establishment from `clientKind`, **not** inside the authorization check.

**Rows two and four teach the same escape**, since neither has an admin credential to act with:

```
This gateway has no active admin credential, so nothing can be issued or
revoked over RPC.
Next: stop every gateway in this identity domain, then run
  farmslot credential issue --principal owner --role admin --scope global
and start them again.
```

A **compromised** admin credential is the same procedure with one step in front, and the gateway is
in row three throughout — the bad credential is still active, which is exactly the problem:

```
Next: stop every gateway in this identity domain, then run
  farmslot credential revoke <compromised-id>
  farmslot credential issue --principal owner --role admin --scope global
and start them again.
```

**Latching activation on** closes open sessions (invariant 2) and stops `local-node` resolving, so
the co-launched node needs a real credential from that point. Activation provisions nothing
silently; the command walks the owner through the whole transition:

```
Issued credential 'sam-laptop' for principal 'sam' (operator, global).
Issued credential 'owner' for principal 'owner' (admin, global) — written to your
active gateway profile so this session keeps working.

This gateway is now activated, permanently. Two things change:
  - open sessions must re-authenticate; their subscriptions were closed.
  - the local node no longer connects implicitly.
Next: issue the local node's credential and write it where the node reads it:
  farmslot credential issue --principal <machine> --subject node --machine <machine> --write-node-env
```

The node reads credentials only from environment variables and gateway env files
(`resolveGatewayCredential`, `services/node/src/index.ts:631`), so `--write-node-env` writes to that
existing path — no new delivery mechanism, and no principal provisioned behind the owner's back.

**Legacy env auth is the old spelling of an admin credential, not a second auth system.** On first
boot with `FARMSLOT_GATEWAY_TOKEN`/`PASSWORD` configured (`auth.ts:97-114`), the gateway latches
activation, creates a `service` principal with an `admin`/`global` binding, and writes a credential
with `origin: 'env-migrated'` whose hash is that secret's. The env secret keeps authenticating
**because it is that credential**, so existing deployments, stored profiles, and paired Companions
keep working unchanged; `authMode` stays in the protocol contract. That credential is revocable
individually — the first time that has been possible.

**Boot reconciliation is additive only.** It has exactly one action and one prohibition:

- **If the current env secret has no active `env-migrated` credential, migrate it** — create one.
- **Never revoke any credential on the basis of an env value, in any case.** Not on rotation, not on
  removal, not on mismatch.
- **Report at boot any other active `env-migrated` credentials that do not match the current
  environment**, naming explicit revocation as the way to remove them.

The reason is a limit on what the gateway can know, and it subsumes what would otherwise look like
two unrelated rules for rotation and removal. **Deployments sharing an identity domain share one
credential store, while each loads its own `.env.local-auth`** — `services/gateway/src/index.ts:173-188`
reads it from `resolve(farmslotRoot, …)`, which is how two deployments in one domain come to present
different secrets. So **a gateway cannot distinguish "the operator rotated this secret" from "this is
a different deployment's secret in the same domain".** Both present as a mismatch against the store.
Inferring revocation from an ambiguity the system cannot resolve would let one deployment silently
disable another's access, and it would thrash sequentially: migrate deployment A's secret, start B
and revoke A's, return to A and revoke B's, indefinitely.

So env reconciliation only ever **adds**, and revocation is always **explicit** — which is exactly
the tombstone-only model §2 already establishes, applied to the one path that was tempted to deviate
from it. There is consequently no ordering hazard to manage: a rule that never revokes cannot pass
through a zero-admin state.

The boot report says so plainly, because the surprise would otherwise run in the dangerous
direction — an operator who changes or unsets the variable expecting access to follow:

```
FARMSLOT_GATEWAY_TOKEN does not match any active credential; migrated it as a new one.
1 other active env-migrated credential does not match this environment — changing or
unsetting the variable does not remove access.
Next: to remove it, run
  farmslot credential revoke <id>
or stop every gateway and revoke offline.
```

A gateway may not reconcile itself into a state where nothing can issue, and it may not silently
reconcile away access that another root or another operator still depends on.

**Loopback is a claim about the bind address, not the peer.** Auto-admit keys off the listen address,
never the request IP, because `resolveRequestIp()` returns a forwarded header when proxy trust is on
(`auth.ts:237`). Declaring proxy trust latches activation. **The residual is real and reporting does
not remove it:** an undeclared forwarder — SSH tunnel, userspace proxy, container port publish —
turns remote callers into implicit admins in solo mode, and the gateway cannot detect it. **Solo mode
is safe only when nothing forwards to the loopback listener.** `farmslot doctor` reports solo mode,
but visibility is not a control. `FARMSLOT_GATEWAY_ALLOW_UNAUTHENTICATED_ANY_HOST=1` permits the
bind and nothing more; a non-loopback bind latches activation, so it lands in the refusal row.

### 4. Ingress paths

Frames and requests enter by **four** paths, and only one is `routeMethod()`.

| Ingress                                                                 | Carries                                              | Principal resolution                             | Authorization                                                                    |
| ------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Pre-dispatch frames in `server.ts` — `auth.connect`, `pairing.exchange` | session establishment; pairing redemption            | none yet — these *create* the session            | open by definition for **every** subject kind; `pairing.exchange`'s proof is the code |
| `routeMethod()` (`route-method.ts:459`)                                 | the registry methods **and** `node.connect`          | session's cached `AuthenticationRef` → live lookup | §5, checked before the `routeRunMethod()` delegate at `:468`                        |
| Node frame paths in `server.ts` — binary, `res` replies, events         | screen relay, RPC replies, node-pushed state         | same session lookup                              | requires a `node`-subject principal (§6)                                           |
| HTTP via `authorizeHttpRequest()` (`auth.ts:216`)                       | `/api/file`, `/api/run-artifact` (`index.ts:394-429`) | Bearer/Basic/query/cookie credential per request | §5; today returns `true` unconditionally when `auth.mode === 'none'` (`auth.ts:221`), which activation closes |

**Parameter types are not a validation boundary.** `routeMethod()` reaches every handler through type
*assertions*, so a declared union like `direction: 'U' | 'D' | 'L' | 'R'`
(`packages/protocol/src/rpc/git.ts:32`) is a compile-time claim about a value that arrives from the
wire unchecked. Any §5 rule depending on a parameter's shape must be enforced by runtime validation.

Authorization is also evaluated in two places that are **not** ingresses, because no connection is
present: the dispatch queue's fire-time path and gateway-scheduled work (§5.5).

### 5. Authorization

#### 5.1 Default-deny: non-admin access is a proven allowlist

**Every method is admin-only unless it appears on the operator allowlist, and a method joins that
allowlist only by being proven conformant against every invariant in §5.2.**

This inversion is the core structural decision of this ADR. The alternative — classify everything
operator-reachable and enumerate the exceptions — requires the document to be exhaustively right
about ~245 handlers and everything they transitively reach. That enumeration cannot be maintained by
hand and cannot converge: each pass over the codebase finds another handler that spawns a process,
composes a shell string, or resolves a path late. Any such handler discovered *after* the document
froze would have been silently operator-reachable.

Under default-deny the same discovery is a non-event: an unproven method was already admin-only.
**The residual risk of an incomplete audit therefore shifts from "operator holds unintended
authority" to "operator is denied something they could safely have" — a usability cost that surfaces
loudly rather than a security failure that surfaces never.**

Three consequences follow, and all are intended:

- **This ADR does not enumerate offenders**, because the enumeration is neither normative nor
  maintainable. It states the invariants (§5.2), names the proven allowlist (§5.3), and delegates
  derivation to the conformance gate (§5.4).
- **Allowlist entries are exact registry method names. Wildcards and family patterns are
  forbidden.** A pattern silently admits every method later added under that prefix, which is the
  blocklist failure mode wearing different clothes. Exactness is also load-bearing in the other
  direction: a misspelled entry authorizes nothing, so entries are checked against
  `packages/protocol/src/rpc/registry.ts` by the gate.
- **The initial allowlist is small.** Widening it is per-method work with evidence, not a document
  edit.

#### 5.2 The conformance invariants

A method is operator-reachable only if **every** invariant below holds for it and for everything it
transitively reaches.

**I1 — Execution ceiling.** Every execution transitively triggered by a non-admin principal either
runs inside a sandbox tier, or executes only admin-authored commands with no operator-writable
inputs. "Executes" includes any subprocess that may itself execute code from a location the operator
can write — package-manager lifecycle scripts, build-tool task definitions, and interpreter in-tree
configuration all fail this for the same reason.

**I2 — Argv composition.** Execution composes argv arrays end to end. Caller-derived values are never
interpolated into shell text at any hop, local or remote. **Quoting by serialization is not argv
safety**: `JSON.stringify` yields a double-quoted string, and a POSIX shell still expands `$(…)` and
backticks inside double quotes.

**I3 — No repository-associated programs.** The method invokes no program that consults
repository-associated configuration to decide what code to run. For version control this includes
hooks, `core.fsmonitor`, textconv and filter drivers, and any equivalent — disabling one mechanism
does not satisfy the invariant, because the invariant is about the class.

**I4 — Atomic confinement.** Any path-addressed operation — **read as well as write** — is confined
by the acting call itself, not by a preceding check. A validated path may not be re-resolved by the
operation that acts on it. This holds gateway-side and node-side, since for remote slots the node is
the executing side.

**I5 — No caller-controlled host paths.** No caller-supplied value determines a filesystem location
the gateway writes to, creates, or overwrites outside a confined root.

**I6 — Resolution precedes decision.** Any value participating in an authorization decision —
defaults, stored values, expanded templates — is resolved to its effective form *before* the
decision. A handler may not resolve a privileged value after its own authorization has passed. This
covers the runner safety tier specifically: `sandboxed` is operator-reachable, `full-auto` and
`dangerous` are not, and the tier that matters is the resolved one.

**I7 — No laundering.** No indirection, deferral, or automation may reach a capability its
responsible principal could not invoke directly. Authorization is evaluated where the effect fires,
against the principal responsible for it (§5.5).

#### 5.3 The operator allowlist

Every entry below was proven by reading its handler and everything it reaches. Each serves only
gateway-process memory: none spawns a process, none performs path-addressed I/O, none invokes git,
none accepts a caller-controlled path.

| Method (exact registry name) | Handler evidence                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `nodes.list`                 | in-memory registry projection (`server/route-method.ts:899-900`)                                    |
| `node.health`                | cached map lookup (`route-method.ts:1102-1107`; `fleet/node-health.ts:222-223`)                     |
| `node.health.all`            | cached map enumeration (`route-method.ts:1108-1109`; `fleet/node-health.ts:226-227`)                |
| `run.list`                   | in-memory run filtering plus pure summaries (`methods/run/context.ts:55-62`; `runs/store.ts:671-752`) |
| `dispatch.queue.list`        | in-memory filtered copy (`route-method.ts:533-536`; `backlog/dispatch-queue.ts:394-397`)            |
| `backlog.list`               | in-memory filtering and sorting (`backlog/store.ts:943-958`)                                        |
| `workGraph.get`              | in-memory projection (`work-graph/store.ts:314-315`)                                                |
| `workGraph.list`             | in-memory filtering (`work-graph/store.ts:297-312`)                                                 |

Event subscriptions are operator-reachable for these surfaces only, filtered per §2 invariant 3.

**Everything else is admin-only until proven.** The non-conformance record below lists the methods
that were expected to qualify and did not, with the reason each failed.

**The natural operator surface is artifact-reading observability, and it is not yet conformant.**
Most of the methods that *should* serve a second person — run detail, family observability, decision
lists, analytics — fail I4 for one shared reason: they read run artifacts, task directories,
analytics files, or spec paths from disk by pathname, and acting-call confinement does not exist
today. This is a single implementation gap with a single fix, not ten separate problems. **Widening
the allowlist to cover artifact-reading observability is the first job of the deferred containment
ADR**, once confined artifact reads exist; until then the operator role is thinner than it should be,
and no entry is hand-waved back onto the list without a handler-source proof.

**How I1 is satisfied for slot preparation is not decided here.** No dispatch method is on the
allowlist, so the question is not live in v2; it becomes the first question of the deferred
containment ADR, at the point where a dispatch method is a candidate.

#### 5.4 The conformance gate

The allowlist above is prose. **The normative artifact is generated**, and the gate is what makes
default-deny real rather than aspirational.

**Input.** The method registry (`packages/protocol/src/rpc/registry.ts`) plus the allowlist. Each
allowlist entry cites its handler path and asserts each invariant. An entry whose method name is not
in the registry fails.

**Check.** Static reachability from the entry's handler, through the call graph, to a named set of
forbidden primitives. Reaching any of them fails the entry:

- process spawn or exec of any kind (`child_process` `spawn`/`exec`/`execFile`/`fork`, and any
  wrapper over them — `execLocal`, `execOnSlot`);
- filesystem open, read, or write by pathname (`node:fs` path-taking APIs);
- git invocation, by any route;
- LLM or CLI subprocess launch;
- node-RPC `exec` and `fs` methods (`sendNodeRequest` with those method names);
- PTY writes and tmux key injection.

**Unresolvable means fail.** Any call-graph edge the analysis cannot resolve statically — dynamic
import, callback indirection, dispatch through a runtime predicate — fails the entry. The entry
fails, so the method reverts to admin.

**What the gate proves, stated precisely: it proves the *absence* of forbidden reachability, not the
*presence* of safety.** That asymmetry is deliberate and is what makes the design tractable. Absence
of every primitive above is a **sufficient** condition for I1–I5: a handler that cannot spawn, cannot
perform path I/O, cannot invoke git, and cannot reach node exec/fs has no mechanism by which to
trigger execution, compose a shell string, invoke a repository-associated program, race a path, or
write a caller-chosen location. It is not a *necessary* condition — a method could be safe by
argument while touching one of these — but under default-deny that method simply stays admin, and
that costs nothing but usability.

**I6 and I7 are not mechanically decidable, and the design does not pretend otherwise.** They are
discharged as follows:

- For the current allowlist they are **vacuous**: no entry takes a privileged parameter value, and no
  entry is a stored-intent wrapper or a deferred-execution path. The gate asserts this
  mechanically — an entry whose handler reads a safety tier, resolves a stored action, or is reachable
  from the queue fire path fails.
- Any **future** entry for which they are not vacuous requires an explicit written argument recorded
  in the entry, reviewed by a human. A method whose I6/I7 proof cannot be mechanized stays admin.
  That is the design's escape hatch, and using it costs nothing.

**A constraint on the first conditioned allowlist entry, recorded because it is the moment this
design changes shape.** §4's pre-dispatch check cannot decide a condition on a resolved value:
`runCreate` resolves the effective safety tier *inside* the handler (`methods/run.ts:227`), after
dispatch has already happened. So the first entry admitted on a condition — "operator may call this
*when* the resolved tier is `sandboxed`" — necessarily introduces a **second evaluation point inside
the handler**, and at that moment default-deny stops being structural-at-one-place and starts
depending on a handler remembering to re-check. That is precisely why I6 and I7 route through human
review rather than the reachability query. **v2 remains coherent because no such entry exists**: the
gate fails any candidate whose handler reads a safety tier, so the second check point cannot appear
without someone deciding to create it.

**The gate additionally fails the build when** an allowlisted method's reachability set changes, so a
handler that newly reaches a forbidden primitive drops off the allowlist automatically rather than
silently retaining authority.

Point three is the property that ends the enumeration problem: the allowlist is *derived* from
evidence and *invalidated* by change, so it cannot silently drift the way a blocklist does.

#### 5.5 Provenance

Some execution has no caller — queued items, timer-fired automation, reconciliation. Authorization
still needs a principal, and two shortcuts are both wrong: treating anything a timer fires as the
gateway's own work, and treating authorship as fixed at creation.

**Provenance follows the effective definition of the work, and re-stamping is decided by the
write's origin.**

```ts
// gateway-internal; stored on the work item itself, never on the public contract
type WorkOriginator =
  | { kind: 'principal'; principalId: string }
  | { kind: 'system' };
```

- **A write arriving through an RPC method call carries the calling session's principal and
  re-stamps the originator.** Any such mutation, of any field.
- **A gateway-internal lifecycle transition preserves the existing originator.** Ticks, unlocks,
  reconciliation, retries, and status advances have no session principal, so there is nothing to
  re-stamp with and nothing is changed.

**The distinction is origin, not field semantics.** An implementer never has to judge whether a field
is "definition" or "state" — a question with no stable answer, since a title reaches the worker's
initial context and a spec path selects its input. The rule is mechanical: *did this write arrive on
a session?* If yes, re-stamp with that session's principal; if no, leave it. Nothing to classify and
nothing to maintain.

- **Provenance is otherwise permanent.** An unchanged item's originator survives every tick, unlock,
  reconciliation, and retry — that is what stops a timer from laundering authority.
- **Corollary: an operator can never raise a work item's authority by editing it.** Editing an
  admin-authored item re-stamps it to the operator, lowering it to the editor's authority. An admin
  who wants admin-authored automation must own every session-originated edit to it.
- **`system` applies only when both the schedule and the current definition are admin-authored.**
- **Triggering a tick conveys no authority.** `backlog.autoDispatchTick` and
  `workGraph.schedulerTick` are ordinary routed methods; a tick processes each item **under that
  item's own originator**, so invoking one can never elevate anything.

**The originator is stored on the work item's own internal record** — in the backlog store, the
dispatch queue, and the work-graph store respectively — and written **in the same atomic write as the
mutation it describes**. This is the reason it is not in the credential store: those definitions
persist separately, so a shared provenance file would require a cross-store transaction, and a crash
between the two writes could preserve stale admin provenance over an operator mutation. Co-location
makes the stamp and the change one write, and cross-store transactions disappear entirely.

This remains **gateway-internal authorization state**. It is deliberately not added to the public
`QueueItem` contract, which flows through `dispatch.queue.add`/`list`/`update` results and
`QueueUpdatedPayload` (`packages/protocol/src/rpc/dispatch.ts:175-214`; `transport/events.ts:257-259`)
— publishing a principal id there would expose identity to every queue reader, which is the
attribution question this ADR defers.

The fire-time path resolves the originator, re-authorizes the resolved effect against it (I6, I7),
and **fails closed** when it cannot be resolved — a denial naming the item, not a silent drop and not
a fallback to gateway authority. A principal revoked or demoted between enqueue and fire fails the
check, because §2's live lookup resolves the reference rather than a cached authority.

**`system` holds an ordinary `admin`/`global` binding and is unreachable from every ingress.** Its
authority is not an exemption from role checks — it passes them like any admin principal — so the
containment is entirely in reachability: no credential authenticates as it, and the resolver returns
it only for work whose schedule and effective definition are both admin-authored. Its control point
is that only admins author automation configuration and the definitions that run as `system`, which
holds because `config.*` mutators are admin-only and because any session-originated mutation
re-stamps provenance.

#### 5.6 The residual

**An operator who can write repository content can have that content executed unsandboxed by a later
admin-initiated or system-scheduled step.** Under the current allowlist an operator cannot write the
repository at all, so this is latent rather than live — but it becomes live the moment filesystem
methods qualify, which is an expected and desirable widening.

**In v2 this residual is dormant, because the allowlist grants no write of any kind.** An eight-method
observer cannot put content in a repository, cannot dispatch, and cannot time anything. The residual
is recorded here because it is the property that governs every widening: the moment a filesystem or
dispatch method qualifies, the operator gains an input to code that some later step executes, and
that is the point at which containment stops being optional.

What v2 does establish is the authority split the widening will rest on: **the admin chooses what the
project's configuration is, is the only one who can invoke the unsandboxed executors, and is the only
one whose authored work runs as `system`.**

Closing the residual requires running project steps and worker sessions as a different OS user or in
a container — a containment decision, not an authorization one, and therefore a **dependency of the
strong claim** in the Goal.

### 6. Node surface

`clientKind: 'node'` is self-asserted, and the paths it unlocks — binary screen frames, `res`
replies, node-pushed events — bypass `routeMethod()` entirely (`server.ts:133`, `:148`, `:237`) and
mutate gateway state. Their current guards are conditioned on `auth.mode !== 'none'`, so in today's
default configuration they are inert.

**Presenting as a node is an authority, not an assertion**: `auth.connect` rejects
`clientKind: 'node'` unless the authenticating principal's subject is `type: 'node'`, and the node
frame paths require the same. An operator credential cannot reach the node surface, and a node
credential cannot reach the operator surface. (`auth.connect` itself remains open pre-auth for every
subject kind — it is how any session is established.)

This ADR does **not** check that a node is the machine it claims; `node.connect` still accepts the
`machine` string on the connection's word and `registerNode()` overwrites by name
(`machine-registry.ts:12`). **v2 verifies that a principal may act as a node; verifying which node it
is requires the machine binding and belongs with it.**

**Local-node lifecycle, in one story.** In solo mode the co-launched node resolves to the virtual
`local-node` principal — a node subject bound to the local machine — so
[ADR-046](046-mandatory-local-node.md)'s zero-config `farmslot up` works unchanged and the subject
rule is satisfied rather than excepted. Latching activation stops the resolver returning virtual
principals and provisions nothing automatically; the owner issues the node's credential as the final
step of the §3 activation flow.

**One node change is required.** The node resolves its credential once at module load
(`services/node/src/index.ts:62`) and every reconnect reuses that value, so a newly issued credential
is not picked up until restart. The node must re-resolve its credential source at the start of each
connection attempt, inside `connect()` rather than at module scope — so activation and later
rotations take effect on the next reconnect without a restart.

### 7. Protocol surface

This ADR makes exactly three protocol changes: seven new methods, one additive field on
`auth.connect`'s result, and one breaking change to `pairing.create`. They are stated exactly,
because every later ADR inherits this surface.

#### Additive: the caller's own principal on `auth.connect`

```ts
/** The caller's own principal. Never describes any other principal. */
interface SelfPrincipalSummary {
  id: string;
  displayName: string;
  subjectKind: PrincipalSubject['type'];   // 'person' | 'service' | 'node'
  roles: RoleBinding[];
}

interface GatewayAuthConnectResult {
  ok: true;
  clientKind: GatewayAuthClientKind;
  authMode: GatewayAuthMode;
  authenticatedAt: number;
  capabilities: { httpBearerAuth: boolean; voiceInstructionFormatting: boolean };
  /** Optional on the wire for version skew only — a conforming gateway always sends it. */
  principal?: SelfPrincipalSummary;
}
```

**A conforming gateway always populates this for an authenticated session.** It describes whichever
principal the resolver returned, and §3 guarantees resolution always yields one — stored for a
migrated env admin or an issued credential, virtual for solo mode's `local-admin` and `local-node`
(§1). "No stored principal" is never a reason for absence: the env secret *is* a credential
belonging to a stored `service` principal after migration, and virtual principals are principals.

**The field is optional on the wire for exactly one reason: version skew.** An older gateway will
not send it and a newer client must tolerate that; an older client ignores it. Optionality is a
compatibility affordance, not a licence for a conforming gateway to omit it.

It is the only identity read a non-admin has, and it is self-scoped by construction — the gateway
fills it from the session it just established, so there is no parameter by which a caller could ask
about someone else.

#### New methods

```ts
// registry additions
PRINCIPAL_CREATE:  'principal.create',
PRINCIPAL_LIST:    'principal.list',
PRINCIPAL_GRANT:   'principal.grant',
PRINCIPAL_REVOKE:  'principal.revokeRole',
CREDENTIAL_ISSUE:  'credential.issue',
CREDENTIAL_LIST:   'credential.list',
CREDENTIAL_REVOKE: 'credential.revoke',
```

All seven are admin-only. Secrets never appear in a list result:

```ts
/** CredentialRecord minus `secret` — the only credential shape that leaves the gateway. */
interface CredentialSummary {
  id: string;
  principalId: string;
  displayName: string;
  origin: 'issued' | 'paired' | 'env-migrated';
  createdAt: string;
  revokedAt: string | null;
}

interface PrincipalCreateParams {
  subject: PrincipalSubject;   // §1 discriminated union; `machine` required in the node variant
  roles: RoleBinding[];        // required; [] is legal and authorizes nothing
}
interface PrincipalCreateResult { principal: Principal }

interface PrincipalListParams {}
interface PrincipalListResult { principals: Principal[] }

interface PrincipalGrantParams { principalId: string; role: Role; scope: RoleScope }
interface PrincipalGrantResult { principal: Principal }

interface PrincipalRevokeRoleParams { principalId: string; role: Role; scope: RoleScope }
interface PrincipalRevokeRoleResult { principal: Principal }

interface CredentialIssueParams { principalId: string; displayName: string }
interface CredentialIssueResult {
  credential: CredentialSummary;
  /** Returned exactly once, at issuance. Never stored recoverably, never in --json output. */
  secret: string;
}

interface CredentialListParams { includeRevoked?: boolean }
interface CredentialListResult { credentials: CredentialSummary[] }

interface CredentialRevokeParams { credentialId: string }
interface CredentialRevokeResult { credential: CredentialSummary }
```

`roles` and `scope` are required everywhere they appear: the fail-closed shape rule from §1 means no
absent value may be read as permission, so there is no "omit for global" convenience form.

`credential.revoke` and `principal.revokeRole` are both subject to §3's last-admin invariant: the
store writer rejects either call when it would leave zero active admin credentials, with the
issue-first teaching error. The invariant lives on the writer rather than in each handler, so it
cannot be bypassed by a future caller. **Boundary note for spec authors: the writer-side revoke
primitives — credential revocation and role revocation — belong to the principal-core node, not to
the RPC handlers**, because the last-admin invariant lives on the writer and must be provable before
any handler can reach it. That is a placement consequence of the invariant, not a new decision.

#### Changed contract: `pairing.create`

`pairing.create` gains a **required** authority input. It is a discriminated union so that "which
principal does this code authenticate as" has exactly two answers and no default:

```ts
type PairingAuthority =
  | { kind: 'existing-principal'; principalId: string }
  | { kind: 'new-service-principal'; displayName: string; roles: RoleBinding[] };

interface PairingCreateParams {
  gatewayUrl: string;
  profileName?: string;
  ttlSeconds?: number;
  authority: PairingAuthority;   // required — a request without it is rejected
}
```

This is a **breaking change** to `PairingCreateParams` (`packages/protocol/src/rpc/auth.ts:29-40`),
which today has no authority field at all. It is breaking deliberately: a default here would be an
unstated privilege grant on the one path that hands authority to a device the gateway has never seen.

#### Scoped pairing behaviour

`pairing.exchange` mints a **new credential** and returns that; it never returns the gateway's own
secret. The resulting credential lands in the store with `origin: 'paired'`, written by the running
gateway.

The operator flow is unchanged: create a code, scan or type it, receive a profile. What changes is
the payload, and what happens when a device is lost: `credential.revoke` removes that device and
nothing else.

Keeping `pairing.exchange` open remains sound: the code is 192 bits of `randomBytes`, single-use
(deleted on redemption), and expires in minutes (`pairing.ts:25`, `:93`, `:106`).

### 8. Denials teach

Every denial names the authority that was missing **and** the command that grants it, matching the
invariant the CLI already holds through `output.ts`'s `Next:` line:

```
Denied: run.create requires the admin role on this gateway.
Your credential 'sam-laptop' authenticates as principal 'sam' (operator, global).
Next: ask the gateway owner to dispatch, or the gateway owner runs
  farmslot principal grant sam --role admin --scope global
```

Under default-deny a denial should also say *why* a method is unavailable, since "not yet proven
conformant" is a different situation from "deliberately privileged":

```
Denied: decision.list is not available to the operator role on this gateway.
It is not on the proven-conformant allowlist: it reads decision and retrospective
artifacts from disk by pathname, which is not yet confined at the acting call.
Next: ask the gateway owner to run it.
```

Re-authorship is reported rather than silent:

```
Updated backlog item 'perps-latency'.
This item was authored by 'owner' (admin) and is now authored by you
('sam', operator), so auto-dispatch will run it with operator authority.
```

## Supporting material

Everything below is rationale and evidence. It is **not normative**: the invariants (§5.2), the
allowlist (§5.3), and the gate (§5.4) are.

### Requirements on deferred work

A spec author for any deferred ADR should read their group here rather than reconstruct it from the
whole document. **This index adds nothing and confers nothing.** Each entry carries exactly the
status of the section it points to, no more: a requirement binds future work because its deferred
entry says so, not because this list restates it. Where this wording and the establishing prose
differ, the prose governs. What the index provides is findability, not authority.

**Worker session and project-step containment**

- I1 must be satisfied for slot preparation — either sandbox preparation itself, or require operator
  dispatch to target an already-prepared slot. *(Deferred: containment)*
- Confined artifact reads must exist before artifact-reading observability can qualify for the
  allowlist; they are the single blocker on seven of the ten non-conformant methods. *(§5.3;
  Assigned implementation work)*

**Farm scoping**

- The form of the farm scope representation — a further scope variant versus a composable term —
  must be chosen before any farm record is persisted. *(Deferred: farm scoping)*

**Node identity and machine binding**

- Binding must be enforced on every node frame, not once at registration: `node.metrics` carries
  `payload.machine` without passing through `node.connect`. *(Deferred: node identity)*

**Run attribution and reporting**

- Attribution must stamp the **principal id**, never a credential id. *(Deferred: attribution)*
- That work decides what becomes public payload and what a `system`-originated run records.
  *(Deferred: attribution)*

**SSO / OIDC**

- Break-glass must never depend on the identity provider; offline store management, with every
  gateway in the identity domain stopped, is the IdP-independent path. *(Out of scope: SSO)*
- Token expiry must be built — `CredentialRecord` has no expiry field and live lookup covers
  stored-credential tombstones and role changes only. *(Out of scope: SSO)*
- The external token grammar must be constrained so credential and IdP resolution stay unambiguous.
  *(Out of scope: SSO)*
- That work must choose between **materializing** IdP-derived bindings into stored `Principal.roles`
  and **resolving** live claims per authorization check. *(Out of scope: SSO)*

**Group or team authority**

- `RoleBinding` needs an optional `source` plus a dedupe rule for equal-valued bindings from
  different origins, once derived bindings coexist. *(Deferred: groups)*
- §3's last-admin accounting must count group-derived admins. *(Deferred: groups)*
- The group model must be decided together with SSO's materialize-versus-resolve choice — they are
  one decision seen from two sides. *(Deferred: groups)*

**Principal lifecycle**

- Deactivating the last active admin must be refused exactly as revoking it is. *(Deferred:
  lifecycle)*

**Relational authority and steering**

- The first conditioned allowlist entry introduces a second, in-handler evaluation point — the moment
  default-deny stops being structural-at-one-place. *(§5.4)*
- Relational conditions and resolved-value conditions are one mechanism and should be decided
  together. *(Deferred: relational authority)*
- Candidate rule, recorded as a candidate: steering a run requires the authority that dispatching
  that run at its effective tier would require. *(Deferred: relational authority)*
- Session continuity is required — a steer must reach the *live* session, or the use case that
  motivates it is lost. *(Deferred: relational authority)*

**Binding implementation now, not a future ADR.** The Assigned implementation work table below lists
the five changes this ADR's design requires but that have not been made: two CLI plumbing items for
§7's `principal` summary, confined artifact reads, atomic confinement on `fs.*`, and argv conversion
of the shared `resolvePrRef()` path.

### Non-conformance record

Methods audited against §5.2 and found non-conformant. These are recorded because each was expected
to qualify — they are the operator role's natural surface — and because the reasons are the
implementation backlog for widening the allowlist.

| Method                    | Fails | Reason                                                                                                   |
| ------------------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| `gateway.status`          | I3    | runs a real `git fetch` against the gateway's own clone (`methods/gateway-status.ts:86-158`)               |
| `fleet.status`            | I1/I3 | a stale read starts a background `fleetRefresh()`, which shell- and git-probes every slot (`methods/fleet.ts:73-91`, `:728-750`) |
| `run.get`                 | I4    | `presentRun()` loads local and node artifact paths (`methods/run/context.ts:30-52`; `live-recipe/context.ts:52-85`) |
| `family.observability.get`| I4    | snapshot construction scans and reads task artifacts (`family-observability/snapshot.ts:242-318`)           |
| `family.report.generate`  | I1/I2/I4 | inherits those reads and may interpolate the report prompt into unsandboxed CLI shell text (`llm/index.ts:156-176`, `:821-866`) |
| `backlog.upcoming`        | I4    | eligibility evaluation reads project config and validated-then-reopened spec paths (`backlog/store.ts:402-413`, `:1948-1967`) |
| `decision.list`           | I4    | scans task directories and reads decision and retrospective artifacts (`methods/decisions.ts:33-50`; `observability/fleet-monitor.ts:154-185`) |
| `analytics.query`         | I4    | enumerates and reads analytics paths directly (`runs/analytics.ts:271-310`)                                |
| `analytics.backfill`      | I4    | not a reader at all — appends analytics records and calls `updateRun` per seeded run (`methods/analytics.ts:24-54`) |
| `operator.snapshot`       | I4    | transitively invokes `decisionList()` (`methods/operator.ts:43-49`)                                        |

Two observations worth carrying forward. **Seven of the ten fail for the same reason** — artifact
reads by pathname — which is why §5.3 treats confined artifact reads as one fix rather than ten.
And `analytics.backfill` was swept in by an `analytics.*` wildcard in an earlier draft while being a
*writer*; that is the concrete reason §5.1 forbids patterns in allowlist entries.

`gateway.status` deserves a note because its failure is instructive rather than alarming: it uses
`execFile` with argv and no shell, against a clone no operator can write. It is *probably* safe. It
is not *proven* safe, because I3 is stated over the class of repository-associated programs rather
than over reachability from an operator's pen, and "probably" is precisely what default-deny declines
to accept. Its qualification path also differs from the artifact-read group: it needs a version check
that does not invoke git, not confined reads.

### Assigned implementation work

Not conformance failures — these are places where this ADR's design requires a change that has not
been made. Recorded so the gap is tracked rather than assumed.

| Change                                                                                  | Why                                                                                                    |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Widen `GatewayAuthProbe` beyond `{ state, authMode?, detail? }` (`packages/cli/src/gateway-auth.ts:13-17`) | it projects the `auth.connect` result and drops the §7 `principal` summary                              |
| Widen the `auth status` renderer (`packages/cli/src/commands/auth.ts:181-190`)          | it maps only `state`, `authMode`, and `detail`, so the summary never reaches the operator               |
| Confined artifact reads (I4)                                                            | the single blocker on seven of the ten methods above                                                     |
| Atomic confinement on `fs.*` reads and writes, gateway-side and node-side (I4)           | validate-then-act today (`methods/filesystem.ts:139-161`; `services/node/src/commands/fs.ts:70-72`)      |
| Argv conversion of the shared `resolvePrRef()` path (I2)                                 | `JSON.stringify` into `execLocal` shell text (`methods/dispatch/ticket-ref.ts:49-59`)                    |

The first two are CLI plumbing for a protocol field §7 already defines; without them the operator
can authenticate but cannot discover what they hold, which makes every denial unactionable.

### Why the invariants are shaped this way

Each invariant exists because a concrete, verified path in the current code violates it. These are
**illustrative, not an enumeration**; no method's classification depends on appearing here.

- **I1.** `run.create` starts the engine (`methods/run.ts:398-430`), whose PREPARE step calls
  `slotPrepare` (`run-engine/dispatch-lifecycle-steps.ts:40-190`), which expands and runs project
  hooks unsandboxed (`methods/slot/prepare.ts:431-434`). Nominally those commands are admin-authored
  — but a prepare hook that installs dependencies executes scripts declared *in the repository*, so
  the admin chose *which* command runs while the repository chooses *what it does*.
- **I2.** `dispatch.matchProject` interpolates caller-supplied `ticketOrPr` via `JSON.stringify` into
  `execLocal` shell text (`methods/dispatch/match-project.ts:98-105` → `core/exec.ts:57-63`,
  `spawn('bash', ['-c', cmd])`) — a *local* path, which is why I2 is not a remote-only rule. The
  shared `resolvePrRef()` helper (`methods/dispatch/ticket-ref.ts:49-59`) carries the same pattern
  into `run.*` and eval source resolution. Remote `gitExec` quotes an argument only when it contains
  a space or a pipe (`methods/git.ts:47-63`) and the node runs the result through
  `spawn(SHELL, ['-lc', …])` (`services/node/src/commands/exec.ts:26-48`).
- **I3.** Stated over the *class* rather than a list because the list kept growing: `checkout` fires
  `post-checkout` even for file checkout, `status` may invoke a configured `fsmonitor`, index writes
  can fire `post-index-change`, and `diff`/`show` enable textconv by default. Disabling hooks via
  `core.hooksPath` addresses one mechanism and leaves the others.
- **I4.** `fsWrite`, `fsRename`, `fsDelete`, `fsMkdir`, and the read paths each validate a path and
  *then* act on the same path string (`methods/filesystem.ts:139-161`, `:495-511`, `:525-583`). The
  race is winnable in practice: every sandboxed worker has write access to the slot repository, so a
  caller who dispatches a run and then issues a filesystem call controls both ends of the window.
  Node-side there is no check at all (`services/node/src/commands/fs.ts:70-72`).
- **I5.** `run.bundle.export` accepts an arbitrary `outputPath`, creates its parent directories, and
  invokes `zstd -f` to overwrite that path as the gateway user (`methods/run-bundle.ts:14-24`;
  `packages/run-bundle/src/archive.ts:39-55`).
- **I6.** `runCreate` resolves the effective safety tier *inside* the handler
  (`methods/run.ts:227`); a check reading only wire params would authorize an omitted tier and then
  execute at a project default of `dangerous` (`runners/registry.ts:171-176`, `:201-210`). Queued
  items compound this: the fire path today passes no `safetyTier` at all (`index.ts:320-382`).
- **I7.** `chat.confirmAction` executes stored actions directly (`chat/chat-actions.ts:703-715`).
  `decision.resolve` delegates to `runResolveDecision` (`methods/decisions.ts:85-107`), which can
  restart a step or create and start a chained run at the run's persisted tier
  (`methods/run.ts:997-1101`). `tmux.worker.restore` rebuilds a launch command at the run's stored
  tier (`agents/runtime-recovery.ts:484-502`).

### Alternatives considered

**A second shared secret for non-admins.** One more environment variable, checked for which secret
matched. It genuinely achieves the goal's first half for a fraction of the work, and fails the second
half structurally: revoking one holder means rotating the operator secret, invalidating every other
holder, and nothing records who holds access or whether it was ever withdrawn. **Two secrets suffices
if the answer to "will there ever be more than one non-admin holder, or will one ever need
withdrawing independently" is permanently no.** The credential store is justified by exactly one
property two secrets cannot have at any cost — independent revocation — and this ADR should be
rejected in favour of two secrets if that property is not actually wanted.

**Blocklist classification (what earlier drafts did).** Classify methods operator-reachable by
default and enumerate the privileged ones. Rejected after repeated attempts: the enumeration must be
exhaustively correct about every handler's transitive reach, cannot be maintained by hand, and fails
silently — a missed handler is an unintended grant, not a visible denial.

**Full RBAC.** Rejected as premature: two roles cover the goal, and a matrix costs a policy language,
an evaluation order, and a "why was this denied" story. The migration cost of deciding later is small
under §1.

**Freeze provenance at creation.** Rejected: every field of a work item eventually reaches the
worker, so frozen authorship converts "an admin created this" into standing authority for whatever an
operator edits it into.

**Classify work-item fields as definition versus state.** The obvious way to let lifecycle
transitions mutate without re-stamping. Rejected because the classification has no stable answer and
puts a security-critical judgment in every implementer's hands; keying on the write's origin is
mechanical and needs no list.

**Containment first, authorization second.** Run worker sessions and project steps as a separate OS
user and let the single secret stand. This is the stronger security answer and would close §5.6's
residual outright, and it would satisfy I1 arm (a) for preparation. Rejected as the *first* step
because it does nothing for revocation — a contained gateway still has one secret that cannot be
withdrawn from one holder — and because sequencing authorization first produces the conformance
artifact containment work needs in order to know which capabilities to relocate.

**Require an explicit credential always, including loopback.** Rejected: it taxes the solo engineer to
defend against an attacker who already controls the machine and can read `credentials.json` directly,
and it turns ADR-046's zero-config local node into a setup step.

### Consequences

**Positive**

- A second person can be given access and have it withdrawn without disturbing anyone else's.
- **The security property no longer depends on the completeness of an audit.** An unproven method is
  denied, so an incomplete sweep costs usability rather than safety.
- Existing token/password deployments keep working untouched, and their secret becomes revocable for
  the first time.
- Store writes are serialized by a lock rather than by convention, and offline management is refused
  while any gateway is live.
- Provenance is a single mechanical rule keyed on write origin, with no field list and no cross-store
  transaction.
- The document stops needing edits when handlers change; the gate absorbs that.

**Negative / cost**

- **The initial operator is a narrow observer.** Eight methods: node presence, run list, queue list,
  backlog list, and work-graph reads. Not run detail, not decisions, not analytics, not fleet status.
  A second person can see *that* work exists and its shape, and must ask an admin for anything that
  reads an artifact.
- **Artifact-reading observability — the role's natural surface — is blocked on one missing
  primitive**, confined artifact reads. That is a single well-defined piece of work, but until it
  lands the role is thinner than intended.
- The conformance gate is a real build-time component with call-graph reachability analysis, not a
  lint rule.
- **Protocol surface changes are bounded and exactly three**: seven new admin methods; an additive,
  backward-compatible `principal` field on `auth.connect`'s result; and `pairing.create` gains a
  required `authority` input — the one breaking change. `pairing.exchange` is untouched, because
  credentials reuse token mode verbatim (§2). The only surface this ADR leaves **unchanged** is the
  public queue payload (§5.5).
- Runtime parameter validation becomes load-bearing where §5 depends on parameter shape.
- Credential-store recovery — a lost or compromised admin credential — requires stopping every
  gateway in the identity domain, making it a deliberate outage rather than a background fix.
- **The residual in §5.6 remains open.** v2 does not deliver isolation, and says so.

**Risks**

- Solo mode assumes no undeclared forwarder in front of a loopback listener.
- The gate's reachability analysis is load-bearing: if it under-approximates what a handler reaches,
  an allowlisted method could retain authority it should have lost. Its own correctness deserves
  review proportional to that role.
- A too-thin operator role invites pressure to widen the allowlist without evidence, which would
  reintroduce exactly the failure mode default-deny exists to prevent.

### Deferred follow-on ADRs

- **Worker session and project-step containment.** Running worker sessions and project-defined steps
  as a separate OS user or in a container. **A dependency of the Goal's strong claim**, the mechanism
  that would let dispatch qualify, and — via confined artifact reads — the first widening of the
  allowlist to cover observability. **Its first question is how I1 is satisfied for slot
  preparation**: sandbox preparation itself, or require operator dispatch to target an
  already-prepared slot.
- **Farm scoping.** Restricting a principal to named farms (`Run.project`), scoping reads as well as
  writes. *Ships later without rework* because authority is already `RoleBinding[]` with a
  discriminated `RoleScope`: it adds a farm scope representation and a per-method predicate at the
  §4 evaluation points. **That ADR must explicitly choose the form of that representation — a
  further scope *variant* versus a *composable term* — before it persists a single farm record.** `RoleBinding[]` aggregates by union,
  so a conjunction like "farm A, production only" is not two bindings, and independent dimensions
  (farm, node, environment) either multiply into cross-product variants or need a term language with
  AND/OR matching semantics — which §Alternatives already declined as premature policy machinery.
  Both readings are defensible; what is not defensible is drifting into one. **No farm record exists
  yet, so the choice is free today and expensive the moment farm scope ships** — that is the last
  cheap moment, and this ADR deliberately does not spend it.
- **Node identity and machine binding.** Enforcing that a connecting node is the machine its
  credential names, replacing the self-asserted registry entry and implementing the approval step
  ADR-008 deferred. *Ships later without rework* because `machine` is already required inside the
  `node` subject variant. One constraint belongs to it: the machine name also arrives inside node
  event payloads that never pass through `node.connect` — `node.metrics` destructures
  `payload.machine` straight into `updateMachineMetrics()` (`server.ts:245`) — so binding must be
  enforced on every node frame.
- **Run attribution and reporting.** §5.5 already persists provenance internally for authorization;
  this ADR is the remaining work — stamping runs, deciding what becomes public payload, the reporting
  surface, and what a `system`-originated run records. It must stamp the **principal id**, never a
  credential id.
- **Group or team authority.** Every `RoleBinding` attaches to one principal (§1), so authorizing a
  team today means one grant per person, and the set drifts as membership changes — it works, but the
  drift is silent and nothing notices when a leaver keeps a binding. The open question is whether
  groups become a **gateway-side store concept**, with bindings attaching to a group a principal
  belongs to, or stay **purely IdP-derived** and materialized per principal. **Decide it together
  with the SSO entry's materialize-versus-resolve choice** — they are the same decision seen from two
  sides, and deciding them separately yields either two group models or none.

  Two consequences that work inherits and should not rediscover. **`RoleBinding` has no identity of
  its own**: `principal.revokeRole` names a binding by value (§7), which is unambiguous only while
  every binding is direct — once group- or IdP-derived bindings coexist, an identical
  `{ admin, global }` arriving from two sources is one value and revoking "it" is undefined. That
  work adds an optional `source` on `RoleBinding` plus a dedupe rule for equal-valued bindings from
  different origins. And **§3's last-admin accounting must count group-derived admins**, or the
  invariant protects the wrong set.
- **Principal lifecycle.** There is no deactivation. `principal.create/list/grant/revokeRole` and
  `credential.issue/list/revoke` (§7) offboard a person only by revoking every role binding and every
  credential individually. That is **capable but not atomic**: the end state authorizes nothing by
  §1's empty-roles rule, so what is missing is a single action and an explicit auditable deactivated
  state, not the power to do it. It interacts with §3's last-admin invariant — whatever deactivation
  becomes, deactivating the last active admin must be refused exactly as revoking it is.

  A related absence worth naming rather than fixing: **`RoleBinding` records no granter and no
  timestamp**, so "who granted this, and when" is unanswerable — and unanswerable *retroactively*,
  since the information is not written anywhere to recover later. Whether that matters is a question
  for whoever needs the audit trail; it is noted here because the cost of adding it rises with every
  binding granted before it exists.
- **Relational authority: view, dispatch-and-own, steer.** Three distinct authorities over a run are
  collapsed today, because the model cannot express any of them separately. **Viewing** a run's
  output and progress, **dispatching and owning** a run, and **steering** one — communicating with
  its running worker — are different powers. v2 expresses only part of the first: `run.list` is
  allowlisted, so a non-admin does see run status and step state, while `run.get` and artifact output
  stay denied by I4, dispatch is not on the allowlist at all, and pane input fails I1 outright. So
  **viewing is partially expressed** — what is unexpressed is the distinction between that thin
  status view and the richer output-and-progress view an engineer reviewing a run actually needs.
  The other two authorities are unexpressed entirely.

  **The workflow that makes this concrete.** A run is dispatched either by a person or automatically
  from a ticket, and the engineer who later steers it during review is frequently neither. It must be
  the *original* worker rather than a fresh one, because that worker holds the implementation context
  and every review loop it has already been through — re-dispatching discards exactly what makes the
  steer valuable.

  **The open question is whether authority stays purely static or gains relational predicates** —
  rules of the form "the caller stands in some relation to this run". A `RoleBinding` is
  `{ role, scope }` and the check reads only the resolved principal, so nothing today can express any
  such rule. There are two axes here, and both stay undecided.

  **Where steering authority comes from** — three sources, none sufficient alone: the run's
  **originator**; **scope-derived** authority, meaning dispatch authority over the farm the run
  belongs to; or explicit **assignment** to a named principal, such as the reviewer. A
  ticket-dispatched run originates as `system` and a run dispatched by one engineer is routinely
  steered by another, so no single source answers the workflow above.

  **How that authority is represented** — a separate question with two shapes: a dynamic
  **run-scoped scope representation**, which would make scope per-resource with a lifecycle quite
  unlike static farm scope; or a **relational predicate** evaluated against the run's stored
  originator, which adds no scope but requires authorization to read resource state for the first
  time. **§5.5 already persists that originator per work item** — the data a relational rule needs
  exists, and no authorization rule reads it. That asymmetry is the gap.

  **A relational rule is a condition on an allowlist entry**, so it lands on exactly the constraint
  §5.4 already records: the first conditioned entry introduces a second, in-handler evaluation point.
  Relational conditions and resolved-value conditions are the same mechanism seen twice, and should
  be decided together rather than arriving separately.

  **Raw transport and structured instruction are different capabilities, and conflating them
  overstates the bound.** Sending keystrokes to a worker pane — `terminal.send`, `tmux.sendKeys` — is
  raw shell as the gateway OS user, so it fails I1 regardless of who dispatched the run: no
  relational rule can make *that* non-admin, and ownership cannot confer authority the role never
  had. But steering *semantically* is "deliver an instruction to the worker agent", which does not
  require keystroke injection. A structured instruction channel routed to the runner's compose path
  is a different capability with a different ceiling — and that distinction is the difference between
  "steering can never be non-admin" and "steering has a form that could be proven conformant". This
  ADR does not design that channel; it records that the distinction is what decides the question.

  **The honest bound on any such channel is the run's effective safety tier, not the transport.** A
  structured instruction still influences what an autonomous agent does, and that agent runs with the
  run's own authority. The candidate rule — recorded as a candidate, not a decision — is that
  **steering a run requires the authority that dispatching that run at its effective tier would
  require.** That keeps steering inside the transitive ceiling and inside I6's resolved-effective-value
  rule rather than inventing a new axis: a sandboxed run stays steerable within the sandbox, and a
  dangerous-tier run is admin either way.

  **Session continuity is a requirement on that work, not an implementation detail.** The value is
  the original worker's accumulated context, so whatever is decided must reach the *live* session —
  the run's session has to remain addressable for a steer to mean anything. A design that answers the
  authorization question but loses session continuity fails the use case that motivated it.

  **Containment and relational authority stay orthogonal**, now in three parts: containment decides
  whether raw pane access can ever be non-admin, the structured-channel question decides whether
  steering needs raw access at all, and relational authority decides only *whose* runs — whichever
  transport wins. Related to farm scoping but not the same axis either: per-farm authority answers
  *which runs may I dispatch*, relational authority answers *which runs are mine to steer*. A
  farm-scoped operator still needs the second question answered.

### Out of scope

- **SSO / OIDC.** Not built here. The extension points below are deliberate and a later implementer
  should not close them — but the honest summary is narrower than "it already fits":
  **authorization is unchanged after principal resolution; authentication and role lifecycle are
  where the work sits.**

  **What the design gives.** An IdP-verified subject resolves to a `Principal`, and §5's checks read
  the resolved principal and never how it was resolved — so an identity provider is a credential
  *resolution* strategy, not a second authorization model. `Principal.id` is stable and separate from
  any credential (§1), so one person keeps one identity across token rotations. §2's live lookup
  gives immediate effect to **stored-credential revocation and principal-role changes** — that, and
  no more.

  **Per-project permissions arrive as whatever farm scope representation the farm-scoping ADR
  chooses**, so an IdP maps a group onto `{ role, scope }` and the scope vocabulary stays the
  gateway's rather than the provider's — which holds regardless of the form that representation
  takes.

  **What the future work must build.** **Token expiry is not inherited** — `CredentialRecord` has no
  expiry field and live lookup covers tombstones and role changes only, so IdP token lifetime is a
  mechanism to add. **Token-grammar discrimination is a requirement, not a property** — the `fs_`
  prefix identifies a local credential, but the external token grammar must be constrained so the two
  resolution strategies stay unambiguous; the prefix makes that constraint cheap to satisfy, nothing
  more. And two additive schema needs, named so they are not discovered late: an **external subject
  reference** (issuer plus subject) on `person` and `service` principals, so a first login provisions
  just-in-time and later logins resolve to the same stable `Principal.id`; and a
  **claims-to-role-binding mapping policy** — who decides that an IdP group grants a role, and at
  what scope.

  **One consequential choice, deliberately left open.** §2's `AuthenticationRef` gives that work a
  place to add a resolver-owned variant without touching the resolver contract, but it does not
  decide the harder question: that work must choose between **materializing** IdP-derived bindings
  into stored `Principal.roles` and
  **resolving** live claims on every authorization check. The choice governs how quickly a claim
  change takes effect, how last-admin accounting works when bindings originate outside the gateway,
  and what happens during an IdP outage. It is also the part that is **not purely additive**, which
  is why it belongs to that ADR rather than being pre-empted here.

  **Break-glass must never depend on the identity provider — a requirement on that work, not a
  property it inherits.** The latch never clears (§3), so `local-admin` is a pre-activation
  affordance only; for an activated gateway the IdP-independent recovery path is **offline store
  management with every gateway in the identity domain stopped**. That is the answer when the IdP is unreachable, or when an
  IdP-driven mapping change would otherwise leave no reachable admin — and §3's last-admin protection
  binds a running gateway's writer, so it cannot by itself defend against an admin binding that
  vanishes because a group membership changed upstream.
- **A managed or hosted gateway.** Multi-tenancy and tenant isolation are a different product shape.
- **Audit logging.** A queryable, tamper-evident log of every authorization decision is its own
  decision.

## Open questions

Four decisions belong to the gateway's owner rather than to implementation.

1. **Is independent revocation actually wanted?** Everything here rests on it. If the answer to
   *"will there ever be more than one non-admin holder, or will one ever need withdrawing
   independently"* is permanently no, a second shared secret is the cheaper answer and this ADR
   should be rejected in its favour (see Alternatives).
2. **Is an eight-method observer worth shipping on its own?** That is what v2 starts as. Either ship
   it and widen as methods qualify, or hold v2 until confined artifact reads land so the operator
   arrives with real observability.
3. **Should confined artifact reads be pulled out of the containment ADR and done first?** They are
   the single blocker on seven of the ten non-conformant methods and a much smaller piece of work
   than containment as a whole — the highest-leverage way to make the operator role useful.
4. **Is credential-store recovery a documented procedure or a deliberate gap?** Recovering a lost or
   compromised admin credential means stopping every gateway in the identity domain and editing the store,
   which makes
   store-file access equivalent to gateway ownership. Documenting it makes recovery reliable;
   leaving it undocumented keeps it from being treated as routine administration.
