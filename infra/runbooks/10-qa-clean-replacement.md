# Sweden QA clean replacement preparation and execution gates

This is the design and locally implemented preparation following
[PD-3 remediation](09-qa-integrity.md), not an approved live apply package.
The owner authorized preparation after #181 merged
at `cc3b154`. No live containment, provisioning, credential processing, disk
operation or cutover is authorized by that preparation decision. The blockers
below must be satisfied and independently reviewed before requesting a bounded
live action. Do not run the existing selfhost apply command to perform this plan.

## Executed R1 evidence and limits

A separate explicit owner approval authorized the immutable R1 packet with
manifest SHA256 `16bc124b21af47b696b2f2404ff5368818c982d501e5be85f5d9dce6499c54f1`
and saved-plan binding
`e44d40ebfd3f642a2f2c8384ad9caa80643368c6be977e1be2ec9e9d527c8f61`.
On 2026-10-15 at 20:37–20:39 UTC, that packet performed one existing NSG update,
stopped the ten bound Supabase containers with explicit SIGTERM and no automatic
SIGKILL, and deallocated the retained old VM. The stop command completed and
each container reported `exited` before deallocation was requested.

ARM readback matched the approved rules: operator /32 SSH preserved, application
Postgres/public HTTPS allows removed, other inbound denied and outbound denied.
Final power state was `PowerState/deallocated`. The three disk identities and
attachments, NIC/subnet bindings, two public IPs, recovery vault protection and
three locks matched the preflight metadata. Existing state lineage and all fifteen
owned resource IDs were unchanged; serial advanced from 10 to 11. Nine fresh
TCP connection attempts (two retained IPs plus the current hostname, each on
22/443/5432) timed out. No resource was created/deleted, no credential value was
inspected or generated, and no historical Stage A/B, rotation or I1 evidence was changed.

There is no qualified private/VNet probe vantage yet. The R1 external probes ran
from the operator `/32` vantage. Port-22 timeouts therefore support deallocation,
not denial by the NSG rule that explicitly permits that operator. These external
timeouts are reachability evidence, not credential-rejection evidence. A stopped
container is not proof of clean database shutdown or database integrity. Keep
PD-3 OPEN and LP2-01/02/03 INTEGRATED. Old QA remains unavailable until separately
approved replacement bootstrap and acceptance. R2–R4, measured recovery and full
trust acceptance remain open; do not treat this R1 evidence as new authorization.
The approved packet and execution records remain private; their B9 handoff
records the paths, checks, independent reviews and proposed ledger update.

## Selected design and alternatives

Use the existing selfhost Terraform root and its existing backend key, adding
one explicit replacement generation, `r02`. Preserve the old resource addresses,
disks and recovery custody. Keep the existing VNet writer and apps subnet;
isolate the new host in a separate subnet. Start the new QA database/object store
empty, while retaining the old environment for an owner-approved preservation
period. This is a proposal to retain data, not a declaration that no data exists
or that old disks may be erased.

Reusing the old VM/disks would not establish a clean baseline. Rebuilding in a
separate VNet would require another application subnet contract and routing
design without improving the initial preservation requirement. Neither is the
selected route. No other Azure region or production provisioning is included.

## Read-only evidence and its limits

Fresh ARM and Blob-list observations on 2026-10-15 confirmed:

- CLI tenant/subscription, deployment contract and cached backend binding match.
  The existing `foundation/staging-selfhost.tfstate` blob is listed; the
  application container is empty. No state content was pulled, no backend was
  initialized, and no state ownership beyond this metadata check is claimed.
- Listed regional resources are in Sweden Central. There is one data VM, three
  managed disks, two public IPs, a VNet/NSG/NIC, recovery vault and backend storage.
  No managed Container Apps environment or application deployment is listed.
- The reserved apps subnet has `Microsoft.App/environments` delegation and no
  IP configurations or service-association links. Its CIDR remains defined by
  `local.apps_net`; its exact ID stays in the private contract.
- The VNet has no peerings or custom DNS servers; the two subnets have no route
  table, NAT gateway or private endpoints. The existing SSH allowance is `/32`.
  Three `CanNotDelete` locks were returned. Disk export is denied.
  The managed data/object/OS disks are 64/32/30 GiB; all three were attached.
- `Standard_D2as_v7` is listed for Sweden Central with no subscription restriction,
  2 vCPUs, 8 GiB RAM and encryption-at-host capability. Quota usage was 2/350
  family vCPUs and 2/65 total regional vCPUs. This is not an allocation guarantee.
- The existing VM's hardware profile is D2as v7; both retained public IPs are
  Standard/Regional/Static. These readbacks support the cost assumptions below.
  The pinned Canonical image version `24.04.202609040` is still readable in
  Sweden Central as x64/Hyper-V V2; no VM allocation was attempted.

No SSH, SQL, secret read, live source replacement or application smoke ran for
this design. Historical Stage A/B, dashboard rotation and format-1 I1 evidence
remain unchanged. PD-3 stays OPEN. Recheck all time-sensitive bindings before
planning; do not reuse these observations as an apply-time assertion.

## Exact ownership and resource proposal

The backend remains the current account/container/key from the private backend
contract. Do not bootstrap storage, select another workspace/key, import an
existing resource, migrate state, or run `init -reconfigure`. Before a saved plan,
an operator-controlled projection must bind state lineage, serial, resource
addresses/IDs and the current contract, without returning credential-bearing
attributes or a full state dump. Cached metadata alone is insufficient.

| Object | Proposed ownership/change |
| --- | --- |
| Existing group, host, disks, NIC, both public IPs, recovery vault and locks | Keep existing Terraform addresses and retention protections. No replace/delete/import. Old NSG containment is a separately approved update. |
| Existing VNet | Existing `azapi_resource.network` remains its sole writer. Append the replacement subnet while preserving all current subnet objects and VNet settings. Reject unrelated drift. |
| Reserved apps subnet | Same ID, CIDR and delegation; no replacement or occupation in this package. A future Container Apps environment must bind this ID in its first request. |
| New VM | Proposed name `tonyai-staging-data-r02`, D2as v7, exact verified Ubuntu 24.04 image version, Trusted Launch and host encryption. New system-assigned identity; no recovery-secret read grant. |
| New disks | Proposed `tonyai-staging-data-r02-os`, `-database` (64 GiB), `-objects` (32 GiB); Standard SSD LRS. Empty data disks, export denied, retain on detach; prevent destruction. Never attach an old disk/snapshot. OS size must be fixed in the saved plan. |
| New network objects | `tonyai-staging-data-r02-nic`, `-nsg`, `-edge-ip` and subnet `supabase-r02`, `10.80.1.0/24`, static `10.80.1.4`. Fresh ownership/collision checks are still required. Standard regional IPv4, NoReuse Azure DNS label. |
| New recovery custody | Separate generation vault, globally unique name bound privately, Sweden Central, RBAC, purge protection, `/32` firewall and explicit owner-only grant. Separate exact secret versions and generation/VM/source binding. Preserve the old vault unchanged. |
| New locks | Retain new data and hostname through existing group protection and explicit new IP protection; document effective scope in the plan. No removal of old locks. |

Resolve the proposed names to full IDs privately and prove they are absent from
Azure and every relevant state before creation. Absence in one resource listing
does not establish Terraform ownership. Refuse collisions rather than adopt.
The NoReuse hostname is read back after provisioning; no guessed FQDN becomes an
Auth issuer, certificate target, redirect or SSH trust entry.

VMs, disks, VNets, NSGs, NICs, regional public IPs, vaults and backend storage are
regional Sweden Central resources. Resource-group location stores metadata;
it does not place its children. RBAC assignments, locks, tenant/subscription
identity and GitHub are not regional workloads. A globally unique vault name
or public DNS label does not make the backing resource a global deployment.
This package creates no DNS zone or Namecheap record.

## Preservation, containment and maintenance

Recommended owner choice: preserve all old OS/database/object disks and old
escrow, with no bulk data import into the clean baseline. Set a review date and
named custodian privately; expiration of that date must not trigger deletion.
If data must be carried forward, stop before migration and obtain a separately
reviewed allowlist export/import, object-byte and encryption-key preservation
plan. I1/I1b counts cannot authorize destruction. No new I1b is required merely
to retain everything.

Containment must cover both old public IPs/hostnames, REST, Storage, dashboard,
private DB paths, lateral VNet access, egress and old recovery/identity trust.
Keep the operator `/32` SSH exception during the evidence-access window. On the
old NSG, permit only that bounded exception, deny other inbound and deny outbound
before Azure's default VNet/Internet allowances. The private package must name
every rule, priority, destination and preserved exception; it must not broaden
operator access or silently change the apps subnet.

An NSG edit alone does not terminate established flows
([Azure NSG behavior](https://learn.microsoft.com/en-us/azure/virtual-network/network-security-groups-overview)).
Therefore record acceptance only after approved service shutdown and VM
deallocation, with ARM power-state and external fresh-connection checks. The
shutdown/deallocation and network changes require explicit approval together.
No run-command extension or host-key bypass is a fallback for SSH failure.
Once deallocated, SSH is unavailable; disk access or temporary forensic startup
requires a separate isolated plan. Do not boot the old host with open egress.

The new subnet must deny old/new lateral traffic in both directions despite
default VNet allowances. Initially permit management only from the operator
`/32`; no public HTTPS or application DB access. Bind necessary DNS/platform
exceptions and a time-bounded bootstrap egress policy to the reviewed manifest.
Mail/webhook suppression and the final ACME renewal/egress path must be tested
before activation; an unrestricted outbound rule is not a completed policy.

Maintenance starts when containment/shutdown begins and ends after the new
endpoint passes acceptance. Budget a proposed four-hour operator window, with
a stop checkpoint after two hours if bootstrap cannot complete safely. These
are scheduling proposals, not observed RTO or a promised maximum outage. If a
gate fails, QA remains unavailable; do not reopen the old trust domain.

## Trusted bootstrap and credential acceptance

The bootstrap manifest must bind reviewed commit/patch hashes, every transferred
file, pinned upstream template and SQL, image digests, OS image, Node archive,
Docker/runtime configuration and guard ordering. Strict host-key trust for the
new VM must be established through an independently authenticated channel before
SSH transfer; never accept a keyscan result as verification by itself.

The local implementation addresses the four design prerequisites:

1. `replacement_host.py` checks exact IMDS VM UUID/resource/OS/data IDs, both
   approved filesystem UUIDs, whole-disk mounts and empty disk contents before
   initialization. Every database, DB-config, object and Caddy path is covered
   by the empty whole-disk test. Existing/interrupted journals, symlinks and
   unreviewed source files/directories fail closed. Disk formatting remains an
   explicit separate action, using `selfhost_disks.py --replacement-contract`.
2. `credential-template.json` classifies the complete pinned upstream template;
   `selfhost_init.mjs` refuses changed hashes, extra/duplicate assignments and
   unknown fields. It writes only explicit settings, generates independent
   credentials, disables unused provider credentials, and exclusively creates
   a journal and root-only environment. It now requires an r02 host contract;
   the old bootstrap initializer is not a legacy recovery route.
3. Upstream Realtime **v2.134.10** consumes raw key bytes. Its
   [runtime configuration](https://github.com/supabase/realtime/blob/v2.134.10/config/runtime.exs)
   and [crypto implementation](https://github.com/supabase/realtime/blob/v2.134.10/lib/realtime/crypto.ex)
   support GCM writes with 32 raw bytes. The r02 overlay enables GCM with
   `base64(randomBytes(24))`: 32 ASCII bytes, **192 bits of entropy**. The
   legacy-compatible ECB input is `base64(randomBytes(12))`: 16 ASCII bytes,
   **96 bits of entropy**. Neither is described as decoded base64 or as 256/128
   bits of entropy. The pinned image digest's correspondence to v2.134.10 and
   the live consumer round-trip qualification both remain unverified.
4. New `replacement_escrow.py`/custody helpers use format-2 envelopes bound to
   generation, VM UUID/ID, vault, source manifest and disks. Environment custody
   must pass before the first database start; intrinsic custody adds the actual
   database-generated pgsodium key before the remaining runtime starts. Exact
   immutable versions are required. Intrinsic export/mark/verify, runtime start
   and same-host restore also verify the original environment marker against
   the current/restored environment bytes. Changing `.env` between custody stages
   cannot be legitimized by creating a new intrinsic marker. The old validator is unchanged, and legacy
   startup/restore refuses an r02 contract. There is no old/latest fallback.

All r02 containers use `restart: "no"`; the approved daemon policy has
`live-restore: false`. A reboot must not bypass custody checks. Start only through
`replacement_start.py database-first-start` and then `runtime-start`. Config
validation includes all profiles; execution leaves `unused`/HTTPS profiles off.
Each start checks source hashes, mounted disks, runtime firewall guard, exact
initialization provenance, custody, immutable amd64 images and GCM format.

The exact source set is the union in `replacement_host.validate_contract` and
`replacement-source-layout.json`: upstream Compose/template/SQL/functions and
configuration, all executed/imported helpers, overlays, image/upstream locks,
Node binary, Docker package manifest/daemon/systemd/SSH configuration and runtime
guard. The contract's `source_sha256` is SHA256 of canonical JSON for `files`
(sorted keys, compact separators); each value is the transferred file's SHA256.
The R3 package must also bind the public Node archive and reviewed package
versions before installation. A null value in the layout means a hash supplied
by that reviewed manifest, not an unchecked file. No arbitrary directory extras
are accepted; the sole generated gateway file must match its deterministic
redacted template.

R3 sequence: authenticate new SSH host key; approve exact transfer/install and
temporary egress; install the hash-bound source/runtime artifacts; format/mount
only the two verified new disks; establish root ownership, the r02 daemon policy
and finalized host contract; initialize the empty baseline; verify environment
escrow; seed DB configuration from the pinned image; start only DB; verify
intrinsic escrow; then start the isolated remaining runtime. Do not run the
legacy Docker installer unchanged: it resolves package candidates at execution
and writes `live-restore: true`. A reviewed exact-package installation transcript
and the r02 daemon configuration are required in R3. No production, application,
SMTP, public HTTPS or DB ingress is activated by these helpers.

`replacement_escrow.py restore --stage intrinsic` is limited to lost environment
bytes on the **same** bound VM/source/disks with the retained matching pgsodium
key. It refuses running containers, existing credentials and mismatching custody
records; an identical retained record stays unchanged. It is not DB recovery,
an OS replacement/rebind or evidence of measured DB plus file-byte RPO/RTO.

Cover dashboard, all DB login passwords, HS256/oct and derived anon/service-role
tokens, ES256 keys/kids, Auth sessions/refresh tokens, storage/S3, pg-meta,
Realtime, vault encryption and every other template/runtime secret. Include
intrinsic database-generated material such as pgsodium keys. Map each to its
generator, entropy/format, consumers, custody and old-trust rejection probe.
Assess reachable external-provider/control-plane credentials explicitly.
Empty SMTP configuration is not evidence that external credentials never existed.

Secret-safe acceptance helpers must process values privately without returning
them to the agent, command arguments, logs or the repository. Prove new expected
credentials work and old credentials/trust fail for every active consumer.
Cover public and private paths, not dashboard alone. Old endpoint containment
must remain effective during and after these checks. A credential class that
is disabled needs evidence of no listener/consumer, not a fictitious login test.
Temporary Auth users or Storage writes need explicitly approved IDs and cleanup.
Keep PD-3 OPEN on incomplete coverage, acceptance of any old key, or uncertain
host provenance. Preserve old decryption material in forensic custody separately.

## Saved-plan and approval packages

The legacy `terraform_run.py selfhost plan/apply` path is closed and refuses
before invoking Terraform: config-only input could otherwise undo containment.
Its output action remains available. The separate `replacement_run.py` entrypoint
implements R1/R2 without calling init or reconfiguring the backend.

Bind the exact source/input hashes, pinned tools/provider lock, account,
backend, workspace, state lineage/serial, generation and private plan-file hash.
Reject ambient variables/overrides, unknown planned values at security boundaries,
resource imports, destructive actions and unrelated drift. Separate containment
updates from creation and later endpoint activation. Re-read the plan/state
binding before applying the saved binary; never silently replan or autoapprove.
Keep plans/projections private and redact IDs from public handoff evidence.

Starting with R2, the approved operation manifest must include the exact executor
source and its final SHA256, alongside every mutating argv, target and plan
binding. Freeze the executor before approval. Any later executor change requires
a new manifest hash and explicit owner approval, even if the intended argv are
unchanged. This prospective rule does not rewrite the historical R1 packet.

Preparation requires owner-only JSON files: the existing full backend inputs and
the original selfhost `config` unchanged, with `containment: true` and
`replacement: null` for R1. R2 uses the same config plus
`replacement: {generation: "r02", recovery_vault_name: <approved name>,
ssh_public_key: <independent public key>}`. No secret key belongs in these files.
The existing backend cache must already be bound to the default workspace and
`foundation/staging-selfhost.tfstate`. Missing cache/ownership or an unexpected
address is a stop condition, never an invitation to init, import or create state.

```sh
# Read-only cloud preparation; packet directory must not already exist.
python3 infra/scripts/replacement_run.py prepare --phase R1 \
  --backend "$BACKEND_INPUTS" --inputs "$R1_INPUTS" --packet "$R1_PACKET"
# Only after separate explicit approval of this exact binding hash:
python3 infra/scripts/replacement_run.py apply --phase R1 \
  --backend "$BACKEND_INPUTS" --inputs "$R1_INPUTS" --packet "$R1_PACKET" \
  --approved-sha256 "$APPROVED_BINDING_SHA256"
```

R1 permits exactly one existing NSG update: `owner-ssh` priority 100 inbound TCP
22 from the unchanged operator `/32` to `10.80.0.4`; `deny-other-inbound` priority
4000, any source/destination/protocol/port; and `deny-outbound` priority 4000,
any source/destination/protocol/port. All other existing resources must be no-op.
This Terraform phase does **not** stop services or deallocate the VM. The same
owner-approved R1 packet must separately name the strict-SSH service-stop
command, exact old VM ID for Azure deallocation, old endpoints and denial tests.

Prepare R2 only after R1 containment is applied and independently read back.
Use the same commands with R2 inputs/phase/packet. R2 permits ten new Terraform
instances (including the new OS export restriction) plus one exact VNet subnet
append. The exact JSON request policy is in `replacement-resource-policy.json`;
CI compares it against the backendless Terraform mock. Discovery checks each
proposed ARM ID plus vault/DNS availability; this is not a claim of ownership
across inaccessible states. The owner must attest the relevant state inventory.

Packets contain a private binary, full private plan projection, review summary
and binding. They expire after two hours. Source/input/tool/provider-lock/backend
hashes, account, workspace, lineage, serial and state bytes must still match.
An exclusive apply-attempt record prevents automatic retry after interruption.
Plan/apply wait up to 900 seconds, then send Terraform one SIGINT and wait for its
graceful completion without a second signal or SIGKILL. An operator interrupt
uses the same path. That wait has no forced deadline; do not kill the wrapper to
meet a maintenance estimate. Future executors must preserve this wait and must
not impose an outer hard-kill timeout on the writer. Failed/interrupted plan or apply stdout/stderr is
saved with exclusive mode-0600 files in the packet (`plan.stdout.log`,
`plan.stderr.log`, `apply.stdout.log`, `apply.stderr.log`), never printed. Those
logs can contain sensitive provider diagnostics; do not publish or bulk-read them.
Unsuccessful prepare packets are retained for private diagnosis and never reused.

### Pre-R2-apply gate: wrapper lifetime and diagnostic streams (N2)

This gate is OPEN and must be closed before R2 apply. The current writer uses
stdout/stderr pipes. If its wrapper dies after terminal closure or an outer kill,
Terraform can receive SIGPIPE on its next output, interrupting state persistence
or lock release despite its separate session. The existing SIGINT handling does
not close this failure path. Do not treat the PR review as permission to apply.

Before R2 apply, harden the writer to open both streams as exclusive mode-0600
packet files with `O_CREAT|O_EXCL|O_NOFOLLOW` before starting Terraform, instead
of pipes. Preserve failed/interrupted diagnostics, return required stdout on
success, and never print private output. Verify with a harmless real child that
parent death/closure cannot cause SIGPIPE through those streams, that successful
output is returned, and that existing logs cannot be overwritten. Review the
resulting delta and bind the final executor/source hashes in the approval packet.
Also run the R2 executor from a session that survives terminal closure; this
operational requirement does not substitute for the stream hardening. No outer
hard timeout or automatic retry is permitted.

### Partial R2 recovery boundary

An interrupted R2 can leave only some resources created or a state lock whose
status needs investigation. Nothing is retried automatically; retain the packet,
attempt marker, private diagnostics, existing state and all old/new resources.
No import, force-unlock, lock removal or cleanup is performed by this flow.
Recovery needs its own separately approved package: observed exact r02 resource
IDs and Terraform addresses, state/lock reconciliation, a reviewed import plan
where required, preservation and verification steps. A recovery exception does
not relax this runner's no-import/no-delete policy or authorize a blanket retry.
Do not infer ownership or import an unexpected same-name resource.

The old VM is deallocated. A future R2 prepare may report `resource_drift`;
the current policy must stop safely. Inspect that exact drift and review any
needed policy revision before preparing a new approvable packet; do not ignore it.

### Remaining bootstrap and probe gates

The initial r02 NSG denies all outbound traffic. Temporary-egress and exact-package
installation tooling are not implemented. R3 needs offline transfer or a separately
approved bounded egress/install package before any bootstrap execution.

`replacement_probe_owner.py` obtains the exact old forensic escrow version in
owner process memory and pipes it over verified SSH to the new helper. It prints
no values, tokens, remote response bodies or stderr. It saves only allowlisted
statuses bound to VM UUID/source, new contract hash and old immutable version.
Partial/failing reports are retained and return nonzero. Positive-new,
negative-old, positive-new controls distinguish credential rejection from
transport failures; redirects, generic policy 403s and 5xx are inconclusive.
S3 recognizes only explicit signature/access-key denial codes. DB probes use
transient pinned clients and read-only `SELECT 1`, but still require R4 approval.
The current owner helper accepts one old escrow version per invocation. The R4
package must enumerate and bind the applicable versions from both before and
after rotation, run the approved checks for each, and retain separate reports;
a single version cannot establish retirement of every historical credential.
Dashboard redirects, Storage 400 responses and Realtime 403 responses may keep
their rows INCONCLUSIVE. Do not weaken classification to make those rows pass.

The implemented probe subset covers dashboard, DB login roles, admin/service
HTTP endpoints, fresh HS256/ES256 key challenges and signed read-only S3 access.
It does **not** close the complete matrix in `replacement-acceptance.json`:
anon positive controls, session/refresh retirement, encryption consumer
round trips, disabled listener evidence, external credential retirement,
old/public endpoint containment and final live independent review remain open.
Do not turn an inconclusive row into PASS, create smoke users implicitly or
activate endpoints on the strength of the implemented subset.

| Approval package | Exact scope and verification | Failure action |
| --- | --- | --- |
| R0: evidence and preservation | Fresh nonsecret ownership, SKU/image/cost/collision checks; owner approves retained disks/escrow, custody, review date and maintenance window. | Stop on ambiguity. No live mutation is included in discovery. |
| R1: old-environment containment | Approved NSG rule diff, bounded service stop and VM deallocation; preserve disks, identity evidence and locks. Verify power state and fresh external/lateral denials. | Keep containment; no automatic restoration of public access. Escalate incomplete containment before creating an active replacement. |
| R2: isolated replacement foundation | Saved create-only resource plan plus exactly the reviewed VNet subnet append. New VM/disks/network/vault/locks; no old-resource destruction or contract switch. | Keep new resources isolated; retain state and evidence. Cleanup is separately approved. |
| R3: trusted bootstrap | Hash-bound transfer/install, fresh-secret generation and exact escrow; reviewed restart/start actions on the new host only. Verify disks, guard order, provenance and runtime. | Stop/contain new runtime; retain interrupted journal and escrow. No regeneration/reset on retry. |
| R4: trust acceptance and endpoint activation | Secret-safe old/new probes, complete old-trust retirement, reviewed HTTPS/egress activation, actual hostname/TLS/issuer and independent security/QA acceptance. Switch active contract only after all gates pass; retain distinct old/new contracts. | Disable new endpoint; preserve both environments. Never switch back to accepting old credentials. |

R0 is not an apply approval. Local R1/R2 writers and bounded R3/R4 helpers exist;
real saved plans, fresh ownership and readback, the exact installation/egress
transcript and full acceptance coverage are still package-specific gates. A later
failure never authorizes removing disk locks or running `terraform destroy`.

## Cost envelope and next application boundary

The Microsoft [Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)
returned these Sweden Central USD consumption rates on 2026-10-15: Linux
D2as v7 $0.097/hour; Standard regional IPv4 $0.005/hour; Standard SSD LRS
E4 (32 GiB) $2.40/month, E6 (64 GiB) $4.80/month, E10 (128 GiB) $9.60/month.
Use normal Linux consumption meters, not Windows, Spot, reservations or the
separate disk-mount meter. No discount, credit or TRY conversion is assumed.

With a proposed 32-GiB OS, 64-GiB DB and 32-GiB objects disk, the replacement's
VM + one IP + disk-capacity subtotal is **$84.06 per 730-hour month**. Seven days
of additional running overlap is approximately **$19.35** at prorated capacity
rates. These are component subtotals, not an all-in bill or spending cap. Add
existing retained resources, vault operations, disk transactions, network egress,
backend storage, bootstrap traffic, taxes and any selected egress service. After
old VM deallocation its compute charge stops, but retained disks/IPs and other
resources remain billable. The observed old 64/32/30-GiB disks cost a capacity
subtotal of $9.60/month (the 30-GiB OS bills in the 32-GiB tier); two retained
Standard IPs add $7.30/month. Thus the replacement plus retained old disks/IPs
has a **$100.96/month component subtotal** after old VM deallocation, or
**$171.77/month** while both VMs run. These figures exclude the variable/other
charges above. Complete the egress/retention design before approving a budget;
do not present these subtotals as the final total.

Application integration follows R4 in a separate package: Sweden application
foundation, environment subnet bound at creation, private DB TLS and bounded
pooling, owner/runtime credential separation, Claude-lane migrations/roles,
private buckets and immutable image/secret releases. Runbook 08 stage D then
targets the **accepted replacement host**, not the preserved old host. SMTP
provider/residency remains undecided; Namecheap stays deferred. Full application
QA and measured database **and file-byte** restore/RPO/RTO remain launch gates.
LP2-01/02/03 stay INTEGRATED, not DONE. Preserve #175/#178 Open questions.
