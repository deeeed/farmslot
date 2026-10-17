# Principal Core Implementation Spec

**Status:** Accepted; credential consolidation amendment approved 2026-10-14
**Supports:** [ADR-051](../adr/051-principal-and-credential-model.md), [ADR-036](../adr/036-cli-gateway-profiles.md), [ADR-046](../adr/046-mandatory-local-node.md)

## Summary

### Person-device sessions

**Authority:** ADR-051 Amendment 4, accepted in [PR #1120](https://github.com/deeeed/farmslot/pull/1120).
This contract supersedes direct person-credential login and storage rules in
this specification. Service, node, activation and other authorization contracts
remain current; implementation and rollout must satisfy the cutover below.

#### Tokens and durable state

- Access tokens live for exactly one hour. Refresh tokens expire exactly 30 days
  after issuance or successful refresh. Only refresh advances that deadline.
  Gateway UTC time is authoritative; `now >= expiresAt` refuses. Ordinary
  requests do not persist activity.
- Both tokens contain a random 128-bit hex record id and a random 256-bit
  base64url secret. Prefixes `fsa_` and `fsr_` distinguish access and refresh
  tokens from existing `fs_` credentials. Refresh tokens never authenticate a
  general RPC or HTTP download. The store keeps only the existing `StoredSecret`
  hashes; plaintext secrets appear only in their issuance response.
- Extend the existing locked credential store to schema version 2 with person
  device-session and access-token records. Sessions contain their principal id
  and generation, device name, device kind, creation/refresh/expiry/revocation
  timestamps, refresh hash and optional source-credential id. Access records
  contain their session id, access hash and individual expiry. A credential
  exchange records its source credential; pairing records the invited identity.
  Device kind is descriptive metadata, one of command-center, companion or cli;
  it does not change the existing wire `clientKind` or grant node authority.
- The shared loader upgrades schema 1 by adding empty session collections under
  `credentials.lock`, preserving every existing field. Unknown schemas or invalid
  surviving records fail without a write. Upgrade all readers sharing the
  identity home before writing schema 2. Sessions survive gateway restart.
- Resolve the current session, principal generation, source credential when
  present and live roles on every authorization decision. Retired, replaced,
  revoked, missing or expired authority refuses access. Cache identity references
  only, with the existing store freshness and invalidation guarantees.

#### Gateway methods

`@farmslot/protocol` owns params, results and typed failures. None of these
methods accepts service or node credentials as person-session authority.

| Method                  | Authority and result                                                                                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.session.exchange` | Pre-authentication. Accept exactly one person credential or one-use pairing code, plus a device name and device kind. Verify current identity/generation inside the issuance transaction. Return session metadata, one access token and one refresh token. Never persist the submitted credential in a client. |
| `auth.session.refresh`  | Pre-authentication, refresh token only. Refuse expired/revoked/replaced authority without mutation. In one locked transaction extend refresh expiry by 30 days, update the refresh timestamp and issue a new one-hour access token. The refresh secret stays stable until revocation.                          |
| `auth.session.list`     | Authenticated person only. Return only that person's device ids, names, device kinds, timestamps and states. No secret, hash or token is returned.                                                                                                                                                             |
| `auth.session.revoke`   | Authenticated person only, selected device owned by that exact identity generation. Revoke idempotently and invalidate every access token for the device. Another person's device cannot be listed or revoked.                                                                                                 |

Existing `auth.connect` and HTTP authentication accept `fsa_` access tokens.
`AuthenticationRef` gains a person-session variant naming the device and access
records; it grants no role or ownership itself. Long-lived person credentials
are accepted only by exchange. Existing service/node credential paths remain.

Refresh does not invalidate other unexpired access tokens for the same device.
Prune expired access records during normal locked mutations. Concurrent refresh
and lost-response retries cannot revoke another device, create replacement
identity authority or replay a consumed pairing invitation. Pairing exchange
consumption and session issuance must share one atomic decision.

#### Clients and sign-out

One transport-neutral `PersonSessionClient` in `@farmslot/protocol` implements
refresh, single-flight coordination and typed expiry handling. Command Center,
Companion and the CLI supply RPC and private-storage adapters. They persist only
the refresh token and nonsecret session/gateway metadata; access tokens remain
in memory and never enter URLs, logs or persisted profiles. Credentials and
refresh tokens never enter worker task files or harness environments.

The controller refreshes before access expiry, on reconnect and before bounded
retry after an expiry response. Expired/revoked refresh authority clears its
stored session and requires sign-in. Network errors do not become successful
refreshes. HTTP downloads and WebSocket calls consume the same current access
identity. Scope storage and refresh to the explicitly selected gateway profile.

Clients show "Signed in on <device> until <date>" using refresh expiry. Command
Center settings list the person's devices and provide per-device revoke. Use
existing shared settings/list components. CLI login, logout and auth status
consume the same controller; no separate person-secret profile path remains.

Sign-out requires confirmation and gateway revocation before clearing the local
refresh token. Refresh expired access first when possible; a confirmed expired
or revoked session is already signed out. If revocation cannot be confirmed,
report that failure and allow retry. Never claim another device was revoked.

Cut over all three clients in one implementation. On encountering an old stored
person credential, remove that persisted person secret and require sign-in
through exchange; do not fall back to direct person authentication. Classify
legacy opaque profiles only through live gateway verification, never by token
grammar or a guessed subject. An unavailable gateway cannot authorize deleting
a service profile. Preserve
service profiles and node startup secrets. Remove the temporary client-only
expiry policy once the shared gateway session contract owns expiry.

Gateway-stamped person approvals identify their stable device session with
`personSessionId`. Historical and delegated-service receipts retain
`credentialId`; exactly one of these authority fields is present. All receipt
readers preserve existing evidence bindings, and final caller checks compare
the principal and the same authority kind/id. A refresh does not change that
identity. A person's startup browser handoff uses a one-use invitation so the
browser creates its own device session without receiving the CLI access token.

#### Validation required before cutover

Use isolated fixture identities and controlled clocks. Cover exact one-hour and
30-day boundaries, sliding refresh, restart persistence, independent devices,
concurrent refresh and lost responses, principal-generation mismatch, source
credential revocation, one-use pairing and failed atomic writes. Assert no raw
person credential or access token persists in any client.

Prove idle WebSocket subscriptions expire at the one-hour boundary without an
intervening request or store mutation. Prove confirmed sign-out and remote
device revoke invalidate existing WebSocket
subscriptions and HTTP access under the existing two-second freshness bound.
Prove service/node auth and automation attribution remain unchanged. Live
Command Center, Companion and CLI sign-in/reconnect/sign-out proof follows the
public gateway path; automation uses no person's real credential.

### Credential consolidation contract, 2026-10-14

This section governs the current implementation and replaces the environment
authentication and retirement rules in this specification. The
[operator reference](../reference/identity-and-credentials.md) owns login,
rotation and recovery instructions; ADR-051 Amendments 1 and 2 own these decisions.

1. Credential origins are `issued` and `paired`. Authentication accepts only
   the `fs_<credential-id>_<secret>` token grammar, resolves its credential and
   principal live, and rejects revoked or missing records. No process or
   checkout environment secret authenticates a caller or creates a principal.
   Before validation, the shared loader converts stored `env-migrated` origin
   metadata to `issued`. It takes the existing `credentials.lock` beside the
   supplied store path, rereads under that lock, validates the entire result,
   then persists through the atomic writer. An already-held writer lock is
   reused. Only origins change; ids, hashes, roles, revocations, activation,
   native-owner assignments and tombstones are preserved. Already-current
   stores are not rewritten. Lock contention or invalid surviving data refuses
   the load without a write. Unknown origins remain invalid. Boot regression
   and live protocol proof must load historical records, check idempotence,
   authenticate unaffected issued/paired credentials and reject raw secrets.
2. CLI clients select credentials from a gateway profile matching the target
   URL. A missing profile credential cannot borrow a secret from an environment
   variable or checkout file. Scripts use an explicitly selected automation or
   isolated test profile. Nodes use only `FARMSLOT_NODE_TOKEN` and cannot perform
   person/service operations, including HTTP file downloads.
3. Only a person may provide human attestations. Service principals automate
   farm work. Nodes remain bound to a machine with no role bindings. The
   deployment end state has one active credential per node and one for the named
   automation service; person devices pair separately.
4. `principal.retire` takes `{ principalIds: string[] }` and returns
   `{ principalIds: string[], credentialIds: string[] }`. It is admin-only.
   The CLI exposes `principal retire <id...> [--offline]` to the credential
   operator. The owning writer validates ids, refuses virtual ids, requires all
   selected principals to exist and all their credentials to be revoked,
   refuses any remaining node assignment to a selected owner, and keeps at least
   one active admin credential. It commits the whole retirement under the
   existing `credentials.lock` and invalidates deleted references.
5. The store retains `retiredPrincipalIds` and `retiredCredentialIds` as id-only
   tombstone arrays. Absent arrays mean empty for a store with no retirements.
   Ordinary creation and issuance cannot reuse those ids. Explicit admin principal-id
   reuse is the bounded exception described below. Historic authorship is retained
   without creating an alias to another principal. Unowned work remains
   unproven and requires explicit re-authoring before scheduling.
6. Offline retirement acquires the credential lock, proves no gateway sharing
   the identity home is live, and performs the same transaction. For cutover,
   it reads the selected revoked records without accepting their former origin
   as a runtime credential type. It validates the complete result against the
   current schema before writing. It cannot remove an active record, clear
   activation, modify a surviving principal or credential, or silently repair
   malformed surviving data. Failed validation leaves the store unchanged.
7. Native ownership stays immutable. Re-enroll a replacement node, verify its
   credential and transfers, revoke and retire the old node, then bind the new
   node to its owner. Never overwrite a live owner binding to enable retirement.
8. Proof covers actual authenticated gateway calls, node-only denials, profile
   routing with environment secrets absent, revocation and retirement effects,
   id reuse refusal, offline quiescence, last-admin refusal and recovery. Tests
   use isolated homes and service/node credentials. Live personal pairing is an
   operator step; automation never handles the person's secret.

#### Public surface

`farmslot principal create --reuse-retired-id <id>` and the admin-only
`principal.reuseRetiredId` RPC serve the explicit service-to-person identity
cutover. `@farmslot/credential-store` owns reuse through the existing
`CredentialStoreWriter.createPrincipal` options, retirement and offline writes.
`@farmslot/protocol` exports their params/results and optional
`Principal.generation`. The gateway's shared WorkOriginator helper stamps that
generation for authenticated work; stored-id resolution checks it at fire time.
No credential, role, or raw environment-auth contract changes.
The CLI, gateway and scripts ship together; harnesses use the inherited profile
and node authorization contract without an authentication extension.

This spec derives the **principal core** from ADR-051: the identity and credential types, the
credential store with its two coordination mechanisms, secret handling, principal resolution with
freshness, and session invalidation. It is the foundation every other part of ADR-051 compiles
against.

It deliberately builds **no authorization decisions**. Nothing here answers "may this principal call
this method". It answers only "which principal is this, and is that answer still current". The
authorization check, the operator allowlist, the conformance gate, the `principal.*`/`credential.*`
methods, node-subject enforcement, pairing changes, and work-item provenance are separate work; see
[Boundaries](#boundaries).

The store is scoped to one `FARMSLOT_HOME` while gateways are per-root and per-port, and that
asymmetry shapes three designs below: short-lived write locking, explicit offline retirement, and change-based freshness. Each is noted where it applies.

Where this spec and ADR-051 differ, the ADR governs.

## ADR sections implemented

| ADR section                                        | What this spec derives                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| §1 Principals, subjects, and role bindings         | `Principal`, `PrincipalSubject`, `Role`, `RoleBinding`, `RoleScope`                   |
| §1 Virtual principals                              | `local-admin` and `local-node`; the reserved-id rule for all virtual principals       |
| §2 One identity domain per `FARMSLOT_HOME`         | Every store-adjacent path resolving through `farmslotHome()`                          |
| §2 Credentials and storage                         | `CredentialRecord`, `StoredSecret`, `CredentialStore`, `schemaVersion`                |
| §2 Store (permissions, atomicity, write exclusion) | The store module, `credentials.lock`, and the fail-closed load contract               |
| §2 Secret handling                                 | Entropy, wire format, `scrypt-v1`, constant-time comparison                           |
| §2 Presenting a credential over the wire           | Store resolution replacing the single configured-value comparison                     |
| §2 Revocation and invalidation 1-3                 | `AuthenticationRef`, live lookup, session invalidation, verification cache, freshness |
| §3 Activation latch (`activatedAt`)                | The stored latch and the writes that set it                                           |
| §3 Two write mechanisms                            | `credentials.lock` for atomicity; the gateway presence marker for quiescence          |
| §3 Last-admin invariant                            | A running gateway's store writer refusal, evaluated against freshly read state        |
| Amendment 1 Credential consolidation               | Explicit profile authentication and retirement without environment identity           |
| §7 Writer-side revoke primitives                   | Credential and role revocation on the writer, per §7's boundary note                  |

Not implemented here, though the sections are adjacent: §2 invariant 4 (outbound filtering), §4, §5,
§6, and the rest of §7.

## Types

### Identity — `packages/protocol/src/rpc/principal.ts` (new)

Identity types live in the protocol package because §7 already fixes them as wire types:
`PrincipalListResult` carries `Principal[]` and `SelfPrincipalSummary` carries `RoleBinding[]`.
Placing them anywhere else would force a move when §7 lands.

```ts
interface Principal {
  id: string;
  subject: PrincipalSubject;
  roles: RoleBinding[];
  generation?: number; // absent means original identity, generation zero
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

Export from `packages/protocol/src/rpc/index.ts` alongside the existing `rpc/auth.js` export.

Rules that bind every consumer:

- `roles: []` is legal and authorizes nothing. No code path may read absence or emptiness as
  permission.
- `RoleScope` is a discriminated union. There is no absent-means-global rule, and no code may treat a
  missing scope as global.
- `machine` is required inside the `node` variant.

### Credentials and store — `services/gateway/src/security/credential-store.ts` (new)

These are gateway-internal. §7 states that `CredentialSummary` is the only credential shape that
leaves the gateway, so `CredentialRecord`, `StoredSecret`, and `CredentialStore` are not exported
from the protocol package.

```ts
interface CredentialRecord {
  id: string;
  principalId: string;
  displayName: string;
  secret: StoredSecret;
  origin: 'issued' | 'paired';
  createdAt: string;
  revokedAt: string | null;
}

interface StoredSecret {
  scheme: 'scrypt-v1';
  salt: string; // base64
  hash: string; // base64
}

interface CredentialStore {
  schemaVersion: 1;
  activatedAt: string | null;
  principals: Principal[];
  credentials: CredentialRecord[];
  retiredPrincipalIds?: string[];
  retiredCredentialIds?: string[];
  principalIdReuses?: { principalId: string; generation: number; reusedAt: string }[];
}
```

Retired-id arrays are optional and default to empty; all other fields are required. `revokedAt === null` means active; revocation writes a tombstone and never
deletes an active record. Explicit retirement removes revoked records and keeps their ids as tombstones so a re-used id cannot resurrect access. `createdAt` is the rotation-age signal.
Timestamps are **ISO-8601 UTC** strings — a ruled choice, because the store is read by whichever
deployment in the domain opens it next.

### Session reference — `packages/protocol/src/rpc/principal.ts`

```ts
/** Opaque to the session: how this session authenticated, never what it may do. */
type AuthenticationRef = { kind: 'credential'; credentialId: string };
```

One variant in this node. The union exists so later resolution strategies are additive.

## Scope: one identity domain per `FARMSLOT_HOME`

§2 scopes everything in this node to one `FARMSLOT_HOME`, not to one machine. This is an
implementation rule before it is a wording preference: **every path below resolves through
`farmslotHome(env)` (`packages/protocol/src/node/farmslot-home.ts:11-15`), and nothing hard-codes
`~/.farmslot` or reasons about "the machine".** That helper exists so a custom `FARMSLOT_HOME` "can
never half-apply", and it is imported by both the CLI and the gateway for that reason. The default is
`~/.farmslot`, so the domain is machine-wide by default rather than by design.

Four things live in that directory and therefore share one scope by construction, unable to disagree
about which domain they protect: the credential store, the `activatedAt` latch inside it,
`credentials.lock`, and the gateway presence marker. Every rule below inherits that premise rather
than restating it.

**The operator-visible consequence runs both ways.** Deployments sharing a `FARMSLOT_HOME` share one
identity domain — the same principals, the same activation state. A deployment that wants its own
principals and its own solo-mode lifecycle sets its own `FARMSLOT_HOME`; that is the supported
separation mechanism and it already exists.

## Coordination: two mechanisms, two questions

§2 and §3 place two distinct mechanisms on the store. They answer different questions and neither
substitutes for the other. Both live in `FARMSLOT_HOME` because the store does, and because the
gateway singleton lock cannot serve either: `acquireGatewaySingletonLock()` writes
`<farmslotRoot>/.runs/gateway-<PORT>.pid` (`services/gateway/src/index.ts:100-144`), scoped per root
_and_ per port, while `credentials.json` is shared across all of them.

### New: `services/gateway/src/security/credential-store-lock.ts` — write exclusion

`credentials.lock` beside the store. **Exclusive but short-lived: held for the duration of a single
read-modify-write and released.** Every writer takes it — any running gateway, and the offline CLI.
A gateway never holds it while merely running, so the per-root, per-port gateways the design permits
do not exclude one another; concurrent writes serialize and running gateways do not contend.

The single entry point is a wrapper, so no caller can write outside the exclusion:

```ts
withCredentialStoreLock<T>(fn: (store: CredentialStore) => { next: CredentialStore; result: T }): T
```

It acquires the lock, **re-reads the store file from disk**, passes that fresh value to `fn`, writes
the returned store, releases, and returns the result. Re-reading inside the lock is load-bearing
rather than defensive: with several gateways writing, an in-memory projection may be stale by the
time the lock is granted, and the last-admin invariant would then be evaluated against a store that
no longer exists.

Acquisition copies `acquireGatewaySingletonLock()` (`index.ts:100-144`), the existing proven pattern:

- `openSync(lockPath, 'wx')` then write `process.pid` — the exclusive create is the atomic step.
- On `EEXIST`, read the recorded pid. A live pid (checked with `processIsAlive()`, `index.ts:90-98`,
  where `EPERM` still counts as alive) means the lock is genuinely held: retry briefly, then refuse.
  A dead or malformed pid means a stale lock: unlink and retry the exclusive create, so a crashed
  writer does not wedge the store.
- Release unlinks only when the recorded pid is still this process, matching `index.ts:109-113`.

Refusal names the holder:

```
Another Farmslot process is writing the credential store (pid <pid>).
Next: wait for it to finish, or stop that process and retry.
```

Because the lock is short-lived, contention is bounded by one whole-file write, so a brief retry
before refusing is the right behaviour rather than failing on first contact.

### New: `services/gateway/src/security/gateway-presence.ts` — quiescence

§3 requires that an offline operation additionally prove **no gateway is running in this identity
domain**. Gateways under a different `FARMSLOT_HOME` are a different domain and are irrelevant to
this check. This is a separate requirement with a different reason: a running gateway holds in-memory
state derived from the store, and while change-based freshness makes it converge on an external
write, requiring quiescence removes the window entirely for deliberately out-of-band operations. It
protects cache coherence, not write atomicity, which is why the store lock alone is insufficient.

The marker is held in **shared** mode by every running gateway for its lifetime and acquired
**exclusively** by an offline operation. Node's standard library has no advisory file locking, so
shared mode is represented as a directory of per-gateway entries under
`join(farmslotHome(env), 'gateways.live')`:

- **Register** — a gateway writes one entry at start recording `pid`, `farmslotRoot`, and `port`, and
  removes it on shutdown. All three fields are stored because §3's refusal names each running gateway
  by root and port.
- **Live set** — entries whose pid fails `processIsAlive()` are stale and are reclaimed on read, so a
  crashed gateway does not permanently block offline management.
- **Exclusive acquisition** — an offline operation succeeds only when the live set is empty. Because
  the directory sits beside the store, "empty" means no gateway running in this identity domain,
  which is exactly the set whose in-memory state the operation could invalidate.

Registration and deregistration happen **while holding `credentials.lock`**, and an offline operation
holds that same lock across its presence check and its read-modify-write. Without that, a gateway
starting between an offline operation's check and its write would defeat the check. This is the
minimum needed to make the two mechanisms correct together; the lock stays short-lived in both paths.

Refusal names what is running, per §3:

```
Cannot modify the credential store: 2 gateways are running
(/Users/…/farmslot on port 7789, /Users/…/other-root on port 8808).
Next: stop them, then re-run this command.
```

## What changes, file by file

### New: `services/gateway/src/security/credential-store.ts`

Owns the file, the in-memory projection, and the freshness check. Sits beside `auth.ts` in the
existing `security/` folder.

**Path.** `join(farmslotHome(env), 'credentials.json')`, using
`packages/protocol/src/node/farmslot-home.ts`. Same home directory as `gateways.json`
(`gateway-profiles.ts:29-31`).

**Load.** `loadCredentialStore(path)`:

- File absent → return the empty store `{ schemaVersion: 1, activatedAt: null, principals: [],
credentials: [] }` without writing anything. No file exists until the first mutation. This matches
  `loadProfiles()` (`gateway-profiles.ts:33-54`), which returns `{ gateways: {} }` for an absent file.
- Parse failure, non-object shape, or a record failing structural validation → throw naming the file,
  as `loadProfiles` does at `gateway-profiles.ts:38-52`. The gateway does not start.
- `schemaVersion !== 1`, including absent → throw naming the file and the version found. The gateway
  does not start. This is the fail-closed rule of §2, not a migration hook.

Structural validation is per record and total: every field of `CredentialRecord`, `StoredSecret`, and
`Principal` is checked for presence and type, subject and scope discriminants are checked against
their known variants, and an unknown `StoredSecret.scheme` is a load failure. A partially valid store
is a rejected store — there is no "skip the bad record" path, because a silently truncated store is
exactly what §2 refuses to run on.

**Validation is not only structural: §1's node rule is checked at load.** A `node`-subject principal
holds `roles: []` and is authorized by its subject alone, so a stored node principal carrying any
role binding is a **load failure**, named like any other, and the gateway does not start. Accepting
it and ignoring the roles would be the wrong failure mode — a node record with an `admin` binding is
either corruption or tampering, and the store is the thing authorization reads. The same rule is
enforced on the way in by `createPrincipal`, so the load check is a backstop against records that did
not come through this writer rather than a duplicate of it.

**Save.** `saveCredentialStore(store, path)`, combining §2's permission and atomicity rules. It is
called only from inside `withCredentialStoreLock` and asserts the lock is held.

1. `mkdirSync(dirname(path), { recursive: true, mode: 0o700 })`
2. `writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })` where `tmp` is
   `${path}.${process.pid}.tmp` — the same directory, so the rename is atomic. Naming follows
   `github-bindings-cache.ts:65-69`.
3. `chmodSync(tmp, 0o600)` — the write mode only applies on create and is subject to umask, which is
   why `gateway-profiles.ts:59-60` chmods explicitly. Doing it **before** the rename means the
   published file is never observable with wider permissions.
4. `renameSync(tmp, path)`

Every mutation is a whole-file write. There is no partial update path.

**In-memory projection and freshness.** The store is loaded at gateway start into a module-level
value, along with a **freshness stamp** taken from the file: `{ dev, ino, mtimeMs, size }`.

```ts
ensureFresh(): void   // stat the store; reload and invalidate when the stamp differs
```

`ensureFresh()` compares a `statSync` of the store path against the stamp and, on any difference,
reloads the store, clears the verification cache, and replaces the projection. An absent file where
one was present, or present where absent, counts as a difference. This is the "cheap freshness check
on store identity and modification metadata" §2 invariant 3 requires.

**Lazy freshness alone cannot satisfy invariant 2, so detection is also proactive.** `ensureFresh()`
runs on request-driven paths, and a subscription is a _push_ stream: after an external writer revokes
a credential or changes a binding, the affected session may never make another request, so no
authorization decision ever occurs and its subscription keeps delivering. The gateway therefore also
**polls** the store on an interval, running the same `ensureFresh()` and, on a detected change,
invalidating sessions as described under Session invalidation.

**A poll rather than a watch, and the reason is this node's own write mechanism.** Every write lands
by `rename`, which replaces the file's inode. An `fs.watch` handle bound to the store path keeps
watching the _old_ inode and stops seeing changes after the first external write — the failure would
be silent and would look exactly like "no writes happened". Watching the containing directory avoids
that but trades it for platform-inconsistent event delivery and coalescing, and `FARMSLOT_HOME` also
holds the lock and presence entries, so directory events are noisy in a way that has nothing to do
with the store. A `statSync` poll is one code path shared with the lazy check, has no inode-identity
problem because it re-stats the path each time, and bounds staleness deterministically.

**The interval is a security parameter, and the specified value is 2 seconds.** It is not a tuning
knob: the interval _is_ the bound on how long a revoked credential's or demoted principal's
subscription may continue receiving push events, because on an otherwise idle session the poll is the
only thing that will ever notice. Raising it to five minutes would leave revoked authority receiving
events for five minutes. **Changing this value changes the invalidation guarantee, so it is a change
to the security contract and needs the same scrutiny as any other — not a configuration decision.**
This is the one number in this node where "documented default" would be the wrong framing, and it is
called out precisely because the verification cache's bound sits nearby and genuinely is tuning — the
two must not be read as the same kind of value.

**The window is inherent to detection by polling, not introduced here.** Any polled detector has one;
a watch-based mechanism would bound it by event-delivery latency instead, which is usually smaller
but — for the inode reason above — not reliably _present_ after a rename. Choosing the poll accepts a
known, stated, testable bound over an unstated one that can silently become infinite.

**Invalidation is change-based, not authorship-based.** A gateway that invalidated only on its own
writes would keep serving revoked authority after any external write — another gateway's or an
offline operation's — because the store is shared across the identity domain. So the projection is invalidated on this
gateway's own writes _and_ whenever `ensureFresh()` observes a change underneath it.

**Reads (used by resolution).** Each is called after `ensureFresh()` on the resolution paths below.

- `findCredential(credentialId): CredentialRecord | undefined`
- `findPrincipal(principalId): Principal | undefined`
- `isActivated(): boolean` — `activatedAt !== null`
- `activeAdminCredentialCount(store): number` — credentials with `revokedAt === null` whose
  `principalId` resolves to a principal holding a `{ role: 'admin', scope: { kind: 'global' } }`
  binding. A credential whose principal is missing does not count, matching the fail-closed rule. It
  takes the store explicitly because the writer evaluates it against freshly read state, not the
  projection.

**Writer.** A single `CredentialStoreWriter` owns every mutation, each one a `withCredentialStoreLock`
call. §7's boundary note places the revoke primitives in this node: the last-admin invariant lives on
the writer and must be provable before any handler can reach it.

- `createPrincipal(subject, roles): Principal` — refuses a reserved id, and refuses a `node` subject
  carrying any role (both below)
- `issueCredential(principalId, displayName, origin): { record, secret; adminGrant?: { record, secret } }`
  — latches `activatedAt` on the first issuance if it is not already set, and performs the dual mint
  below when that latch would otherwise leave no admin
- `revokeCredential(credentialId): CredentialRecord`
- `revokeRole(principalId, role, scope): Principal`

**Two invariants bracket activation, and both live on the writer.** §3 reaches "activated with no
active admin credential" two ways and closes both here.

**The dual mint closes the first way.** A _first_ issuance that mints only a non-admin credential
would latch activation while leaving no admin, so an operator could authenticate and nobody could
manage the store. §3 calls the dual mint "a correctness requirement, not a convenience", so
`issueCredential` may not complete an activation-latching issuance that leaves
`activeAdminCredentialCount() === 0`: in the **same** atomic write it also creates an owner principal
with `{ role: 'admin', scope: { kind: 'global' } }` and a credential over it, and returns that second
secret as `adminGrant` so the caller can surface it. One write, so activation and its admin can never
half-apply. §3's carve-out is preserved exactly: this binds a running gateway's writer, and an
offline first issuance can still create a non-admin and nothing else — that is the one path by which
row four survives, and it is deliberate.

The caller-facing side of that flow — writing the owner credential into the active gateway profile
and printing the activation walkthrough — is CLI work in a later node. What this node owes is that
the secret exists, is returned exactly once, and is never recoverable afterwards.

**The last-admin invariant closes the second way.** `revokeCredential` and `revokeRole` compute
`activeAdminCredentialCount()` against the **prospective** store, derived from the copy read inside
the lock, and refuse when it would reach zero, with the teaching error of §3:

```
Refusing to revoke credential '<name>': it is the last active admin credential,
and removing it would leave this gateway with no way to issue or revoke anything.
Next: issue a replacement admin credential first, then revoke this one:
  farmslot credential issue --principal <principal> --name <new-name>
```

The invariant binds a running gateway's writer only. §3 states explicitly that it does not apply to
offline store editing, which is the recovery path.

Each successful mutation calls the invalidation hook below before returning.

### New: `services/gateway/src/security/credential-secret.ts`

- `generateCredentialSecret(): string` — `randomBytes(32).toString('base64url')`.
- `generateCredentialId(): string` — 128-bit random, hex-encoded: `randomBytes(16).toString('hex')`.
  §2 pins hex because the base64url secret alphabet contains `_` and would make the delimiter
  ambiguous; the width is a ruled choice.
- `formatCredentialWire(credentialId, secret): string` — `` `fs_${credentialId}_${secret}` ``.
- `parseCredentialWire(presented): { credentialId, secret } | null` — requires the `fs_` prefix, then
  splits at the **first** `_` after it. The remainder is the secret verbatim, so a base64url secret
  containing `_` parses correctly. Anything else returns `null` and authentication is refused.
- `hashSecret(secret): StoredSecret` — `scheme: 'scrypt-v1'`, `salt` = 16 random bytes, `hash` =
  `scrypt(secret, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 67108864 })`. `maxmem` is set explicitly
  because `128 · N · r` is exactly 32 MiB and sits on Node's default boundary. Both fields are
  base64-encoded, as pinned in the `StoredSecret` comments.
- `verifySecret(presented, stored): boolean` — rejects an unrecognized `scheme` outright, then
  **validates the stored fields before deriving anything**: `salt` and `hash` must decode as base64,
  and the decoded `hash` must be exactly `dkLen` bytes. Any failure returns `false`. Only then does it
  derive a key from `presented` with the stored salt and the pinned parameters and compare with
  `timingSafeEqual`.

  **The length check is explicit, not structural.** `timingSafeEqual` _throws_ on buffers of
  differing length rather than returning false, and `StoredSecret` fields are read from a file that
  can be corrupted or attacker-influenced — so treating `dkLen` as guaranteed by construction would
  turn a malformed record into an exception on the authentication path instead of a clean denial.

- `safeEqualSecret(actual, expected): boolean` — moved here unchanged from `auth.ts:271-281`. See the
  `auth.ts` entry below for why it survives.

There is no rehash-on-authentication path. §2 permits one, but only one scheme exists, so there is
nothing to upgrade to and the code would be unreachable.

### New: `services/gateway/src/security/verification-cache.ts`

§2 invariant 3: verification may be cached, authority may not. `authorizeHttpRequest()` authenticates
every `/api/file` and `/api/run-artifact` request (`auth.ts:216-235`) and the Companion loads images
through that path, so `scrypt` at N = 2^15 per request would be a visible regression.

The cache maps **a digest of the presented secret to a credential id, and nothing else**:

- **Key** — `createHash('sha256').update(presented).digest('base64')`. Fast relative to `scrypt` by
  orders of magnitude, and collision-resistant, so a wrong secret cannot key onto another
  credential's entry. Holding a digest of a 32-byte random secret in memory adds no exposure beyond
  holding the secret itself, which the process already does while verifying it.
- **Value** — the `credentialId` only. No principal, no roles, no record.
- **Population** — successful verifications only. A failed verification is not cached; the rate
  limiter (`auth.ts:57-95`) already bounds repeated wrong secrets, and caching negatives would add a
  second thing to invalidate for no gain.
- **Bound** — at most 256 entries with least-recently-used eviction. **This is a documented default,
  not a security property.** The population is the set of credentials in active use, which is small;
  the cap exists so a flood of distinct values cannot grow it, and eviction is never a correctness
  concern because a miss just re-derives. Tuning it changes only how often the KDF runs.
- **Invalidation** — cleared on this gateway's own writes and by `ensureFresh()` when the store has
  changed underneath it.

**The security properties are the other three, and they are not negotiable against cache policy**:
the cache is cleared on every store write, it is consulted only after `ensureFresh()`, and it never
caches authority — no principal, no roles, no record, only a credential id that must still be
resolved and revocation-checked on every use.

A cache hit **skips only the KDF**. Resolution still reads the credential record and its principal
from the live store, so a revoked credential or a changed binding takes effect on the next request no
matter what is cached.

### New: `services/gateway/src/security/principal-resolver.ts`

The single place that answers "who is this". **Every entry point calls `ensureFresh()` first.** §2
invariant 3 places that check before _any_ authority resolution rather than only before credential
verification: an established session authenticates once and then resolves authority on each request
without re-verifying a secret, so a check sitting only in front of the cache would never run for it,
and another writer's revocation would never reach it.

```ts
type PrincipalResolution =
  | { ok: true; principal: Principal; authentication?: AuthenticationRef }
  | { ok: false; reason: 'no_credential' | 'revoked' | 'missing_principal' | 'secret_mismatch' };
```

**`resolveSecret(presented: string, transport: 'token' | 'password'): PrincipalResolution`**
resolves only issued or paired token credentials. Password transport is always refused.

1. Call `ensureFresh()`.
2. Refuse any transport except `token` before consulting the cache.
3. Consult the verification cache. A hit yields only a credential id.
4. Otherwise parse the credential wire format and look up its embedded id. Refuse malformed
   or raw values; no environment value or boot mapping participates.
5. Refuse revoked records and missing principals on both cache hits and misses.
6. On a cache miss, verify the secret with the stored KDF hash, then cache only the id.
7. Return the live principal and `{ kind: 'credential', credentialId }`.

Transport validation, revocation and principal lookup must run even on a warm cache.

**`resolveSessionPrincipal(session): PrincipalResolution`** — the per-check path, called on every
authorization decision rather than once per session:

1. `ensureFresh()`.
2. Solo mode (below) and no cached ref → the virtual principal for the session's `clientKind`:
   `local-node` for `'node'`, `local-admin` otherwise. §3 makes that choice at session establishment
   from `clientKind`, not inside the check.
3. A cached `AuthenticationRef` → repeat steps 5 and 6 above against the live store. No secret and no
   KDF are involved; the reference is resolved, not the secret.
4. Neither → `{ ok: false, reason: 'no_credential' }`.

A cached role cannot outlive its record because there is no cached role, and a revocation written by
another gateway or by an offline operation reaches this session at step 1.

**Virtual principals** are constructed values with no stored record, exactly as §1's table specifies:

| id            | subject                                                        | roles                                            |
| ------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| `local-admin` | `{ type: 'person', displayName: 'local' }`                     | `[{ role: 'admin', scope: { kind: 'global' } }]` |
| `local-node`  | `{ type: 'node', displayName: <machine>, machine: <machine> }` | `[]` — subject-authorized                        |

They carry real role bindings, so authorization code sees an ordinary `Principal` and has no
virtual-principal branch.

**Reserved ids are one rule, not a list of cases.** §1 reserves _every_ virtual principal's id and
extends that to any virtual principal added later. The resolver therefore exports a single
`VIRTUAL_PRINCIPAL_IDS` constant, and `createPrincipal` refuses any id in it. The constant today is
`['local-admin', 'local-node', 'system']`. `system` appears even though this node never constructs it
— §5.5 owns that principal — precisely because the reservation is generic: adding the resolver later
must not be the moment the id becomes protected, since a stored principal shadowing `system` would
inherit admin over gateway-scheduled work. Adding a virtual principal in future means adding one
entry here and nothing else.

**Node subjects carry no roles, and the writer enforces it.** §1 states that a `node`-subject
principal has `roles: []` and is authorized by its subject alone; roles are meaningful only for
`person` and `service` subjects. `createPrincipal` therefore refuses a `node` subject with a
non-empty `roles` array rather than silently storing or dropping the bindings, and the loader rejects
such a record fail-closed. Both checks exist because they catch different things: the writer stops it
being created through this gateway, the loader stops it being honoured if it arrives any other way.
The virtual `local-node` already satisfies the rule with `roles: []`, so this adds no special case
for it.

**Solo mode** is derived, never stored:

```
soloMode = !store.activatedAt && bindIsLoopbackOnly && !trustProxyHeaders
```

`bindIsLoopbackOnly` and `trustProxyHeaders` are boot facts already available where
`assertGatewayBindAllowed` is called (`index.ts:201-205`); `activatedAt` is read through the fresh
projection, so a latch written by any writer takes effect here. No `AuthenticationRef` is cached for
a solo session.

**Activation is shared by the identity domain, and the implementation should expect that rather than
treat it as a fault.** `activatedAt` is stored, and the store is one per `FARMSLOT_HOME`, so issuing
a credential from one deployment latches activation for _every_ deployment sharing that home: their
`local-admin` and `local-node` stop resolving, and their co-launched nodes need issued credentials
per §6. A gateway that was never given a secret and binds only to loopback can therefore leave solo
mode because a different deployment activated. That is shared domain, shared activation — the same
rule as shared principals, seen from the lifecycle side. **A deployment that needs its own solo-mode
lifecycle sets its own `FARMSLOT_HOME`**, which is the separation mechanism §2 already describes,
applied to activation rather than to identity.

### Gateway authentication and explicit retirement

Gateway startup loads the credential store without importing any environment token or password.
`resolveGatewayAuth` derives token mode from the activation latch. Unactivated loopback-only
homes may use solo mode; environment values cannot activate a home or create a principal.

`authenticateGatewayClient` accepts issued/paired tokens, preserves remote rate limiting and
loopback exemption when proxy headers are not trusted, and rejects password presentation.
Resolution failures use `credential_mismatch` without revealing whether an id exists.

`getHttpCredential` accepts Bearer, token query parameters for header-incapable resources, and
`farmslot_gateway_credential` cookies. Basic, password query parameters and password cookies
are refused. HTTP authority still delegates to the shared authorization contract; node credentials
cannot read files through the person/service HTTP route.

`requireAuthenticatedSession` resolves the current principal for every request. The rate limiter,
request-IP rules and solo-mode exposure protections remain in force. No raw-secret comparator
or environment-reconciliation writer is part of authentication.

The explicit `principal.retire` and offline CLI operation follow the consolidation contract above.
Runtime loading migrates stored `env-migrated` origins as specified above and refuses all other
unknown credential origins. Only the offline retirement transaction may
read a revoked record with an old origin, remove it with its selected principal, validate the complete
surviving store and save it under the ordinary lock. This is a cutover operation, never authentication.

### Changed: `services/gateway/src/server/client-state.ts`

`ClientState` (`:37-46`) gains `authentication?: AuthenticationRef`. Nothing else about the session is
added — no principal, no roles, no cached authority.

### Changed: `services/gateway/src/server.ts`

- Connection setup (`:110-131`) currently marks every socket `authenticated: true` when
  `auth.mode === 'none'` and sends the privileged hello immediately (`:131`). The condition becomes
  solo mode. Behaviour is otherwise unchanged in this node; filtering the hello and broadcasts by the
  receiving principal is §2 invariant 4 and belongs to the authorization node.
- The `auth.connect` handler (`:501-543`) stamps `state.authentication` from the result alongside the
  fields it already sets at `:526-529`. The response payload at `:531-540` is unchanged — the §7
  `principal` summary is a later node.
- `requireAuthenticatedSession` at `:546` is unchanged at the call site; its semantics change inside
  `auth.ts` as described.
- A new exported `closeSessions(predicate)` walks `clients` and closes matching sockets with a
  WebSocket close, which tears down that session's subscriptions with it. The store writer calls it
  through a hook registered at start so that `security/` does not import the server.
- `broadcast` (`:624-634`) is **unchanged**. Per-principal outbound filtering is §2 invariant 4.
- The node frame guards (`:135-244`) are **unchanged**. They currently key on
  `auth.mode !== 'none'` and `clientKind !== 'node'`; requiring a `node`-subject principal is §6.

### Changed: `services/gateway/src/index.ts`

After the environment files load (`:173-188`) and before the auth runtime is built (`:201`): register
the gateway presence entry, load the store, register the invalidation
hook, and start the freshness poll. Deregister the presence entry and stop the poll on shutdown
alongside the singleton lock release, including on the `SIGINT` and `SIGTERM` paths at `:164-171`.
The poll's timer is unref'd so it never holds the process open by itself.

A store-load failure is fatal and the process exits with the file named — §2 requires the gateway to
refuse to start rather than run on a store it cannot read.

### Deliberately unchanged

- `packages/cli/src/gateway-profiles.ts` — a credential is presented as the existing token mode, so
  `profileCredential()` (`:100-106`) already maps a stored secret onto the `auth.connect` shape.
- `packages/cli/src/commands/up.ts` — `ensureTokenAuthEnv()` (`:190-212`) keeps minting a per-root
  token. Additive-only reconciliation is what makes that safe against a domain-shared store.
- `packages/protocol/src/rpc/auth.ts` — `GatewayAuthConnectResult` (`:18-27`) and
  `PairingCreateParams` (`:29-33`) are §7 changes.
- `services/gateway/src/fleet/pairing.ts` — `pairingExchange` still returns the runtime secret. Minting
  a credential is §7.
- `services/node/src/index.ts` — the module-scope credential resolution at `:62` and
  `resolveGatewayCredential` at `:631` are the §6 node change.
- `packages/protocol/src/rpc/registry.ts` — no new methods in this node.

## Session invalidation

§2 invariant 2 requires that credential revocation, role-binding change, and the activation latch
each close or downgrade every affected open session, **including subscriptions**. All three
invalidate sessions in this node; none of them is deferred.

- **Credential revocation** → close every session whose `AuthenticationRef` names that credential id.
  The next frame from that client must re-authenticate, and it will fail.
- **Activation latch transition** → close every session. §3 states the consequence directly: open
  sessions must re-authenticate and their subscriptions are closed. Solo sessions in particular must
  drop, because `local-admin` and `local-node` stop resolving at that moment.
- **Role-binding change** → close every session whose resolved principal is the one whose bindings
  changed. Closing takes the invariant's _close_ arm, which this node can satisfy completely: closing
  the socket tears down that session's subscriptions with it, so a principal cannot keep receiving a
  surface its new bindings no longer permit.

**Why closing rather than downgrading, stated so a later node does not read it as an oversight.** The
invariant offers close _or_ downgrade. Downgrading — keeping the session open and narrowing what it
receives — is the better operator experience, but it requires per-principal outbound filtering of
`broadcast` and `sendHello`, which is §2 invariant 4 and needs the authorization check that does not
exist yet. Closing is the arm that is fully implementable now and is strictly the safer of the two,
so this node takes it. **The mechanism may later be refined from close to downgrade; the invariant
itself is satisfied here, not deferred.** Request-path authority is separately already correct
without any session action, because nothing caches a role and every decision re-resolves.

The writer calls the hook after the write succeeds, never before, so nothing is invalidated for a
mutation that did not land. The hook clears the verification cache and closes sessions per the rules
above.

### External writes invalidate too

**The three rules above are triggered by any observed change, not only by this gateway's writes.**
Confining them to local writes would not satisfy §2 invariant 2: the store is shared across the
identity domain, so another gateway or an offline operation can revoke a credential, change a
binding, or latch activation, and those sessions' subscriptions would keep delivering — a push stream
never reaches an authorization decision, so lazy freshness cannot reach it.

When the poll (or any `ensureFresh()`) observes a change, the gateway **diffs the reloaded store
against the projection it replaced** and derives the affected sets: credentials newly carrying a
`revokedAt`, principals whose `roles` differ, and an `activatedAt` that transitioned from null. It
then re-resolves every open session and applies exactly the same three rules — so an external
revocation closes the sessions holding that credential, an external role change closes that
principal's sessions, and an external activation closes all of them. A session whose resolution now
fails for any reason is closed regardless of which set it fell in, which is the fail-closed backstop.

**Closing is this node's work; filtering the content of a surviving session is not.** Downgrading —
keeping a session open and narrowing what it receives — needs per-principal outbound filtering
(§2 invariant 4). This node takes the invariant's _close_ arm on every path, local and external
alike, which discharges "including subscriptions" completely because a closed socket has none.

## Test obligations

Stated as behaviours to prove.

**Fail-closed load**

- A store file containing invalid JSON causes the gateway to refuse to start, and the error names the
  file path.
- A store file whose `schemaVersion` is absent, or is any value other than `1`, causes the same
  refusal — not a silent upgrade and not a default.
- A store containing one structurally invalid record is rejected whole; no valid record from that file
  is loaded.

**Fail-closed resolution**

- A credential whose `principalId` matches no principal does not authenticate, even when the presented
  secret verifies against its hash.
- A credential with a non-null `revokedAt` does not authenticate.
- A presented secret whose embedded credential id does not exist does not authenticate, and the
  failure is indistinguishable on the wire from a wrong secret for an existing id.
- A `StoredSecret` with an unrecognized `scheme` never verifies.
- A stored `node`-subject principal carrying any role binding is a load failure that names the file,
  and the gateway does not start — the roles are not dropped and the record is not skipped.

**Credential transport**

- **An issued credential presented in the `password` field is refused**, and refused without a store
  lookup, even though the identical value in the `token` field authenticates. This is the property
  that rejects password transport.
- The same holds for a paired credential, since both carry the `fs_` prefix.
- **Refusal survives a warm cache.** Authenticate the credential successfully through `token` so the
  verification cache holds it, then present the identical value through `password` and assert it is
  refused. This is the test that proves transport validation precedes the cache: a cache consulted
  first would return the credential id and authenticate it.
- Environment token and password values neither authenticate nor create an identity.

**HTTP transport mapping**

- Each scheme resolves on exactly the transport the table specifies: Bearer, query parameter, and
  cookie as `token`; Basic is refused.
- **`authorizeHttpRequest` never populates both fields** — assert on the params it builds, since this
  is the laundering path and a behavioural test would pass while the bug is present.
- **An issued credential presented as HTTP Basic is refused**, while the same credential presented as
  Bearer authenticates.
- A Companion image request carrying `?token=<issued credential>` authenticates, so the header-less
  path keeps working.
  **Store file properties**

- After a save, the store file's mode is `0600` and its directory's is `0700`.
- Saving over an existing file whose mode was widened restores `0600`.
- A save that fails partway leaves the previous store readable and unchanged — assert by writing over
  a populated store with a failure injected between the temp write and the rename, then loading.
- No temp file remains in `FARMSLOT_HOME` after a successful save.
- No store file is created by loading, or by starting a gateway with no environment secret and no
  store.

**Write exclusion**

- `withCredentialStoreLock` releases the lock before returning, so no lock file remains after a write.
- Two concurrent read-modify-writes serialize and both mutations survive — the second must not clobber
  the first, which is what re-reading inside the lock buys.
- A lock whose recorded pid is dead is reclaimed rather than blocking forever.
- Release removes the lock file only when the recorded pid is the releasing process.
- `saveCredentialStore` refuses to write when the lock is not held.
- **A running gateway does not hold the lock**, so a second gateway on a different root or port starts
  successfully while the first is serving.

**Identity domain scoping**

- A custom `FARMSLOT_HOME` yields its own store, latch, `credentials.lock`, and presence directory:
  two gateways under different homes share nothing, and activating one leaves the other in solo mode.
- No path in this node is derived from `~/.farmslot` directly — assert by running the whole suite
  under a `FARMSLOT_HOME` override and confirming nothing is created in the default location.
- Two gateways under the same `FARMSLOT_HOME` see one another's credentials and one another's
  activation latch.

**Quiescence**

- An offline operation is refused while any gateway's presence entry in this domain is live, and the
  error names each running gateway by root and port.
- A gateway running under a _different_ `FARMSLOT_HOME` does not block the operation.
- **The registration race is closed.** Interleave a gateway registering its presence entry with an
  offline operation performing its presence check and read-modify-write, and assert the two outcomes
  are the only ones reachable: either the offline operation completes and the gateway registers
  afterwards, or the gateway registers first and the offline operation is refused. A gateway must
  never register _between_ the offline operation's check and its write. Drive it by holding each
  side at the point after acquiring `credentials.lock`, which is the interleaving the lock exists to
  close.
- An offline operation succeeds when no live entry exists.
- A presence entry whose pid is dead is reclaimed, so a crashed gateway does not permanently block
  offline management.
- A gateway registers its entry at start and removes it on shutdown, including on `SIGINT` and
  `SIGTERM`.
- Two gateways register simultaneously and both appear, proving shared mode.

**Secret handling**

Every pinned value in §2 gets an obligation, because a KDF parameter that drifts produces no visible
failure — the system keeps working, weaker.

- A generated secret decodes from base64url to **exactly 32 bytes**, and a generated `salt` decodes
  from base64 to **exactly 16 bytes**.
- Two credentials issued in succession produce different secrets and different salts.
- `hashSecret` calls `scrypt` with **`N=32768, r=8, p=1, dkLen=32` and `maxmem` = 64 MiB
  (67108864)** — assert on the arguments, not only on the output, since an output-only test passes
  with a `maxmem` that Node would have rejected on a different build.
- A `StoredSecret` produced by `hashSecret` verifies against a key derived independently with those
  same parameters, and fails against one derived with any of them altered.
- A generated credential id decodes from hex to **exactly 16 bytes** and contains no `_`, so the
  delimiter is unambiguous.
- `formatCredentialWire` output round-trips through `parseCredentialWire`, including when the secret
  contains `_` and `-`.
- A presented value without the `fs_` prefix does not resolve as an issued or paired credential.
- **Malformed input is rejected before `timingSafeEqual`, not by it.** A `StoredSecret` whose `salt`
  or `hash` is not valid base64, or whose `hash` decodes to a length other than `dkLen`, fails
  verification as a rejected record — it must not reach `timingSafeEqual`, which throws on mismatched
  buffer lengths rather than returning false. Assert that verification returns false and does not
  throw for each case.
- Verification compares derived keys with `timingSafeEqual` — assert that the comparison is reachable
  only after the explicit length validation above, since a timing assertion is not reliable in a
  test.
  **Raw secrets**

- Non-prefixed values always fail credential resolution without a store scan.
- Password presentation is refused before verification-cache lookup.
- Changing or removing obsolete environment auth variables does not mutate the store.

**Freshness**

- A repeated successful authentication with the same secret derives the KDF once — assert by counting
  `scrypt` invocations across two identical requests.
- **An established session is denied after a revocation written by another writer.** Authenticate a
  session, then rewrite the store file directly — as a second gateway or an offline operation would,
  without invoking this gateway's invalidation hook — and assert the session's next authorization
  decision is denied, with no re-authentication and no local write. This is the test that proves the
  cross-writer gap is closed: freshness must gate _authority resolution_, not merely verification, or
  an established session would never observe the change.
- The same for a role-binding change written externally: the next resolution reports the new bindings.
- The same for an externally written activation latch: solo resolution stops.
- Revocation takes effect even when the verification is cached and the cache is not cleared — warm the
  cache, tombstone the credential in the projection without invoking the hook, and assert denial, so
  denial demonstrably comes from the record lookup rather than from cache clearing.
- A failed verification leaves no cache entry.
- The cache holds no more than its cap under a flood of distinct values, and eviction causes a
  re-derivation rather than a wrong answer.
- An unchanged store performs no reload — assert the freshness check does not re-parse when the stamp
  is identical.

**Activation dual mint**

- **Issuing a first non-admin credential into an unactivated store yields a reachable admin.** After
  the call, `activatedAt` is set, the requested operator credential is active, _and_ an active admin
  credential exists over an owner principal — so the store is never activated with zero admins.
- The second secret is returned to the caller exactly once, as `adminGrant`, and is not recoverable
  from the store afterwards.
- Both credentials land in **one** write: an injected failure during the issuance leaves the store
  unactivated with neither credential, never activated with only the operator one.
- Issuing a first _admin_ credential mints exactly one credential — the dual mint triggers on the
  absence of an admin, not on first issuance generally.
- Issuing into an already-activated store that has an active admin mints exactly one credential.
- The writer path is the one that carries this: an offline first issuance creating a non-admin alone
  is still permitted, which is §3's deliberate carve-out and the one way row four survives.

**Last-admin invariant**

- Revoking the only active admin credential is refused, and the error names the credential and gives
  the issue-first `Next:` line.
- Revoking one of two active admin credentials succeeds.
- Removing the last `admin` role binding from the principal behind the only active admin credential is
  refused by the same writer rule, proving the invariant lives on the writer and not in a handler.
- Revoking an operator credential while no admin credential is active succeeds — the invariant counts
  admin credentials, not credentials.
- An active credential whose principal is missing does not count toward the admin total.
- **The invariant is evaluated against freshly read state**: with a stale projection showing two admin
  credentials and the file showing one, the revocation is refused.

**Live lookup and session closing**

- A session authenticates, its credential is revoked through this gateway, and the session is closed.
- Revoking a credential closes the sessions holding it and leaves sessions on other credentials open.
- Latching activation through this gateway closes every open session, including solo sessions.
- **A role-binding change closes every session whose principal's bindings changed**, and leaves
  sessions belonging to other principals open. This covers both granting and revoking a binding — the
  invariant is about authority changing, not about it narrowing.
- **Closing a session on a role change tears down its subscriptions**, so no further event reaches
  that socket. Assert by subscribing, changing the principal's bindings, and confirming the
  subscription produces nothing more — this is the "including subscriptions" clause of §2 invariant 2
  being satisfied by the close arm.

**Cross-writer invalidation of push streams**

These are the obligations that prove lazy freshness is not the only mechanism. Each writes the store
file directly, as another gateway or an offline operation would, without invoking this gateway's
invalidation hook, and **the subscribed session makes no request at any point**.

- **An external role change closes an affected subscribed session.** Subscribe, rewrite the store so
  the session's principal holds different bindings, and assert the session is closed and its
  subscription stops delivering — without that session having issued a request. A request-driven
  check alone cannot pass this, which is the point.
- An external credential revocation closes the sessions holding that credential, and leaves sessions
  on other credentials subscribed.
- An external activation latch closes every session, including solo sessions that were never
  credentialed.
- An external write that changes nothing relevant — another principal's binding — leaves the
  subscribed session open and still delivering, so detection is not indiscriminate.
- **Invalidation happens within 2 seconds of the external write**, with no request occurring — assert
  against that literal bound, not against whatever the configured interval happens to be. Advance
  time rather than issuing a frame. Writing this as "within the poll interval" would make the test
  tautological: it would pass at any cadence, including one that leaves revoked authority subscribed
  for minutes. A change to the interval must therefore break this test, which is the point of
  pinning it.

**Explicit retirement**

- An active selected credential blocks retirement.
- Live gateways block offline retirement across the entire identity home.
- Retirement preserves the activation latch and at least one active admin.
- Bound nodes must be re-enrolled or retired before retiring their native owner.
- Ordinary creation cannot reuse retired principal ids. Retired credential ids
  can never be reused.
- Explicit principal-id reuse is admin-only online and requires all gateways
  stopped offline. It requires an exact retired id and refuses a live, reserved
  or never-retired id without changing the store.
- Pending pairing invitations capture the invited identity generation. Exchange
  compares it with the disk principal inside the credential issuance lock and
  refuses a stale invitation without writing the store. A fresh invitation works.
- The existing writer lock covers removing that principal tombstone, creating
  the replacement and appending `{ principalId, generation, reusedAt }` to
  `principalIdReuses`. The loader validates every history entry, including its
  ISO-8601 UTC timestamp. History survives later retirement and reuse.
- Reuse increments a positive safe-integer generation per principal id. History
  generations are sequential; a live replacement's generation must match its
  latest history entry. This avoids timestamp collisions between replacements.
- Stored principal references without a generation refer to the original
  identity, generation zero. `PrincipalResolver.resolvePrincipalId(id, generation)`
  fails closed on a mismatch. Credential authentication resolves the principal
  through its fresh credential id and does not borrow authority from history.
- The shared WorkOriginator helper stamps authenticated queued, backlog and
  work-graph effects with the principal generation. Fire-time resolution checks
  it. Missing or stale generations cannot adopt replacement authority. Existing
  id-only automation owner records remain unproven for a replacement and must
  be re-authored under the automation service. No loader upgrades their author.
- Generation-bound stored owners (ADR-051 Amendment 5) cover the following. Each
  fresh record carries a server-derived `ownerGeneration`, omitted for zero and
  otherwise a positive safe integer. A missing value means zero. Request
  parameters that supply it are refused, and `config` objects never carry it.
  - PR monitors, project monitor policies and monitor publication enrollments.
  - Teams, trigger rules, rule actions, review submissions and contributions.
  - The PR work review owner.
  - Push devices and acknowledgements, as gateway-internal store fields.
  - Assessment records.
- Store schemas accept the new fields, and older files load unchanged. Reads,
  edits, acknowledgements, idempotency keys and loader uniqueness keys include the
  generation. A replacement saving the same project, idempotency key or
  subscription produces a store that reloads.
- Old records are inert for a replacement and absent from its owner-scoped views
  and assessment reports. No loader re-authors them.
- Each fire-time authority check resolves the stored owner with
  `resolvePrincipalId(ownerId, ownerGeneration ?? 0)`.
- PR monitoring repair and rule dispatch enqueue originators that carry the
  stored owner's generation. Background scans, enrollment, action delivery and
  queue admission re-check current authority before acting. An unrelated waking
  request cannot donate authority.
- The queue loader validates each stored originator with the shared WorkOriginator
  check. An invalid row refuses only itself: it stays `queued` and carries the
  reason in `waitingReason`, with no new queue status.
- Rule dispatch matches owner id and generation in its prior-review domain lookup
  and in its requeue check.
- `PRTeamProfile.notificationPrincipalGenerations` binds the current generation
  of each recipient id newly added to `config.notificationPrincipalIds` at save.
  - Recipients already on the team keep their stored generation.
  - Removing a recipient drops its entry, so re-adding it in a later save binds
    the current generation. One save that removes and re-adds it changes nothing.
  - An id that does not resolve at save is refused.
  - Owner-scoped events and notification reads check the recipient session's
    generation as well as its id.
- Push registration may disable the same token's binding for an older generation
  of that principal id, inside the authorized registration transaction, before
  creating a new device. Old deliveries stay with the old device. Token conflicts
  across principals remain refused.
- Run creation records `createdByPrincipalGeneration` from the authenticated
  originator, except on a delegated static review, whose creator is the native
  owner at generation zero. System-originated child runs inherit it from their
  parent.
- Direct and gated review publication, automatic QA intake, source-review
  validation and reviewer continuity all match owner id and generation.
- `generation_mismatch` has its own denial text. It names the replaced identity
  and the action that re-creates the record, and never reads as a revocation.
- A contribution whose owner fails with `generation_mismatch` is withdrawn before
  shared-review admission. Any other loss of authority refuses admission and keeps
  the contribution held. Restoring that authority admits it without re-authoring.
- Webhook principals, `delegatedReviewerPrincipalIds` and visual-review
  delegators without a pin resolve at generation zero. A replacement is never
  credited or empowered through them, and the denial names the mismatch.
  Source-pin actors remain display-only.
- A delegator resolves at `visual_claim_review.delegatorPrincipalGeneration`
  when the policy sets it (A5 clarification, 2026-10-17). The parser accepts
  only a positive safe integer next to `delegatorPrincipalId`.
- Native execution ownership remains id-only and matches only a generation-zero
  principal. `requireNativeProfileOwner`, `resolveNativeWorkerOwner`,
  `resolveReviewWorkspaceOwner`, `ownsLocalNativeProfile`, node bindings and
  native-session owners refuse any principal whose generation is not zero.
- Static review runs, whether direct or admitted from a rule or submission, run
  under native execution ownership. So does review publication.
- Delegated review authorship applies when `run.create`, `dispatch.preview` or
  `dispatch.queue.add` receives a static `review-pr` request without `prWork` from
  an authenticated admin person whose own owner resolution refuses, at any
  generation. A caller that owns a native profile or node keeps its own ownership.
  - The owner resolves to `FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID` at generation
    zero, through the admin-supervisor branch of `resolveReviewWorkspaceOwner`.
    Workspace placement is inspected against that owner, as for its own requests.
    The generation-zero native checks apply to that resolved owner, never to the
    supervising caller.
  - The run stores that owner, at generation zero, in `createdByPrincipalId`,
    `nativeOwnerPrincipalId` and, where present, the PR work review owner. It
    stores the session's id and generation in `requestedByPrincipalId` and
    `requestedByPrincipalGeneration`, omitting zero. Request parameters that
    supply requester or delegated-owner fields are refused.
  - Direct publication captured at creation publishes as that owner, through the
    owner's PR teams and GitHub account. Approval and gated posting use the
    existing admin supervision of the owner's runs. `prReview.publish` accepts the
    publication owner, or an admin person when that owner is the configured
    native profile owner. It publishes as the recorded owner and re-checks that
    owner's authority as today. The requester fields grant nothing.
  - Delegation is decided only on a live admin request. A queued delegated
    request stores the owner in the gateway-derived
    `QueueItem.delegatedOwnerPrincipalId` and the requester as its originator.
    When it fires, queue admission re-checks that the requester is still an admin
    at that generation, and the native-owner checks for native items and
    workspace placement use the stored owner. A failure refuses only that row,
    which stays `queued` with `waitingReason`. Rows that carry `prWork` never
    delegate.
  - Delegated runs share the owner's creator id, so they count as the owner's
    prior reviews and continuity sources.
  - Without a configured native profile owner, delegation is refused with the
    native-ownership denial.
- Otherwise static review and review publication are refused for a replacement,
  with a native-ownership denial. That includes static review admitted from its
  rules or submissions, which never delegate.
  - Such an intent moves to `needs-configuration` and carries that reason in
    `waitingReason`.
  - The replacement's rules and submissions still drive notifications, monitoring
    and runtime-slot QA on tmux or default transport. A QA profile that selects
    native transport is refused by the native-ownership rule.
- Regressions:
  - For each generation-bound store: a generation-zero record still works for its
    original identity. After reuse it is refused or absent. The replacement's
    fresh record works. For review submissions and contributions, "works" means
    store admission plus runtime-slot QA dispatch on a non-native transport. A
    background effect for the old record never acts as the replacement.
  - For a replacement, these are refused with their named reasons: native
    ownership, direct static review by a non-admin, static review admitted from a
    rule or submission, review publication as its own owner, webhook principals,
    unpinned delegators and delegated reviewers.
  - Delegated authorship:
    - An admin replacement's direct static review is created under the native
      owner with its requester recorded, runs, and publishes as that owner.
    - The generation-one requester approves the gate and the run publishes. After
      a transient failure, its manual `prReview.publish` retry publishes as the
      owner.
    - A queued native delegated request dispatches under the native owner.
    - A non-admin person is refused, and an admin that owns a node keeps its own
      ownership.
    - Client-supplied requester or delegated-owner fields are refused.
    - A queued delegated request whose requester lost admin, or was replaced
      again, refuses only its own row.
  - Team re-save: kept recipients keep their stored generation, newly added ids
    bind the current generation, and unresolved ids are refused.
  - Push: the older-generation binding for the same token is disabled, and
    conflicts across principals stay refused.
  - Contributions: withdrawn on mismatch, held on role loss, admitted after the
    role is restored.
  - Client-supplied generation fields are refused.
  - Delegator pin: a bare delegator id credits only generation zero; a pin
    credits only the matching current generation and refuses a stale or future
    one; the parser refuses a pin without a delegator id or below 1.
  - Each store reloads after both generations of one id have saved records.
  - One live gateway-RPC proof runs on an isolated identity home.
- Reuse preserves every credential tombstone, unrelated principal tombstones,
  activation and surviving credentials. It never issues a credential. Old
  credential wires and session references remain invalid after replacement.
- A removed principal stays unresolved in historical work; no implicit re-authoring occurs.
- Invalid surviving records reject the entire retirement transaction without a write.

**Solo mode and reserved ids**

- Never latched, loopback bind, no proxy trust: a session with no credential resolves to `local-admin`,
  and a session presenting `clientKind: 'node'` resolves to `local-node`.
- Once `activatedAt` is set, neither virtual principal resolves, and an uncredentialed session does not
  authenticate — revoking every credential does not restore solo mode.
- The writer refuses to create a stored principal whose id is any member of `VIRTUAL_PRINCIPAL_IDS`,
  including `system`, which this node never constructs.
- **The writer refuses a `node` subject carrying any role binding**, rather than storing it or
  silently dropping the roles — the mirror of the loader's fail-closed rejection, so the rule holds
  on both the way in and the way out.
- A `node` subject with `roles: []` is accepted, and the virtual `local-node` satisfies the same rule
  without a special case.

## Cutover

Verify automation, node agents, remote transfer and each person's login before revoking old
credentials. Remove obsolete environment auth variables only after those checks pass. Re-enroll
nodes whose immutable native-owner binding refers to a principal being retired; do not overwrite
the binding. Stop every gateway in the identity home and retire revoked obsolete principals through
the supported offline command before starting the new runtime. Keep a verified active admin.

An existing store must use schema version 1. The loader migrates `env-migrated` metadata to
`issued` under the ordinary lock before validation. Other unknown origins are refused at runtime. A fresh store remains unwritten until explicit issuance or exposure activation.
Deployments sharing a home share its latch, principals, lock and presence directory.

CLI and script callers select explicit gateway profiles. Noninteractive `farmslot up` requires a
credentialed local profile; first interactive startup may create the owner and local profile offline.
The co-launched node uses its own machine-bound credential. Rollback does not recreate environment
identities or restore retired authority.

## Boundaries

What this node deliberately leaves to later work, and where the seam sits.

| Deferred to                     | Seam this node leaves                                                                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization (§5.1-5.3)        | `resolveSessionPrincipal` returns a `Principal` with real role bindings. No caller reads `roles` yet. The operator allowlist, default-deny, and the denial messages of §8 attach at `routeMethod()`.                                                                                              |
| Conformance gate (§5.4)         | Nothing here. The gate takes the registry plus the allowlist, neither of which this node touches.                                                                                                                                                                                                 |
| Node subject (§6)               | The `node` subject variant exists with `machine` required. The node frame guards in `server.ts:135-244` still key on `clientKind`, and `auth.connect` does not yet reject `clientKind: 'node'` from a non-node principal.                                                                         |
| Protocol surface (§7)           | `GatewayAuthConnectResult` gains no `principal` summary here, and `CredentialSummary`, the seven `principal.*`/`credential.*` methods, and `PairingCreateParams.authority` are not defined. The CLI plumbing in `gateway-auth.ts:13-17` and `commands/auth.ts:181-190` follows §7, not this node. |
| Pairing (§7)                    | `pairingExchange` still returns the runtime secret. Minting an `origin: 'paired'` credential needs `PairingAuthority`.                                                                                                                                                                            |
| Provenance (§5.5)               | The `system` virtual principal is **not** constructed here — it is returned only for gateway-scheduled work, which does not exist yet. Its id is reserved regardless. `WorkOriginator` belongs with each work item's own store, not with this one.                                                |
| Outbound filtering (§2.4)       | `broadcast` and `sendHello` are unchanged. Filtering them by the receiving session's principal needs the authorization check first. This is the _downgrade_ refinement of §2 invariant 2 only — invalidation on role change is satisfied here by closing, not deferred.                           |
| Activation triggers (§3)        | This node latches `activatedAt` on first credential issuance. Latching on a non-loopback bind and on declared proxy trust is activation semantics beyond what the store needs, and lands with the work that owns the bind path.                                                                   |
| Offline store operations (§3)   | The store module, both coordination mechanisms, and the writer are all usable offline, and the presence marker is what makes offline operations refuse while any gateway in the domain runs. No CLI command calls them yet.                                                                       |
| Node credential re-resolve (§6) | `services/node/src/index.ts:62` still resolves once at module load.                                                                                                                                                                                                                               |
| `farmslot doctor` (§3)          | Reporting which of §3's four states the gateway is in. This node emits the reconciliation boot report only.                                                                                                                                                                                       |

## Divergences, rulings, and open questions

**No _implementation_ question is open in this spec, and nothing here is assumed** — but the design is
not settled end to end, and the two levels must not be confused.

Every divergence raised against earlier revisions of ADR-051 was resolved in the ADR, and every
implementation choice the ADR does not pin has since been **ruled** by the owner and is recorded
below. That is the whole of what this spec claims.

**ADR-051 retains four open questions that belong to the gateway's owner rather than to
implementation**, and they remain outstanding. See its `## Open questions` section; they are
deliberately neither restated nor summarised here, because a paraphrase of a decision document drifts
the moment the original is edited — which is the failure this process exists to prevent. **An
implementer should read this spec as complete for its scope and should not read it as evidence that
the design above it is decided.**

The heading is kept and the three states below are kept distinct, so a reader can tell "considered
and resolved" from "ruled" from "never considered".

### Resolved divergences

Two consequences recorded against earlier revisions are closed rather than outstanding. The
**gateway-exclusivity** consequence is gone: two coordination mechanisms replace one, a running
gateway holds no write lock, and concurrent gateways coexist. The **shared-activation** consequence
is resolved as documented behaviour rather than a defect — the scope was never the machine, it is one
identity domain per `FARMSLOT_HOME`, and deployments sharing a home share principals and activation
by construction. It is described where activation is covered, with the existing remedy named: a
deployment needing its own solo-mode lifecycle sets its own `FARMSLOT_HOME`.

### Ruled choices

These are **decisions, not proposals**. The ADR does not pin them; the owner has, and an implementer
may not substitute an alternative without a further ruling.

- **Timestamps are ISO-8601 UTC.** `createdAt`, `revokedAt`, and `activatedAt` alike. Not local time
  and not an offset — a store is read by whichever deployment in the domain opens it next, and a
  local-time stamp would make rotation age wrong rather than merely inconsistent.
- **Credential ids are 128-bit random, hex-encoded** — `randomBytes(16).toString('hex')`, consistent
  with §2's hex-id rule and its reason: the base64url secret alphabet contains the `_` delimiter.
- **The freshness stamp is exactly `{ dev, ino, mtimeMs, size }`** from a `statSync` of the store
  path, with an absent-versus-present transition also counting as a change. All four fields are
  required: `mtimeMs` alone misses a same-millisecond rewrite, and `dev`/`ino` are what catch a
  replacement by rename — which is precisely how every write in this node lands. **An implementer
  must not substitute a weaker check**, such as mtime only or a content hash sampled on an interval.
- **The freshness poll interval is 2 seconds, and it is a security parameter, not a default.** It
  bounds how long a revoked credential's or demoted principal's subscription may keep receiving push
  events. Changing it changes the invalidation guarantee, so it is a change to the security contract;
  the obligation asserts the literal bound so that a change breaks a test rather than passing
  silently.
- **The verification cache is keyed by the SHA-256 digest of the presented secret**, stores only a
  credential id, and is bounded with eviction. **The bound — 256 entries, least-recently-used — is a
  documented default, not a security property**; tuning it changes only how often the KDF re-runs.
  **The security properties are that the cache is cleared on every store write, that it is consulted
  only after `ensureFresh()`, and that it never caches authority** — no principal, no roles, no
  record. Those three may not be traded away for any cache policy.

### Fills that follow from the rulings

Recorded so they are confirmed rather than discovered, and because each is a place a reasonable
implementer could otherwise choose differently:

- **The presence marker is a directory of per-gateway entries**, `gateways.live` beside the store and
  therefore per identity domain, each recording pid, root, and port. Node's standard library has no
  advisory file locking, so shared mode is represented by presence rather than by a shared lock, and
  the per-entry fields are what let §3's refusal name each running gateway.
- **Presence registration and the offline presence check both hold `credentials.lock`.** Without
  that, a gateway starting between an offline operation's check and its write would defeat the check.
  Both paths keep the lock short-lived, and the interleaving has its own test obligation.
- **`credentials.lock` is the lock file's name**, ADR-aligned rather than proposed.
