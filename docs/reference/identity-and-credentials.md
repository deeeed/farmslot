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
or run `credential issue --write-node-env` from the node checkout. Supply it through `FARMSLOT_NODE_TOKEN`. Node requests and remote
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

After rotation, each node and `farm-automation` has one active credential. Tests
use credentials issued into an isolated test home, never a person's profile.

## Recover admin access

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
