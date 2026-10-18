# Identity and credentials

| Who             | Kind    | Credential                                | Used for                                                       |
| --------------- | ------- | ----------------------------------------- | -------------------------------------------------------------- |
| A person        | person  | One per device, through login or pairing  | Command Center, Companion, CLI, attestations and publish gates |
| Farm automation | service | One, named `farm-automation`              | Tooling, scheduled jobs, dispatch, merges and deploys          |
| Each machine    | node    | Exactly one active credential per machine | Node agent and gateway-to-node transfer                        |

Only people can attest to publish gates and visual judgments; services run automation. Node credentials work only on the node surface, including node agents and gateway-to-node transfer.

A principal is an identity; its credentials authenticate individual devices or callers.
Roles belong to the principal. Revoking one credential leaves its other devices connected.

## Log in

An admin pairs a device to an existing person principal:

```bash
farmslot pair --principal <person-id>
```

In Companion, open Settings, choose Pair from QR and scan the code. Each device
redeems its own code. For the CLI, add the gateway profile and redeem a fresh code:

```bash
farmslot gateway add personal <ws-url>
farmslot login personal --code <pairing-code>
farmslot --gateway personal auth status personal
```

The authenticated identity must report `subjectKind: person` before human
attestations. Keep automation in a separate CLI home and profile so a scheduled
job cannot use a person's credential.
Set each machine pool's `env.FARMSLOT_HOME` to its service profile home; worker
launches and deployment verification use that existing override. The service
profile must match the exact node gateway URL, including its host and path.

## Issue, rotate and revoke

People use pairing for each device. An admin issues a service or node credential
to a private file rather than printing it:

```bash
farmslot credential issue --principal farm-automation --subject service \
  --role admin --scope global --name farm-automation --secret-file <private-file>
farmslot credential issue --principal <node-id> --subject node \
  --machine <machine> --name <machine> --secret-file <private-node-file>
```

Install the private node file with `deploy-node.sh --node-token-file <private-node-file>`,
or use the private machine secret for a co-launched development node, as described
in [Worktree operator model](../operations/worktree-operator-model.md). Node requests and remote
file transfer use the authenticated node connection. An HTTP file download still
requires a person or service credential.

`farmslot up` uses the node's installed environment credential before its private
`FARMSLOT_HOME/node.secret` startup cache. A verified replacement refreshes that
cache so the next startup can reuse it without an inherited environment value.

To rotate, issue to the existing principal without `--subject`, install the
replacement in its caller, verify the caller's
identity and operations, then revoke the old credential. For a person, pair that
device again instead of issuing its secret through automation.

```bash
farmslot credential issue --principal <existing-id> --name <device-or-caller> \
  --secret-file <private-file>
farmslot credential list
farmslot credential revoke <old-credential-id>
```

After rotation, each node and `farm-automation` has one active credential.
Revoked records on surviving principals remain as audit history, with their ids
reserved. They cannot authenticate. An audit should flag active credentials
outside the allowed principals, not retained revoked records.

Back up private auth files before removing obsolete copies. Keep the active
person device login, separate automation CLI profiles and the gateway's
hash-only store. A local node reads its credential from the gitignored startup
file, `.env` fallback or private cache; a remote node reads its installed service declaration.
Never embed person or service secrets in tracked samples, build environments or
node startup declarations.

Tests use credentials issued into an isolated test home, never a person's profile.

## Recover admin access

An authenticated person with `admin/global` may view and operate every run and review
workspace, including gates and pinned worker sessions created by automation. The run's
native execution owner, node assignment, session generation and lease stay unchanged;
the gateway routes native operations using that recorded owner. Service, node and
non-admin person credentials do not gain cross-owner access through this rule.

Keep an active admin while changing credentials. If all admin credentials are
lost, stop every gateway sharing that `FARMSLOT_HOME`, then run the supported
offline credential command as the owner of that home:

```bash
farmslot principal grant farm-automation --offline --role admin --scope global
farmslot credential issue --offline --principal farm-automation \
  --name farm-automation --secret-file <private-file>
```

Install the replacement in the automation profile, restart the gateway and
verify its admin identity. The person then pairs their devices again. Offline
writes refuse while any gateway in that identity home is running.

If `farm-automation` does not exist, create it first with
`farmslot principal create --offline --type service --name farm-automation --role admin`.

See [ADR-051](../adr/051-principal-and-credential-model.md) for the authorization
and store invariants.

On upgrade, the store loader converts historical `env-migrated` origin metadata
to `issued` once under the credential lock. Ids, secret hashes, roles and
revocations stay intact. Existing issued and paired device logins keep working;
raw environment-token logins must pair or select an issued profile. Keep old
credentials until replacement logins are verified, then revoke and retire them
through the commands above.

## Replace a retired identity at its exact id

Revoke the obsolete identity's credentials and retire it first. An admin may
then explicitly create its replacement at that retired id:

```bash
farmslot principal create --reuse-retired-id <retired-id> \
  --type person --name <person-name> --role admin
```

The replacement needs fresh credentials. Old work stays bound to its original
identity generation and cannot adopt replacement authority. Re-author automation
under its service identity; authenticated new queued work receives the current
generation. Old credential ids remain reserved,
old secrets cannot authenticate, and the store records the reuse. Ordinary
creation never reuses a retired id. Offline replacement requires all gateways
sharing the identity home to be stopped.

Before reuse, upgrade every gateway sharing the identity home to the
generation-aware version. A pending pairing invitation from the retired identity
is invalid; create a new invitation for the replacement.

Once a gateway that implements ADR-051 Amendment 5 is rolled out:

- A replacement's fresh PR notifications, watches, teams and rules work. That
  includes runtime QA admitted by its rules or submissions.
- Records the old identity created stay bound to it. They are absent from the
  replacement's views, and actions on them are refused with a message naming the
  replaced identity. The replacement re-creates the configuration it wants.
- Static reviews and review publication run under native execution ownership,
  whether the review is direct or admitted from a rule or submission. Native
  execution ownership never moves to a replacement identity, so keep native
  profiles owned by the automation service and re-point native owner
  configuration before reuse.
- An admin replacement can still start a static review directly, from Command
  Center or the CLI, and publish it. The review runs and publishes as the
  configured native profile owner, normally the automation service, and the run
  records the person as its requester. Publication uses that owner's PR teams and
  GitHub account, so the automation service needs a team that maps the
  repository, and `--review-team` must name one of its teams. A replacement that
  is not an admin cannot do this. A replacement's rules and submissions never
  start a static review, so an admin starts it directly.
- Webhook principals and visual-review delegations in project configuration keep
  naming the original identity. For a source-bound or pack-copied project, the
  delegation is in `$FARMSLOT_HOME/sources/runtime-settings/<project>.json`.
  Re-point them to another service or person. A visual-review delegation can
  instead name the replacement by adding
  `delegatorPrincipalGeneration` with its current generation to
  `visual_claim_review`.
- A team that already lists a reused recipient keeps notifying the old identity.
  To notify the replacement, remove that recipient and save the team, then add
  them back in a second save.

Until that version is deployed, a reused identity cannot use PR features.

## Person-device session contract

[ADR-051 Amendment 4](../adr/051-principal-and-credential-model.md#amendment-4-expiring-person-device-sessions-2026-10-15)
specifies one-hour access and a sliding 30-day refresh lifetime for person logins.
After its coordinated implementation, all three clients retain only a refresh
token and device metadata. They show the device and sign-in expiry, confirm
sign-out and revoke that device at the gateway. Command Center settings list
signed-in devices with per-device revoke. Service profiles and node credentials
keep their existing behavior.

The amendment is accepted; client cutover requires the implementation and
rollout checks below. The
[principal core spec](../plans/principal-core-implementation-spec.md#person-device-sessions)
owns expiry, persistence, revocation and cutover requirements.
