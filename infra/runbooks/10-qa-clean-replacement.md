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
approved replacement bootstrap and acceptance. R2 subsequently completed as
recorded below; R3/R4, measured recovery and full trust acceptance remain open; do not treat this R1 evidence as new authorization.
The approved packet and execution records remain private; their B9 handoff
records the paths, checks, independent reviews and proposed ledger update.

## Accepted R2 and bounded R3 preparation (2026-10-18)

PRs #187, #188 and #189 are merged at base `d8b7df8`. N2 is implemented and
reviewed. The owner-approved **packet-02 was applied once** on 2026-10-18,
16:26:11–16:27:33 UTC: ten creates, one isolated VNet subnet append, zero destroys.
Its control-plane/state readback was independently accepted. Packet-01 remains
withdrawn; packet-02 is consumed. **Never replay, refresh or regenerate either
packet.** Earlier pre-R2 procedures below are historical requirements, not the
next operation. A repair/import/unlock/deletion requires a separate package.

Fresh R3 GET/list/state-pull reconciliation on 2026-10-18 passed 27 checks for
retained containment/resources, new resources, network and state/contract
stability. Private evidence binds the script and observation times. No SSH,
bootstrap, credential processing, network mutation or application deployment
ran. Control-plane evidence does not establish guest isolation or QA readiness.
LP2-01/02/03 remain INTEGRATED; PD-3 and full Q3 recovery acceptance remain open.

The owner selected a **fresh GitHub-hosted Ubuntu 24.04 amd64 runner** for
composition qualification. The manually dispatched
[`r3-qualification.yml`](../../.github/workflows/r3-qualification.yml) requires
an exact source SHA equal to its dispatch ref, read-only repository permissions,
no Azure credentials, no existing containers and no `/srv/tonyai` path. These
checks do not establish an empty image cache or Docker data directory. Publication
and dispatch need the owner's Git authorization and concrete source agreement.
The local shared Supabase stack and both Azure hosts are not qualification targets.

`r3_qualification.py` uses the unchanged upstream v0.8.2 file/SQL hashes, QA,
HTTPS and r02 overlays and all twelve locked images. It validates all profiles,
starts only the nine unprofiled services on disposable data, checks exact running
image/config identity and health, and emits status-only evidence. Production
initialization keeps its full guards; the harness imports only pure credential
generation. Its report is **composition smoke**, not complete qualification.
It records the hosted Docker client/server and Compose versions, the absolute
setup-node executable and its verified v22.23.3 version. It requires the classic
`overlay2` image store before any pull/start because the config-digest comparisons
are not qualified for the containerd image store. The runner engine is not
reconfigured. Docker 29.9.1 / Compose 5.6.0 installation and image-store choice
remain separate unqualified gates; a hosted smoke cannot close them.
Before bootstrap, additionally prove the private refused-statement regression
with stable connections, Realtime image/source correspondence and GCM consumer
round-trip, and exact offline install/image-transport behavior. Keep the private
regression out of Git and never run it against the shared/live database.

### Pinned artifact and installation tooling

`r3-toolchain.lock.json` fixes Docker Engine/CLI, containerd, Buildx, Compose and
Node 22.23.3 candidates by version and SHA256. Candidates are not qualified merely
because they are pinned. `r3_artifacts.py stage <new-private-directory>` downloads
public inputs from a clean committed source tree. Format 2 records that source
SHA and observed signing-key/InRelease/Packages hashes. It stages only explicitly
allowlisted tracked helpers, never ignored/untracked scripts or the legacy
`selfhost_docker.sh`. `verify` refuses changed, missing, extra, linked or special
files and unlisted directories. The r02 runtime contract now excludes and rejects
the legacy installer, including a manifest rehashed to add it. The offline
installer stays in its separately approved staging bundle; it is not a runtime
helper. Existing host contracts that include the legacy file are historical and
must not be silently rebound. This partial install bundle still does not satisfy
the final host source map. `r3_transfer.py --bundle <directory> --output <new-private-directory>`
creates a regular-file archive, its digest and an exact offline install proposal.
Neither tool invokes SSH or executes an installation. No credential/environment
file, database bytes or historical packet belongs in the archive.

`r3_toolchain.py` implements verification of the pinned Docker primary key,
exactly one InRelease signed block with no outer bytes, and only GPG-produced
verified plaintext. It requires Suite noble and the SHA256 section binding of
Packages. Mutable upstream index hashes are not lock pins: staging fetches the
current signed chain and binds its observed hashes in the manifest. Offline
verification uses those carried bytes and the same immutable package pins. It checks each archive hash/control metadata and exact five-package
offline dependency closure. A missing dependency requires a new reviewed lock;
never resolve candidates or allow downloads during live installation. The exact
five-package install requires the r02 OS already to satisfy `iptables`, `nftables`,
`libseccomp2`, `libsystemd0` and Pre-Depends `init-system-helpers (>= 1.54~)`,
plus the other pinned packages' dependencies. Record the real OS dependency
closure before qualification and bootstrap; a hosted runner is not proof of it. Signature
and package verification require Linux `gpg`/`dpkg-deb`; they are not claimed from
the local macOS preparation. The Node archive uses its existing reviewed hash.
See [Docker's package installation procedure](https://docs.docker.com/engine/install/ubuntu/#install-from-a-package).

`r3_install.py` implements only the separately approved offline toolchain stage:
root-owned bundle, exact approval hashes, r02 contract/IMDS identity, clean Ubuntu
24.04 amd64 package state, an exclusive attempt journal, no-download package
installation and installed-version readback. It suppresses package service starts
with an exclusive host-wide `policy-rc.d` (exit 101) and persistent service masks, installs Node and the
`live-restore:false` daemon policy, and **leaves services masked**. It does not
format disks, generate credentials, install the final runtime source tree, load
images or start Docker/containers. Existing/partial installation is refused;
inspect and prepare a separate recovery action rather than delete the marker.
The proposal names the exact `python3 -I -B .../helpers/r3_install.py` invocation
and separately records its derived internal apt argv, including `--yes`,
`--no-download` and `DPkg::Lock::Timeout=60`. Never run that apt argv directly:
the installer establishes masks and the attempt journal first. `-B` is mandatory
because helper `__pycache__` files invalidate the approved manifest. An apt lock
timeout preserves the attempt and masks; it does not authorize a retry.
The entire Node archive is checked before the first host write, accepting its
root directory member while refusing foreign roots, traversal and escaping links.
Tool and Node directories and `/etc/docker` are explicitly 0755 even under umask
077; generated private metadata stays 0600. The policy blocks service actions
for **all packages** until separately reviewed removal; do not run unrelated apt
operations while this interrupted/pre-activation boundary is retained.
Qualification of this stage and a reviewed unmask/guard/source-transfer sequence
remain gates. Do not run the legacy Docker installer for r02.

The private bootstrap packet must bind these tools, transfer archive, every
installed file/image, actual Node binary, OS/package metadata, new host identity,
SSH trust, disk IDs and approved filesystem UUIDs, exact argv/order and failure
preservation. It stays **NOT READY FOR BOOTSTRAP APPROVAL** while any proof is
missing. Offline image transport must retain resolution by the locked repository
digests; an archive load or mutable local tag alone is insufficient. No network
egress change is implied by this offline proposal.

Preserve the owner's QA VPN deferral and deferred custody/recovery/staffing
choices. Backup endpoint reservation, ZRS/30-day retention direction and full
loss/recovery proof remain later packages. Nothing here activates R4 or changes
the active deployment contract.

### Disposable qualification proposal and evidence boundary

The next execution proposal uses the already selected **fresh GitHub-hosted
Ubuntu 24.04 amd64** target. It is not dispatch approval. Before dispatch, the
owner approves `.github/workflows/r3-qualification.yml` at a published, reviewed
full commit SHA and the exact branch/tag ref resolving to that SHA. Bind the
workflow's SHA256 and source tree, job names and inputs in the private proposal.
An uncommitted patch has no executable source SHA: authorize publication first,
finish independent review, and issue a source-bound addendum for separate dispatch
approval. A merge with an identical tree still needs an explicit correspondence
record; never rewrite historical evidence or carry its SHA binding forward.

| Job | Permitted work and credentials | Evidence and limits |
| --- | --- | --- |
| `composition` (35 minutes) | Hosted Docker/Compose and setup-node 22.23.3; `contents: read`, checkout credentials not persisted; only existing `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` for read-only pulls. Generates isolated test credentials in the runner. | Source, actual tooling, image-lock hash and nine running service identities in the status-only job summary. Require the complete job, including project-scoped cleanup, to succeed. No pinned-engine, installer, dependency or QA acceptance. |
| `package-provenance` (15 minutes) | Public HTTPS downloads only; no repository secrets, Azure/OIDC, SSH or DB credentials. `r3_artifacts.py stage` then `r3_toolchain.py <bundle> <new-receipt>`; no apt/install command. | Real Docker signature → current Packages index → five immutable archive hashes and control metadata; reviewed Node archive hash. Receipt explicitly says `real-vendor-artifacts-not-ci-fixture`, `qa_ready: false`, `install_authorized: false`. |

Both jobs bind `inputs.source_sha` to `GITHUB_SHA` and checkout HEAD before their
work. They run independently on fresh runners; one job passing does not qualify
the other. The package job retains exactly six public files on success: receipt,
format-2 manifest, toolchain lock, Docker key, InRelease and Packages. The artifact
name binds source SHA, run ID and attempt; retention is **seven days**. No runtime
directory, generated environment, rendered Compose, container logs, regression
payload or credentials may be uploaded. The package archives are verified but
not retained in this artifact; it is evidence, not an executable transfer bundle.
CI's generated-key signed fixture proves verifier behavior only and cannot replace
this vendor verification. A local download whose stage failed before GPG is
incomplete input material, not a verified format-2 bundle or transfer candidate.

Receipt issuance compares every helper, local runtime file and policy with
`git show` at the source commit, checks upstream runtime hashes against that
commit's upstream lock, and requires the exact artifact/provenance file set.
The approved toolchain lock also comes from committed bytes; a clean Git status
cannot hide `skip-worktree` changes. Manifest and lock hashes use the same bytes
that were verified. CLI refusal exits nonzero; the workflow also requires the
receipt file to be nonempty before upload. Existing explicit-hash installer
verification remains Git-free and does not acquire new installation authority.

After the approved run, save the run URL/ID/attempt, event, head SHA, job conclusions,
runner image/version from setup logs, composition summary and six-file artifact
to a **new private evidence directory before expiry**. Verify receipt source and
manifest/lock/metadata hashes against the approved source; record artifact digest
and local file hashes. Bind any later transfer to its own freshly staged and fully
verified bundle. Preserve this evidence with the private R3 packet; do not change
the owner's backup retention/custody decisions through CI artifact retention.

On a source mismatch, missing verifier, signature/package mismatch, unsupported
image store, pull throttling, startup or cleanup failure, stop. Never weaken pins,
switch the engine/store, install missing tools, retry automatically or dump runtime
diagnostics into public logs. A missing summary/artifact is missing evidence, never
PASS. Retain safe job conclusion and failed step identity; GitHub discards the
runner, including transient secrets and partial data. Do not promise recovery of
private runner diagnostics after disposal. A retry needs a new owner-approved
attempt proposal; scope/source changes require review and a new binding.

For failures the composition script handles, its failure line contains only a
fixed phase code and two cleanup states,
for example `phase=DATABASE_START`, `seed_cleanup=SUCCEEDED`,
`compose_cleanup=FAILED` (serialized as JSON after `FAIL: composition smoke`).
The code-owned vocabulary covers runner/tooling guards, source staging, generated
settings, Compose rendering/validation, image pulls/identity, database seed/start,
service health, cleanup and report writing. It excludes exception text and class
names, argv, environment values, URLs, rendered configuration and command output.
These codes identify the failed operation or check, not its underlying cause.
For handled failures, if cleanup also fails, the initial failing phase is retained and cleanup is marked
separately. `NOT_STARTED` means that cleanup was not attempted; `SUCCEEDED` means
its command returned zero, not independent proof of host or disk state. No success
summary is created until project cleanup succeeds. Failure codes use the existing
job log only: no additional artifact, runtime log export or automatic retry.
Cancellation and job timeout are outside this handled-failure guarantee. SIGINT
can raise `KeyboardInterrupt`, which escapes the script's `Exception` handlers;
Python may print a traceback with source lines, exception classes and public
command arguments, including an earlier exception during cleanup. Captured child
stdout/stderr are not included in that traceback. SIGTERM or SIGKILL can terminate
the process without any status line. Use the job conclusion and treat missing
status or cleanup evidence as unknown, never success.
Historical generic failures cannot be assigned a phase retroactively; preserve
their evidence and establish any new result with a separately approved attempt.

The smoke's Compose JSON boundary has one renderer-specific normalization:
[Compose 2.38.2](https://github.com/docker/compose/blob/v2.38.2/go.mod) uses
[compose-go 2.7.1](https://github.com/compose-spec/compose-go/blob/v2.7.1/types/types.go),
whose `ServiceVolumeBind.CreateHostPath` boolean omits false during JSON encoding.
Only when the actual `compose version --short` is exactly `2.38.2`, a mount has
`type: bind` and a present dictionary `bind`, the smoke supplies an omitted
`create_host_path: false` to a copy before running the unchanged shared validator.
Explicit values are preserved; missing/null bind objects and omissions from other
versions remain refused. Do not generalize the default to newer schemas or change
the source overlays to allow implicit directory creation. The runner image's
software inventory is diagnostic context, not proof of the actual tool version
or a successful composition. Local JSON-shape tests do not replace a new,
separately approved hosted attempt.

### Offline input qualification and host installation proposal

The next bounded package adds **preparation**, not a bootstrap or transport PASS:

- `r3_package_evidence.py <artifact-directory> <new-directory>` rehashes all six
  public archives against the current lock, reads the five `.deb` control archives
  without executing them, retains every control/maintainer-script file and records
  Depends, Pre-Depends, Provides, Conflicts, Breaks and Replaces. It hashes the actual
  Linux Node member without running it. It does not perform GPG verification or
  solve target dependencies; pair it with `r3_toolchain.py` vendor provenance.
- `r3_guard_files.py <new-directory>` renders four reviewed offline payloads:
  SSH policy, host-fingerprint unit, Docker mount drop-in and runtime guard.
  Absolute destinations, root uid/gid and modes are metadata. It never writes to
  those destinations, downloads Node, reloads SSH, changes firewall rules or starts
  a service. The r02 source contract now binds this renderer instead of
  `selfhost_host_guard.sh`; old contracts are historical and must not be rebound
  silently. **Neither `selfhost_docker.sh` nor `selfhost_host_guard.sh` is an r02
  execution entrypoint.** Legacy host procedures remain unchanged.
- `r3_source_plan.py <archive-derived-node-sha256> <new-json> --runtime <verified-runtime>`
  computes the complete proposed contract file map and desired ownership/modes.
  The extra generated `volumes/api/envoy/lds.qa.yaml` is bound separately to the
  pinned template and the exact redaction checked by `check_source_tree`; it stays
  outside the contract's static file set. Without `--runtime` its hash is explicitly
  missing. Generated secrets/journals and custody evidence remain private and are
  not public source artifacts. The caller-provided Node hash is not an installed
  receipt; compare it with the independently verified archive and installed binary.
- `r3_image_transport.py <oci-layout> <new-directory>` verifies all twelve original
  locked repository-digest references, manifest/config/layer hashes and sizes,
  linux/amd64 config identity and an exact blob set, then creates and re-reads a
  deterministic `images.oci.tar` and receipt. A locked multi-platform index stays
  unchanged: exactly one linux/amd64 child manifest and its config/layers are
  carried, with both original and platform manifest digests recorded. Other
  platforms are intentionally absent; missing/ambiguous amd64 children or nested
  indexes fail closed. Exact metadata key allowlists reject duplicate/case-colliding
  keys, alternate reference annotations, conflicting document types and platform
  aliases. Layout roots require exactly the original ref.name annotation; hash-bound
  upstream documents permit only enumerated descriptive/attestation annotations. No links, foreign-layer URLs, tags, extra or missing
  selected-platform content. Realtime's current lock is such an index; replacing
  its root with the child digest would lose the original identity.
  It does not fetch/export/import images, decompress layers or qualify a Docker
  store. The importing engine must validate layer diff IDs. Real image archive
  hashes/config receipts cannot be invented from the lock or synthetic fixtures.

The installer now retains its exact APT simulation and an **observed** package /
Node receipt, bound to the approval, source helpers, manifest and contract. It
refuses a nonempty `dpkg --audit` and requires both `Inst` and `Conf` actions to
match the exact five package names/versions, with no removal or old-version
replacement. Both simulation and real APT argv include `--no-remove`; only
reviewed C-locale informational lines are accepted beside exact pinned actions.
An unknown verb, purge or nonzero-removal summary is refused. It preserves `r3-install-attempt.json`, masks and policy on failure;
`r3-install-complete.json` is written only after the receipt. A receipt without
completion is partial evidence. The source map binds the deterministic package
text separately; the observed receipt binds back to the approved contract rather
than creating a circular contract/receipt hash.

**Target dependency evidence.** Retained control-plane observation identifies
Canonical / `ubuntu-24_04-lts` / `server` / `24.04.202609040` (exactVersion), as
observed on 2026-10-18. A fresh control-plane read is required for a new guest
packet; a historical observation is not current state. Image metadata, VM/disk
IDs and architecture expectations are available through GET; installed versions,
pending dpkg state, APT hooks, Essential packages, alternatives/providers and
recursive dependency satisfaction require separately approved guest execution.
The hosted runner's package inventory proves neither the Azure image nor its boot
customizations. No guest inventory has been collected by this package.

**Implemented local guards; guest qualification still open:** the installer now
queries the complete `dpkg-query -W` inventory (Package, Architecture, Version,
full Status, Essential, Depends, Pre-Depends and Provides). Duplicate/malformed
rows and any existing target package, including another architecture, refuse.
It requires the same inventory after simulation immediately before APT, exactly
the five pinned additions after APT, and only those five hold transitions before
the receipt. Every pre-existing row must remain identical; `dpkg --audit` must
be empty at the initial, post-APT and receipt boundaries.

The separately established isolation must leave `apt-daily.timer`,
`apt-daily-upgrade.timer`, `apt-daily.service`, `apt-daily-upgrade.service` and
`unattended-upgrades.service` persistently masked, inactive/dead, with no pending
job (systemd v255's explicit empty `Job=` value) and service `MainPID=0`.
The installer observes these states and activation timestamps
before inventory, before spawning APT, during wait polling, after APT and at the
receipt boundary. It checks package-manager processes and probes existing native
package lock inodes at idle boundaries without creating/deleting/bypassing them.
Only the APT child's process group, bound to its PID/start identity, is permitted
during APT. Both simulation and execution explicitly set `-o Dpkg::Use-Pty=0`:
APT 2.7's default PTY path otherwise calls `setsid()` in its dpkg child even with
stdin from `/dev/null`, violating this group constraint. The transfer proposal
inherits that same option; a separate-session manager remains refused. Without
the PTY, dpkg output is retained in the installer's stdout/stderr files instead
of APT's `/var/log/apt/term.log` terminal capture. A read failure or changed state refuses completion, preserving the
attempt, child PID, observations and logs. An interrupted observer does not prove
the detached child stopped. **No apt unit is stopped, masked or unmasked by this
original format-2 code.** The isolation procedure needs separate review and owner
approval. The opt-in R3-POLICY-01 implementation below introduces a distinct
format-3 maintenance contract; it does not reuse a format-2 approval.

APT writes a dedicated, exclusively reserved `/etc/tonyai/r3-install.dpkg.log`
through `Dpkg::Options::=--log=...`, replacing dpkg's default log destination for
this invocation; `/var/log/dpkg.log` will not contain this transaction.
The [documented dpkg log](https://manpages.ubuntu.com/manpages/noble/man1/dpkg.1.html)
must show exactly the five new installs from `<none>`, their exact configure
versions and terminal installed states. Unknown records, upgrades/removals,
extra packages (including unrelated trigger processing), missing or repeated
actions refuse. The validated simulation and structured actual actions must
agree on the exact pins; human APT prose is not compared byte-for-byte.
The existing strict simulation parser is not broadened here.

**CL-P2-3 — explicit guest blocker:** the pinned containerd/CLI/Engine archives
ship payloads below `/usr/share/man`. If the target has interested man-db
triggers, dpkg can process them successfully and the strict non-pin transaction
guard then refuses after APT has changed the host. No receipt is emitted and
the one-shot attempt cannot be reused. Target man-db presence, trigger interests,
path exclusions and other APT hooks (including packagekit activation) are not
qualified. Before proposing guest installation, resolve them from target
readback and a real Noble transaction fixture under a separately reviewed
policy. Do not broaden trigger acceptance or disable triggers merely to pass
this guard. Local synthetic refusal tests do not close this blocker.

Install approval and installed receipt are now **format 2**; approval binds
`r3_package_state.py` and `r3_apt_observer.py` in addition to the existing source
hashes. Both helpers are in the staged allowlist, not the runtime host map.
Old install approvals are refused; old bundles and prior execution evidence must
not be rebound. The receipt hashes actual APT stdout/stderr, dpkg log, all four
inventories, simulation streams and every private observation under
`/etc/tonyai/r3-package-evidence/`. This directory and log are preflighted against
partial/reused output. No receipt/completion is written on a failed gate.

Sampling is bounded observation, not continuous exclusion of every transient or
privileged writer. Real Noble simulation/transaction fixtures, native dpkg/APT
lock behavior, reviewed isolation, target dependency closure and lifecycle/reboot
proof remain open. Local synthetic tests do not qualify these. **No guest proposal
becomes executable from this code change or its receipt alone.**

**Open qualification questions:** retain a real Noble APT 2.7 simulation fixture
(the parser currently refuses broken-list suffixes and unlisted prose, including
local-archive selection notes; widen only against a reviewed exact fixture).
Qualify the newly implemented receipt mask/hold observations and detached APT PID
records on the guest. The structured log guard is not a complete chronological
lifecycle validator; installed-status ordering still needs real-fixture proof.
Policy-byte observation, observed Node version rather than an asserted field,
installed-file correspondence to archive md5sums and anchoring the plan
architecture remain open. Transport still requires a selected exporter/importer; reads before
size checks and packaging symlink races/partial archives need assessment before
execution. Contract format 2 retains its label despite the changed required-file
set: old maps fail closed and must never be silently rebound. These limits remain
open; local fixture tests do not qualify a host.

Hash-verified archive control data requires at least `libc6 >= 2.38` and
`libseccomp2 >= 2.5.0` for containerd; `libc6 >= 2.34` for CLI; Engine requires
`containerd.io >= 2.1.5`, CLI, iptables, nftables, `libc6 >= 2.34`, libsystemd0 and
Pre-Depends `init-system-helpers >= 1.54~`. Buildx/Compose declare no Depends in
these archives. This list is **direct edges, not complete closure**. Native APT /
dpkg must resolve the full installed graph, including versioned providers and
Essential-package assumptions. See [Debian relationships](https://www.debian.org/doc/debian-policy/ch-relationships.html)
and [maintainer-script rules](https://www.debian.org/doc/debian-policy/ch-maintainerscripts.html).

The guest inventory proposal is read-only: bind `/etc/os-release`, kernel,
`dpkg --print-architecture`, boot ID and IMDS; collect `dpkg-query -W` with Package,
Version, Architecture, Status, Depends, Pre-Depends, Provides and Essential fields;
retain `/var/lib/dpkg/status`, `dpkg --audit`, APT configuration/hooks and package
selection state privately. Use the pinned local archives and the existing
`install_argv(..., simulate=True)` in C locale, with networking denied. Record
full recursive native-solver dependency/provider/version resolution, no additional
candidate, removal or unrelated configure action. Stop on any missing dependency;
a new signed, pinned OS dependency bundle and review is required, never a live
`apt update`, `--fix-broken` or download fallback. Inventory alone does not qualify
installation, maintainer scripts or reboot.

**Maintainer-script findings and disposable lifecycle proposal.** The retained
real Engine/containerd postinst files call `deb-systemd-helper unmask/enable` and
`deb-systemd-invoke start`; Engine also calls `invoke-rc.d`, creates the docker
group and may load AppArmor policy. A mask check after apt is insufficient to
prove that no intermediate start occurred. Monitor unit/socket/process state and
retain timestamped transitions, helper versions, boot IDs and root-only journal
receipts during the separately approved lifecycle test.

The owner-selected fresh **GitHub Ubuntu 24.04 amd64** runner remains the hosted
smoke/input-analysis target. It contains preinstalled packages and has no matching
r02 IMDS identity; the production installer must refuse it. Never mock IMDS or
remove the identity guard to claim an end-to-end production install. A job cannot
provide normal reboot continuity. The separate proposal is one disposable
Sweden Central VM on exact image `24.04.202609040`, isolated new OS/data disks,
no live data, no recovery-vault role, no app network access and an approved
out-of-band console/SSH trust channel. **No resources are provisioned here.**
Before approval bind its exact resource IDs, network plan, costs, cleanup and an
explicit qualification identity contract; the current r02-only installer cannot
be executed on an arbitrary test VM. A reviewed qualification adapter must preserve
the same installation core and bind the test identity, without becoming an r02
bypass. Implementation and review of that adapter remain a prerequisite, not an
implied action in the input-analysis workflow.

Use isolated fresh disposable instances/snapshots for successful install, held
APT/dpkg locks, interruption after journal/mask creation, interruption during
maintainer scripts, and loss of the terminal/wrapper. APT's lock limit is 60 s;
record actual exit, pending state and masks. No test retries a consumed installer
attempt. The detached apt child can outlive an interrupted Python wrapper; preserve
its PID/state and never infer termination, rollback or safe replay. On the success
case verify five installed versions/architectures/statuses, holds, Node hash/version,
receipt and masks before proceeding. Preexisting policy/masks, dirty package state,
wrong hashes/identity, unsafe ownership and a consumed attempt must refuse before
writes, including stale receipt/completion/plan/log/package-list outputs. Local
mocks prove branch behavior only.

**Offline guard installation and activation ordering (proposal only).** After
separate approval, strict authenticated transfer of the hash-bound source/payload
set, inventory and toolchain installation, an operator installs the four generated
files exclusively (no overwrite; preflight every destination and parent), root:root,
with the plan's 0644/0755 modes and safe directory chains. Bind the installer,
renderer, runtime guard, all imported helpers and operator-side
`replacement_escrow.py` in the execution packet. Require the matching completion /
observed package receipt and archive-derived Node hash; use its absolute Node
path, with no download or new PATH symlink. Verify fresh IMDS and approved disk
IDs, separately approved filesystem UUIDs/fstab and whole mounts, complete file
hashes/modes and `live-restore:false`/iptables daemon policy. A partial copy stops;
no overwrite or rollback is automatic.

Then, still with all three persistent masks in place: validate SSH using `sshd -t`,
retain a second authenticated session, approve/reload SSH; verify units/drop-in,
run `systemctl daemon-reload`, enable the host-fingerprint unit only, and run the
reviewed runtime guard to establish/probe the ordered container IMDS/WireServer
rules. The guard **mutates iptables**; this is not read-only inventory. Only after
those checks and a separate activation approval, verify the exact installed
`policy-rc.d` hash (exit 101), remove only that policy, recheck masks and guard
state, disable package-created automatic boot activation for all three units and
read back the enablement links, unmask containerd then docker service/socket, and explicitly start the
daemon. Capture every transition. Socket unmasking must not precede the verified
guards. Do not enable automatic container restart; all containers retain restart
`no`. Require stopped services/containers after a normal reboot, then repeat
identity/mount/source/firewall/custody gates before guarded start. A failed guard
or missing disk must prevent start. This sequence is unexecuted; reboot and policy
removal/unmask qualification remain OPEN.

**Offline image execution proposal (not implemented by archive preparation).**
Export all twelve locked references to a selected-platform OCI layout on an approved
connected disposable acquisition worker; no mutable tag substitution. Preserve
original index/manifest bytes and the selected amd64 config/layers, then run the transport
verifier and bind its archive hash. Select the import mechanism only after a
pinned Engine 29.9.1 / Compose 5.6.0 store compatibility experiment. Docker 29's
[fresh-install store default](https://docs.docker.com/engine/storage/containerd/)
is containerd; the existing smoke explicitly requires classic overlay2. Neither
`ctr import` into an assumed namespace nor Docker save/load is accepted without
Docker API readback of original repo digests. Changing daemon store policy or the
smoke identity checks needs its own reviewed implementation.

The import experiment must use an independently observed empty image/content store
and no containers, with registry egress denied **before** import and throughout
startup (record firewall/namespace rules, denial controls, DNS and connection
attempts). Host/daemon/container paths must all be covered; a registry credential
logout is not denial. Import only the approved hash-bound archive, inspect every
original repository@digest through Docker's selected store, compare config/platform
with the verified receipt and DB policy, then validate all profiles and start only
`api-gw`, `auth`, `db`, `imgproxy`, `meta`, `realtime`, `rest`, `storage`, `studio`
using the reviewed composition and `--pull never --no-build`. Read back nine exact
container identities/health and config hashes; prove caddy/functions/supavisor
remain inactive. Synthetic credentials and data only, project-scoped cleanup,
no global prune, no runtime/log uploads. Missing digest resolution or attempted
registry access is failure, never repaired by tagging, pulling or fallback images.
The import driver, real OCI bytes/config receipts, actual denial and service
execution remain required evidence; local synthetic fixtures close none of them.

**Registry-denied transport run (implemented, not executed).** `r3-image-transport.yml`
(`workflow_dispatch` only, attempt 1 only, `contents: read`, no secrets or OIDC)
runs `r3_image_qualify.py` once on a fresh GitHub-hosted `ubuntu-24.04` amd64
runner. Its scope is the transport identity half of the gate below; it starts no
service. The steps, in order, each refusing the run on any difference:

1. **Bind** the dispatch: `source_sha` = `GITHUB_SHA` = `GITHUB_WORKFLOW_SHA` = clean
   `HEAD`, run attempt 1, every tracked file hashed; the owner's public SSH recipient
   must equal its approved SHA256. Reruns are refused by the job's `run_attempt == 1`
   guard and the binding; a second dispatch needs a new owner approval.
2. **Stage** the pinned age tool, then **preflight** (`/mnt` scratch ≥ 40 GiB,
   `ip`/`dpkg-deb`/`gpg`/`systemctl`, no existing network namespace).
3. **Toolchain** — `r3_artifacts.stage`: the five Docker packages by locked SHA256
   behind the GPG-verified InRelease/Packages chain. Nothing is installed.
4. **Acquire** — `r3_image_acquire.py`: anonymous pull-scoped Docker Hub reads of
   the twelve locked roots **by digest**, the unique linux/amd64 child of an index
   and its config/layers; every document and blob is size- and hash-checked; the
   bearer is never forwarded to a CDN redirect; non-HTTPS redirects refuse. It
   records each serving endpoint's resolved addresses. Never a tag, daemon or pull.
5. **Archive** — the unchanged `r3_image_transport.prepare`: all twelve roots
   verified, deterministic `images.oci.tar` and its analysis.
6. **Isolate** — the hosted Engine (`docker.socket`, `docker.service`,
   `containerd.service`) is stopped and must read inactive (or failed). Fallback
   tunnel devices are kept out of new namespaces
   (`net.core.fb_tunnels_only_for_init_net=2`). A network namespace
   `tonyai-r3-deny` gets **only `lo`**: no interface, address or route can carry a
   packet off the host. `/etc/netns/tonyai-r3-deny/` supplies `resolv.conf`
   (`nameserver 127.0.0.53`), `hosts` (localhost only) and `nsswitch.conf`
   (`hosts: files dns` — no `resolve`, so no host resolver socket).
7. **Denied import** — `sudo ip netns exec tonyai-r3-deny env -i … python3 -I -B
   r3_image_import.py` as root:
   - re-observe the namespace (only `lo`, no default/gateway route, inode ≠ PID 1's)
     and the three resolver files — each resolved through any symlink (Ubuntu's
     `/etc/resolv.conf` is one) and required to be the staged file's inode, not
     merely equal bytes; start a loopback DNS observer on
     `127.0.0.53:53` that logs every question with its window and answers REFUSED;
   - **denial probes**: each Docker Hub name and every acquisition endpoint must
     fail to resolve *and* be observed; each recorded address must fail to connect
     with `ENETUNREACH`/`EHOSTUNREACH`/`EADDRNOTAVAIL`;
   - re-hash the archive against its analysis and the image lock, extract regular
     OCI files only, re-run `verify` on all twelve, then copy the nine active roots'
     closure and `verify` it strictly as a nine-image lock. The load archive differs
     from that subset only in `index.json`, which adds `io.containerd.image.name`
     = `docker.io/<repo>@<root>` — the name a by-digest pull records;
   - extract `containerd`, `ctr`, `runc`, `containerd-shim-runc-v2`, `dockerd` and
     `docker` from the hash-locked packages; restore cgroup2 in the private mount
     namespace; start containerd (CRI disabled) and dockerd on **new** roots under
     `/mnt`, sockets under `/run`, with `daemon.r02.json`'s keys (minus
     `firewall-backend`) plus `bridge: none`, `iptables: false`,
     `userland-proxy: false`, no mirrors or proxies and **no store feature flag**:
     Engine 29's fresh-root default store is what is qualified. Both daemons must
     run in the denied namespace from the extracted paths; client and server must
     be 29.9.1;
   - **empty store**: `docker info` reports the containerd snapshotter store
     (`overlayfs`, `driver-type io.containerd.snapshotter.v1`), zero images and
     containers, no mirror or proxy; image, container and volume lists and
     containerd's `moby` content and image lists are empty;
   - **daemon probe**: one `docker pull` of the locked, inactive `caddy` root must
     fail with the observer seeing a Docker registry question; the store must still
     be empty;
   - `docker load --platform linux/amd64` of the nine-image archive;
   - **readback** per service via `docker image inspect <locked ref>`: `Id` and
     `Descriptor` equal the pinned root (digest, media type, size), `RepoDigests`
     equals exactly the locked reference, no tag, linux/amd64 with no variant,
     `RootFS.Layers` equal the verified config's diff IDs. Through `ctr content get`
     the stored root, platform manifest and config bytes hash to their digests and
     the stored config is the pinned closure's; `db` must also equal
     `database-image-policy.json`. Store image names, image IDs and the content set
     must equal exactly the nine names, roots and closure blobs; `caddy`, `functions`
     and `supavisor` must not resolve;
   - **materialize**: `docker create --pull never --network none` per service needs
     every layer unpacked — at load, or at create at the latest — and containerd
     validates each diff ID when it unpacks; inspect
     must show `created`, PID 0 and a zero start time; then `docker rm --volumes`.
     No process from any image executes;
   - final store unchanged, namespace unchanged, **no resolver question outside the
     probe windows** (name, address, daemon); both daemons must stop on SIGTERM.
   Afterwards the controller kills any process still in the namespace (a sudo PTY
   can keep the driver outside the killed group), refuses if one survives, and
   takes ownership of the root-written evidence; an unreadable evidence directory
   refuses sealing instead of sealing it as empty.
8. **Seal** — every raw file (command argv/stdout/stderr/exit, daemon logs capped
   at 32 MiB, manifests and configs but never layers, the resolver log) under a
   retention manifest, age-encrypted to the owner's recipient. Only
   `transport-evidence.tar.age`, `binding.json` and `summary.json` upload, seven days.

`TRANSPORT_IDENTITY_PASS_REVIEW_REQUIRED` is the only success status; any refusal
is retained evidence, never retried. **Why no service starts:** the transport claim
is fully content-addressed — pinned root → manifest → config → diff IDs, verified on
ingest, validated on unpack (at load or create), and read back through the Docker API —
so starting a process adds no transport evidence. Startup under the reviewed
composition additionally depends on Compose 5.6.0 rendering, generated credentials,
database seeding and host binds, which are not this gate's inputs; mixing them in
would make a refusal ambiguous and a pass a composite claim. That half stays open
(table below). **Limits:** a hosted Ubuntu 24.04 runner, not the r02 image; the
packages are extracted, not installed (the installer lifecycle is its own gate);
non-DNS connection attempts by the daemon are not individually counted — they
cannot leave a loopback-only namespace; GitHub-hosted runner identity is trusted
for this disposable run as for the composition smoke.

**Concrete next hosted proposal.** Publish/review this patch first; an uncommitted
patch has no dispatchable source SHA. Then bind the full published SHA, tree,
`.github/workflows/r3-offline-inputs.yml` SHA256 and branch ref in a new addendum,
with a fresh ref equality check immediately before a separately approved single
`workflow_dispatch` (`source_sha` equals ref HEAD). Job: `offline-inputs`, fresh
Ubuntu 24.04 amd64, 15 minutes, `contents:read`, nonpersistent checkout, no repository
secrets/Azure OIDC/SSH/DB credentials. It stages and verifies real public vendor
inputs, extracts control scripts/Node hash, renders offline guard payload/source
map and uploads only explicitly listed public analysis/provenance files for seven
days. `binding.json` records source/run/attempt and every output hash. Capture ZIP
and all file hashes before expiry. Any failure stops with no success upload or
retry; preserve safe step conclusions and discard the runner. No machine-wide
installation, image import or daemon operation occurs. This is useful input
analysis, **not** a request to rerun the prior composition just to recover its
summary, and not installer/dependency/transport qualification.

Private DB regression and Realtime consumer qualification remain separate packages
below. They depend on an accepted exact image/config/composition and private
execution/delivery design; neither the new input job nor archive analysis includes
their payloads or grants their execution. Preserve deferred VPN, custody, recovery
and backup decisions. Bootstrap stays `NOT_READY_FOR_BOOTSTRAP_APPROVAL`.

### Remaining pre-bootstrap qualification packages

These are preparation requirements, not jobs hidden in the smoke workflow:

| Package | Exact proof required before closing its gate |
| --- | --- |
| Private DB regression | Privately reviewed and hash-bound refused-statement payload on the exact QA database digest/composition. Use persistent connections, record backend PID/session identity before and after each refusal, SQLSTATE, benign positive controls and continued independent-connection queries. Detect restart/reconnect/server instability; a refused statement alone is insufficient. Keep raw diagnostics outside Git/public artifacts. Separately approve its private execution/delivery mechanism before running. The owner-accepted replacement regression (not the historical payload) is published as `infra/scripts/r3_db_candidate/` with the hosted-runner workflow `r3-db-candidate.yml` and lock `infra/selfhost/r3-db-candidate.lock.json`; it is tested offline only. A `rehearsal` dispatch never consumes the attempt; an `attempt` needs its id committed to the lock by a reviewed PR plus the owner's matching approval. Its PASS is a replacement-regression result only: the historical SIG11 stays NOT_REPRODUCED and this row stays open for it. |
| Realtime source and GCM | Bind locked amd64 digest/config to upstream source/build evidence for v2.134.10, stating any unattested correspondence. Test the actual consumer's GCM write/read and restart persistence with generated synthetic keys, plus wrong-key/tamper refusal. The configured 32 ASCII bytes carry 192 bits entropy; configuration/health or a standalone crypto function is not consumer proof. The harness (`infra/scripts/r3_realtime_gcm*.mjs`, `r3_realtime_clients.mjs`, fixture manifest `infra/selfhost/r3-realtime-gcm.fixture.json`) is implemented and tested offline only; its manifest stays `executable: false` until its listed source, PostgreSQL image, library, bootstrap, runtime and custody bindings are reviewed and the owner approves one exact attempt. |
| Offline toolchain | Inventory the exact r02 Ubuntu image and installed package versions; prove all Depends/Pre-Depends and the no-download five-package apt plan. Qualify pinned Engine/Compose and image store, maintainer scripts, persistent masks, exclusive attempt journal, interrupted/lock-failure behavior, policy-rc.d removal and guarded unmask sequence on an explicitly approved disposable environment. A preloaded hosted runner cannot establish target OS dependency closure or an installer/reboot lifecycle. |
| Offline image transport — identity | Bind export archive hash and every locked repository digest/platform/config; import on an empty store with registry access denied and resolve every original digest. Docker save/load or mutable tags alone are not acceptance. Implemented as the registry-denied transport run above (`r3-image-transport.yml`, not executed): its PASS, reviewed, closes this row for Engine 29.9.1's containerd image store only. |
| Offline image transport — startup | Prove `--pull never --no-build` starts the exact nine services from a transported store under the reviewed composition (pinned Compose 5.6.0 rendering, generated credentials, DB seeding, host binds), with registry access still denied. Depends on the identity row and on the r02 daemon store policy matching the store it qualified; importing the same archive hash on r02 itself belongs here. |
| Final host source map | Bind every source/config/generated file, actual Node binary, installed package receipt and root ownership/modes, plus exact SSH/IMDS/disk/UUID/custody operations. Legacy `selfhost_docker.sh` is excluded. `selfhost_host_guard.sh` is now excluded from the r02 runtime contract. The offline renderer/source plan supplies an installation proposal only; actual file installation and observation still need approval. Final installation, unmask ordering and guarded reboot remain open. |

The bootstrap packet remains **NOT_READY_FOR_BOOTSTRAP_APPROVAL** until all these
gates and independent cross-lane review pass. Hosted smoke, package provenance,
R2 infrastructure creation and unit tests do not establish full QA readiness.

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
written directly to exclusive mode-0600 files in the packet (`plan.stdout.log`,
`plan.stderr.log`, `apply.stdout.log`, `apply.stderr.log`), never printed. Those
logs can contain sensitive provider diagnostics; do not publish or bulk-read them.
Unsuccessful prepare packets are retained for private diagnosis and never reused.

### Pre-R2-apply gate: wrapper lifetime and diagnostic streams (N2)

The local writer opens both streams as exclusive mode-0600 packet files with
`O_CREAT|O_EXCL|O_NOFOLLOW` **before** starting Terraform. It validates the packet
as an owner-only directory, refuses a symlinked directory and opens logs relative
to that directory descriptor. Terraform receives regular file descriptors,
`stdin=DEVNULL` and a separate session; no stdout/stderr PIPE reader depends on
the wrapper remaining alive. Success returns stdout bytes from the same open
file descriptor. Both logs remain private on success, failure or interruption;
no provider output is printed. Failure opening either stream prevents spawning
Terraform, leaves any already-created log in place, and never overwrites it.

Real harmless-child tests in `test_replacement_diagnostics.py` exercise wrapper
SIGKILL, actual PTY terminal closure, output larger than pipe capacity, success,
failure, SIGINT and private/exclusive file refusals. Mock deadline tests separately
verify one SIGINT followed by an unbounded wait, without terminate/SIGKILL; apply
regressions preserve the attempt marker and refuse a second attempt. These are
local process/file guarantees, not proof of Azure state persistence or recovery.
An externally killed wrapper cannot write a completion marker, even if Terraform
later succeeds: retain the packet and investigate through the partial-recovery
boundary below. Disk-full/host-loss failures are not solved by stream redirection.

Historical R2 prerequisite, satisfied for consumed packet-02: independent
review and final executor/source hashes were bound in its approval packet. Also run the executor from a session
that survives terminal closure; this operational requirement does not substitute
for stream hardening. No outer hard timeout or automatic retry is permitted.

### Database image qualification before R2

Every Supabase database image must include supautils >=3.4.2. The earlier
3.2.3 floor covers a crash fix only; the superseded 3.4.0 candidate is withdrawn
because it lacks the critical privilege-escalation fixes in
[GHSA-5pqj-rc76-r669](https://github.com/supabase/supautils/security/advisories/GHSA-5pqj-rc76-r669),
[GHSA-v9vh-54vv-7vfg](https://github.com/supabase/supautils/security/advisories/GHSA-v9vh-54vv-7vfg),
[GHSA-vxh6-6m4g-c39q](https://github.com/supabase/supautils/security/advisories/GHSA-vxh6-6m4g-c39q) and
[GHSA-xj9m-rx42-rfc7](https://github.com/supabase/supautils/security/advisories/GHSA-xj9m-rx42-rfc7).
Use the advisory text and fixed-source ancestry, not only affected-range metadata:
the first advisory explicitly includes 3.4.0 despite metadata ending at 3.3.0.
The replacement
candidate is recorded in [database-image-policy.json](../selfhost/database-image-policy.json):
CLI 2.121.0 and its default Postgres 17.11.0.004, pinned to the Linux/amd64
manifest rather than a mutable tag. The QA composition changes only its database
digest; the upstream template/SQL lock and other service images remain unchanged.
The owner accepted this candidate for #187 and consumed R2 packet-02; this is
not R3 deployment approval or authorization to upgrade the shared local stack. Keep reproduction and per-environment assessment private.

Candidate provenance was checked through the registry index, amd64 manifest,
config and attached SLSA build provenance. The attested
[Postgres build source](https://github.com/supabase/postgres/blob/d8666db883fd1bc3bc06654c8db1f8dc39812b82/nix/ext/supautils.nix)
pins supautils 3.4.4, its recomputed Nix source hash and a glibc compatibility
patch. The policy records those hashes, the actual `supautils.so` hash and the
build receipt extracted from a digest-verified image layer. The receipt agrees
with the source on supautils 3.4.4, pg_graphql 1.6.2 and PostgreSQL 17.11.
The source descends from the fixes in
[supautils 3.4.2](https://github.com/supabase/supautils/releases/tag/v3.4.2).
The binary exposes no plain version string; version attribution uses source
and image receipt, not the image tag. Registry-attached provenance is unsigned
and hash-verified; this is not authenticated provenance or a reproduced build.

The same layer's pg_graphql 1.6.2 SQL has the exact reviewed
`graphql.increment_schema_version()` body hash from #186. Do not expand that
allowlist to accommodate a changed platform body. Static equality does not prove
the complete migrated runtime catalog or Storage reader ownership. The candidate
[upstream migration disables pg_graphql by default](https://github.com/supabase/postgres/blob/d8666db883fd1bc3bc06654c8db1f8dc39812b82/migrations/db/migrations/20260421000000_pg_graphql-off-by-default.sql);
bundled extension SQL does not mean the extension is installed. Integration tests
must exercise unsafe definer detection through explicit rollback-only fixtures,
without requiring removed platform helpers or enabling unused extensions in
runtime startup.

The CI action first pulls the reviewed digest and seeds the pinned CLI's cached
default tag on `ghcr.io`; the index and amd64 manifest bytes match the
qualified upstream image. It checks the running container's config digest and
architecture before repository migration/seed. The guard refuses startup
repository SQL paths, including `supabase/migrations` and `supabase/seed.sql`,
because the CLI would execute them before the post-start check. Upstream platform
bootstrap still runs during CLI startup. A changed CLI, linked-project override, reused database,
wrong content or wrong architecture fails closed. No unsupported digest string
is written into the CLI's version file. The isolated GitHub jobs must still
prove full migration replay, `runtime-role.mjs check`/RLS probes, Storage reader
integration, login/JWKS, actual API/web image smoke and E2E on this candidate.
No local mock or historical #185 result substitutes for these checks.
The PostgreSQL 17.6-to-17.11 move also requires the unchanged 57 CHECK and three
FK definition pins to pass against the actual migrated candidate catalog under
[runbook 05](05-rotation.md); static source comparison alone is insufficient.

The earlier 3.4.0 image acceptance and packet-01 remain withdrawn. The replacement
candidate, final-source CI/Integration/E2E and independent reviews were accepted
for #187 and consumed packet-02. Preserve both packets unchanged; do not generate
another R2 packet for the already-created resources. Before bootstrap, qualify the complete QA composition
on a separately authorized disposable target; CI's service composition is not
the QA composition. Any unavailable proof remains an explicit gate. Never run
the crash regression on a live/shared database. A private isolated regression
needs its own disposable target and must show a refused statement with stable
connections. Only Claude Code/the owner may upgrade the shared local CLI/stack.

### Q1-Q3 design freeze and R2 preparation

Q1 reconciles the recorded R1 operation above; it does not convert the historical
2026-10-15 observations into current evidence. Follow [runbook 00](00-session.md)
session hygiene, then check the existing authenticated account against the
original private contract before querying resources. Never print secret values,
state contents or provider diagnostics. An unavailable login or inaccessible
resource is an evidence gap, not an empty inventory or an authorization to change
accounts, initialize a backend or relax policy. Record current results and their
timestamps in the private packet and sanitized B9 PR handoff, not a new ledger.

Reconcile current old-VM power state, exact containment rules, all three retained
disks/attachments, NIC/subnets, both IPs, vault protections and three locks.
Compare the original contract and existing backend/default workspace; the last
recorded state had fifteen owned IDs, unchanged lineage and serial 11. Require a
fresh controlled ownership projection and state hash before planning; neither
cached backend metadata nor ARM IDs prove state ownership. A later serial is a
change to investigate, not a reason to force it back to 11. Preserve the old
active output and reserved delegated apps subnet. Recheck Sweden SKU/image
availability and family/regional quota. On 2026-10-18 the owner reported a $5,000
credit balance for planning and deferred documentary balance/expiry verification
for internal QA. Record this as an owner-reported assumption, not an independently
verified balance or a spending cap. The observed enabled/sponsored subscription
does not establish balance, expiry or credit eligibility; revisit before production.

The following are design requirements for the later backup/recovery package.
The owner deferred the remaining detailed decisions for internal QA on 2026-10-18;
they do not block the isolated R2 foundation. Record and resolve them before
production. None creates resources or broadens R2's ten-create/one-subnet-update allowlist.
The [Azure delivery plan, recovery track](../../docs/roadmap_docs/Azure_roadmap_plan.md#5-recovery-track-independent-workload-and-measurable-acceptance)
sets the later implementation/review/apply sequence.

| Boundary | Required frozen input and writer |
| --- | --- |
| Resource ownership | A future `selfhost-backup` writer has separate state/contracts for QA and production storage accounts, containers, retention, endpoint/DNS and backup RBAC. RI in SC1 or Codex in SC2 needs named file reservations first. Selfhost alone owns VNet/subnet/NSG writes; backup DNS is not also managed by application foundation. No second subnet writer, implicit state adoption or backup resource in R2. |
| Private path | Reserve a nondelegated endpoint subnet and exact endpoint IPs in the existing VNet, outside old `10.80.0.0/24`, r02 `10.80.1.0/24` and apps `10.80.2.0/23`. Owner freeze must name the collision-checked CIDR, endpoint IDs and DNS link owner. Only a later selfhost packet adds the subnet/network policy; a later backup packet creates the Blob endpoint. Preserve default-deny and old/new isolation. |
| Traffic and DNS | The later network manifest permits capture/recovery host -> exact Blob private endpoint TCP 443, with explicit DNS resolver and identity-token/platform dependencies. Bind approved operator private access and test DNS/TLS from that vantage. Resolve the account's normal Blob hostname privately via `privatelink.blob.core.windows.net`; do not use a guessed S3 URL. Disable storage public network access separately from creating the endpoint. [Azure private endpoint behavior](https://learn.microsoft.com/en-us/azure/storage/common/storage-private-endpoints). |
| Sweden retention | Separate Sweden Central backup accounts, encrypted transport/storage, public blobs/shared-key access disabled. Owner selects redundancy within approved residency, capacity/cost, retention days and soft-delete/versioning policy compatible with the chosen capture format. Require locked time-based immutability before accepting captures; test format/retention first in the separately reviewed foundation packet. No mutable overwrite/garbage-collection dependency may undermine recovery. A locked policy cannot simply be shortened or removed; owner approval must name that consequence. [Azure immutability](https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-storage-overview). |
| Backup identities | Separate capture and restore/operator identities from API/web/deployer principals. Capture gets only scoped operations required by the validated upload protocol; no delete, retention-policy, key-listing or role-assignment capability. Restore gets scoped read plus separately approved target-host rights. Foundation administration owns retention/RBAC. Freeze exact role actions/scopes and prove denied deletion, public access, QA-to-production and app-to-backup access; a broad built-in role is not presumed sufficient. |
| Custody | Name primary and backup custodians, eligible recovery-vault access, activation/alert route and private access independent of one home IP. Bind exact escrow versions, encryption material, source/image/host generations and restore manifests. Loss of the source host must not lose the only decryption key or operator instructions. Backup storage is separate from the existing Key Vault escrow; existing same-VM restore is not full-host recovery. |
| Loss and proof | Target full VM/OS/database/object-disk loss, not merely `.env` loss: fresh disks/new host generation, old host fenced and retained, no source disk used to restore. Capture DB base/WAL, evidence/import bytes, configuration/escrow and encrypted Caddy TLS/account state. Bind a consistent recovery point, checksums and reclamation hold; preserve approved origins/images through an explicitly reviewed IP/DNS/identity cutover. Regional/subscription loss is outside this target and needs separate owner acceptance/design. |

Before freezing this table, the owner must accept or revise the same-closed-
environment maintenance drill and reconcile it with canonical isolated-restore
and fresh-recreation wording. RPO <=15 minutes and RTO <=4 hours remain measured
requirements: two timed drills with independent DB/object markers, login,
download/hash, audit/seal and report reconciliation. Existing `wal-g.conf`, disk
retention and Key Vault escrow do not implement that capture/recovery system.
Disabled VM extensions and deny-all outbound rules exclude assuming VM Backup
or an agent can simply be enabled. These are later BF/REC packages, not R3/R4
implementation in Q1-Q3.

Owner dependencies: choose SMTP processor/DPA, domain/DNS and verified sender
controls (SPF/DKIM/DMARC); reserve pen-test **and retest** by the plan's 10-30 target
(11-13 hard stop); name SC1's recovery implementer/capacity/reserved files by
10-26 or select SC2. Name backup custodian/operator and the independent human
approver. Preparation does not contact vendors, book services or accept these
decisions for the owner.

Owner direction accepted on 2026-10-18: reserve `10.80.4.0/27` for later nondelegated
backup endpoints, subject to live VNet/peering/route and state collision checks;
freeze exact endpoint IPs/IDs privately after that check. Use separate Sweden
Central ZRS accounts and 30-day locked retention, with immutable uniquely named
captures and a tested base/WAL dependency hold before reclamation. ZRS stays in
the primary region but does not cover regional loss
([redundancy behavior](https://learn.microsoft.com/en-us/azure/storage/common/storage-redundancy)).
The backup foundation must qualify the upload format against immutability before
locking; decide compatible soft-delete/versioning and cost there, not by guessing
that a mutable WAL-G layout works. The owner accepted the separate QA/production
storage/state and writer boundaries above, including that locked retention cannot
subsequently be shortened. Exact protocol, RBAC, IPs and custody remain to freeze;
this direction does not authorize creating or locking storage.

The owner declined a VPN for QA on 2026-10-18; reconsider private access before
production. Keep the bounded operator `/32` strict-SSH management proposal for
the future replacement; verify private DNS/TLS from an explicitly approved VNet
host after bootstrap. An operator's laptop is not a qualified private vantage
merely because SSH works. Do not start the retained VM to obtain that vantage.
For internal QA, the owner explicitly deferred additional custody, independent
recovery access and staffing decisions until production preparation. Keep these
as open follow-ups, not additional R2 prerequisites; this does not widen SSH,
change existing containment/tenant controls or approve R2 apply. Primary/backup
custodians, the independent human recovery approver and recovery implementer
remain unnamed. Propose two isolated fresh-host restores while the old host stays
fenced, preserving the full-host-loss target above; reconcile the canonical drill
wording when the later recovery package is frozen. Full Q3 recovery acceptance
remains open; the internal-QA scope decision is not proof of recoverability.

Historical packet-02 preparation procedure (already completed; do not execute again):

1. Use the final reviewed clean source commit, exact executor/source hashes,
   Terraform 1.13.3 and reviewed provider lock. Restore the existing authenticated
   session and verify its tenant/subscription; use original backend/config inputs,
   containment true, r02 values and an independent SSH public key. Do not copy
   examples over existing inputs or initialize/reconfigure state.
2. Attach the R2-specific frozen inputs, the internal-QA deferrals above and
   current R1 readback. Verify the
   existing backend/default workspace and controlled state ownership projection;
   freshly check every proposed resource ID, vault/DNS name and accessible state.
   The owner attests the relevant state inventory, including inaccessible states.
3. Run `prepare --phase R2` into a new private packet directory. It is a planning
   operation with Terraform's normal state locking; it does not authorize apply.
   Reject **every nonempty `resource_drift`** under the current policy. If observed,
   privately inspect exact address/action/before/after and request independent
   review of any narrowly justified exception, then generate another plan. Never
   infer a power-state-only change from the old deallocation record.
4. Independently review the binary projection, full resource allowlist and all
   source/input/tool/backend/account/state bindings, including before/after
   stability. Bind the final executor SHA256 and every mutating argv/target in
   the operation manifest. Any changed binding needs a new packet/review.
5. Obtain explicit owner approval of that manifest and saved-plan binding within
   the two-hour lifetime, with a durable terminal-independent session, no outer
   hard-kill timeout, preservation/readback steps and the partial-recovery stop
   rule. R2 is Q4's separate action. This preparation never invokes apply.

Q1/Q3 are not fully accepted while their current evidence and recovery design
requirements remain open. Under the owner's internal-QA scope decision, the
deferred credit/custody/backup details do not block isolated R2 preparation;
exact R2 ownership, collision, image and saved-plan review still apply. Local N2
verification closes only its implementation/test requirement; it cannot approve
an R2 packet, complete PD-3 or promote LP2-01/02/03 from INTEGRATED.

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

The old VM remains deallocated. If fresh read-only reconciliation finds drift,
stop and prepare a separately scoped repair proposal; consumed packet-02 is not
a repair path and must never be regenerated or replayed.

### Remaining bootstrap and probe gates

The initial r02 NSG denies all outbound traffic. R3 now has local pinned artifact, transfer and offline toolchain-install
preparation above. The complete install/source/image-transfer sequence still needs
disposable qualification, independent review and exact owner approval. Temporary
egress tooling is not implemented or authorized.

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

## Native Noble fixture (A)

This is a preparation and diagnostic mechanism, not execution authority or an
installed-target receipt. The accepted order remains R3 → R4 → Sweden application
foundation → API/web deployment → QA acceptance. Azure guest inventory is a
separate packet B with a separate approval. Customer data is excluded.

### Exact execution proposal

After publication is separately requested, prepare the owner approval from the
actual published commit and workflow ref. Bind `source_sha`, selected branch ref,
`r3-native-noble.yml` and all `r3_noble_*`/reused helper hashes, both lock hashes,
the normalized recipient SHA256 and public-key fingerprint, repository, job
`native-noble`, runner `ubuntu-24.04`/Linux/X64/GitHub-hosted, and the proposed
single dispatch. No earlier SHA's review/test/approval is transferred. The
controller verifies checkout HEAD, every tracked blob (including hidden index
flags), the complete clean worktree, workflow SHA/ref, and attempt 1 before any
runner package mutation; it rechecks source before and after the VM. Reusing an
attempt marker or rerunning a job refuses. An approval ledger must also prohibit
a second fresh dispatch: a new run ID is not itself new authorization.

The workflow has `contents: read` only, no OIDC, environment secrets or persisted
checkout credentials, and a 50-minute job timeout. Its sole controller command is
`python3 -I -B infra/scripts/r3_noble_fixture.py`; dispatch inputs pass through
environment values rather than shell interpolation. The controller strips the
inherited environment before child commands. The job does not invoke Azure,
SSH, production helpers, shared Supabase, or the legacy install shell.

The exact argv builders and bounded phases are in `r3_noble_fixture.py`,
`r3_noble_inputs.py`, `r3_noble_guest.py`, and the staged fixture-only
`r3_noble_identity.py`. The approval must bind their
exact argv templates and public input hashes. Allowed runtime substitutions are
the GitHub run ID, runner temporary root and newly allocated private work directory;
retain the actual expanded argv and paths in run evidence:

- Encryption setup: pinned age archive, version verification and public recipient
  validation (120-second staging budget). The key is a public SSH RSA/Ed25519
  recipient with no comment; its normalized two fields plus newline must match
  `recipient_sha256`. No private key is uploaded or read by this job.
- Runner preparation: `sudo -n apt-get update` (180 seconds), then
  `sudo -n apt-get --yes --no-install-recommends install` with the three exact
  name/version pairs in `r3-noble-fixture.lock.json` (300 seconds). Capture before/
  after runner inventories, actual versions and streams. Normal runner-tool
  dependencies are recorded separately; they are not the guest five-pin plan.
  Missing/retired pins refuse; no fallback version or automatic retry. Privileged
  runner APT groups require privileged kill/reap on interruption. This is never
  run on the owner's machine.
- Public input staging (600 seconds plus bounded verification commands): dated
  Canonical Noble amd64 image and manifest with pinned SHA256s, signed checksum
  verification against the pinned Canonical key, and the existing five Docker
  package pins authenticated by the signed vendor index. The actual signed
  metadata bytes are retained. No target bundle, Node archive, private database,
  container image transport or customer input is imported.
- ISO preparation and QEMU: read-only input ISO plus NoCloud seed, actual boot
  file hashes and rereads, qcow2 format/no-backing check, disposable 16 GiB overlay;
  `q35,accel=tcg`, 2 CPUs, 4096 MiB, fixed fixture UUID, `-nic none`, no monitor,
  host mounts or Docker socket. No assumption that the hosted runner already
  contains QEMU. Native VM deadline 1200 seconds. QEMU group is killed/reaped on
  completion, error or deadline. Detached-child interruption remains an open
  qualification question; a process-group kill is not a universal containment
  claim.
- Guest: root only in that fixture UUID, read-only ISO, Ubuntu 24.04 amd64,
  observed systemd PID 1 and executable hashes. Capture package versions,
  dependency/provides fields, configuration/hook/path-exclusion bytes, man-db
  trigger registry/script, package payload lists, unit/process observations and
  native lock probes. Initial audit and exact-pin absence precede simulation.
  Use unchanged production `install_argv` (`Dpkg::Use-Pty=0`) and the same strict
  simulation/inventory/transaction parsers. No apt unit, hook, trigger or package
  policy is disabled or rewritten. Diagnostic unit observations allow stable
  original unit configuration but refuse jobs, foreign package writers and
  changes; this does **not** satisfy production's persistently masked-unit gate.
- One native APT install is possible only after the strict simulation and
  pre-execute inventory pass. Installation timeout 360 seconds; full guest phase
  deadline 900 seconds. Retain actual stdout/stderr and dedicated dpkg log.
  Capture after inventory/audit before transaction validation. Holds occur only
  if the strict five-pin transaction passes; final inventory permits only those
  five hold transitions. On refusal, no holds/completion receipt; bounded actual
  after/final snapshots are attempted, with missing steps explicitly recorded.
  Failure recovery reserves 120 seconds for commands and 60 for export.

An already-decided initial baseline `Foreign fixture package writer` refusal
attempts one optional `baseline-refusal-identity.json` before the result file
hashes are finalized. It preserves the original refusal and does not reach
simulation, installation or holds. There is no capture on the normal path or
for later/pending-unit refusals. Missing, reused, exited, unreadable, changed or
truncated observations remain explicit; the snapshot cannot prove continuous
inactivity or establish an exemption from the existing process guard.
This capture requires a successfully returned and appended observation. A writer
holding a probed package lock can cause `probe_locks` to fail before that point;
such a refusal gets no identity snapshot. This is not a complete writer census.

The snapshot reads only the first 16 already-observed PIDs, preserving the
original observation separately and recording the omitted count. It brackets
bounded stat/cmdline (4 KiB)/cgroup (16 KiB)/exe-link reads with PID/start-time
checks. It records the executable link, never follows its dynamic target, and
does not read process environments. One `systemctl show unattended-upgrades.service
--no-pager --property=MainPID,ControlGroup,InvocationID,ExecStart,FragmentPath,DropInPaths`
query retains its argv, exit and bounded streams (16 KiB each) privately, with
a two-second query timeout and reserved cleanup time. Reported drop-in/argv
paths are not opened; nonempty drop-ins remain an effective-unit evidence gap.

Only three fixed regular-file paths may supply content/hash and ownership/mode
metadata: `/usr/share/unattended-upgrades/unattended-upgrade-shutdown`,
`/usr/bin/unattended-upgrade`, and
`/usr/lib/systemd/system/unattended-upgrades.service`. Intermediate and final
symlinks and special files refuse. Scripts have a 1 MiB individual cap, the
unit a 128 KiB cap, and the combined fixed-file payload a 1 MiB cap. Before/after
metadata differences are recorded, not treated as immutable content proof.
All byte strings use base64 and SHA256; no arbitrary observed path is executed.

Collection, serialization and atomic no-overwrite retention use a ten-second
deadline within the existing failure-command budget, without extending the
guest/job limit or export reserve. Native scheduling and interrupted cleanup
still need qualification; local timeout tests are not a universal real-time
guarantee. Errors/interruption preserve the original refusal and
are recorded in `checks.refusal_identity`; an incomplete snapshot is never
published as a complete file. An error record does not mean the snapshot is
absent: cleanup or a deadline after atomic linking can leave a complete,
hash-bound member alongside the error. Read the member list and verify its
hashes independently; the host does not cross-check that error record against
member presence. The serialized snapshot is capped at 2 MiB on
both collection and host readback. It is an optional allowed refusal member,
not a required success member; successful evidence forbids it, while older
evidence without it stays readable. It is hash-bound inside the native frame
and follows the existing encryption-only custody route, never public upload.

### Evidence and stop conditions

Raw guest evidence travels over a dedicated virtio serial channel with a bounded
write-all frame, size and SHA256. Host validation allows only fixed regular tar
members, checks source/input/run correspondence and file hashes, and recomputes
successful simulation, inventory, transaction and holds checks from retained
bytes. It never extracts a guest archive onto the host. Serial output, native
configuration, inventories, transaction streams, runner preparation logs, source
manifest, signed metadata, boot hashes and failure records stay in the encrypted
private archive. No raw diagnostic paths are in the upload allowlist.

Only `fixture-evidence.tar.age`, `binding.json`, and `summary.json` may be uploaded,
with seven-day retention. The public binding contains source/ref/workflow/lock,
run/attempt/job and recipient hashes. The public summary distinguishes refused,
sealed and review-required states. A seal failure removes partial ciphertext;
there is no plaintext fallback. Cancellation/hard runner termination can prevent
final sealing/upload entirely. Such a run is partial/unknown and consumed; no
automatic retry or assertion of complete evidence.

Before expiry, download once into a **new private evidence directory**, verify
public binding against owner approval and GitHub run API readback (run ID,
attempt, head SHA, workflow ref/job/conclusion and artifact identity), rehash the
ciphertext, and preserve that readback. Owner-controlled decryption must use the
already-approved key and separately available tooling; do not install tooling or
read the private key during preparation. Compare decrypted archive and retention
manifest hashes with the public summary, validate all retained file hashes and
native frame correspondence, and independently review failures and actual
native results. Do not extract arbitrary tar paths; validate regular-file names
before any extraction. Record any unavailable decryption/readback as an open gate.

CL-P2-3 remains open even if this workflow succeeds. The diagnostic provides real
Noble APT/dpkg behavior, man payloads, trigger interests/hooks and the actual
transaction for review. A strict simulation refusal may prevent installation;
retain it without widening grammar or forcing progress. A man-db transaction
refusal after installation demonstrates the existing risk in a disposable VM;
it does not authorize accepting that trigger on Azure. Target dependency closure
requires separately approved B evidence from the exact Azure image/VM, complete
native dependency resolution and reviewed isolation/trigger policy. Hosted runner
or fixture inventories cannot substitute. Retain all other R3 gates and P3
questions, including sampled-writer limits, lifecycle ordering, log rereads,
content correspondence and detached children. Bootstrap stays
`NOT_READY_FOR_BOOTSTRAP_APPROVAL`.


## Opt-in maintenance installation policy (R3-POLICY-01)

The owner approved design/implementation of this revision on 2026-10-23. That
approval changes the earlier prohibition on service-state changes for a declared
five-unit maintenance phase and the blanket rejection of all non-pin trigger
records. It does not approve publication, workflow dispatch, SSH/guest execution,
Azure mutation or deployment. Previous A attempts stay consumed/refused; old B
remains separately bound, unapproved and unexecuted. Native triggers stay enabled.

`r3_install_policy.py` accepts only explicit hash-bound format-1 policy data with
purpose `R3_MAINTENANCE_INSTALL`. Its complete key set is `format`, `purpose`,
`toolchain_sha256`, `inventory_sha256`, `apt_config_sha256`, `unit_config_sha256`,
`facts_sha256`, `cache_before_sha256`, `review_sha256`, and `triggers`. The inventory
hash is over canonical JSON of the parsed full inventory; effective APT and
`systemctl cat` output hashes are over exact bytes. Facts include the complete
fixed configuration directory membership and guarded files' hashes, lengths,
ownership/modes, plus the PackageKit activation predicate. No symlink ancestors
are accepted. Cache baseline is likewise canonical JSON, bounded in size/count.
A missing or different datum refuses before the first service mutation.

Only one trigger identity is currently supported: an already-installed
`man-db:amd64` at the explicitly reviewed version. It carries
`effects_review_sha256` and `effects`: exact cache-relative paths mapped to
`action` (`added`, `changed`, `removed`), `kind` (`file`, `directory`), `uid`, `gid`,
`mode`, and `max_bytes`. No glob, executable cache file, wildcard trigger or
on-the-fly learning is supported. All expected deltas must occur and no other
delta may occur. The pending/processing/half-configured/installed trigger sequence
must occur once, in order, within the five-pin unpack/configure transaction.
Unknown actions, timestamps moving backwards, identities, versions or incomplete
states refuse. The original `transaction(text, lock)` still rejects non-pin records.

A review hash is a binding to separately retained review, not a proof that someone
reviewed it. No executable fixture/target policy is shipped here. The retained A
snapshot is insufficient to produce one: mandb/config/helper closure, actual
cache effects and conditional APT hooks remain to be qualified. The PackageKit
activation predicate (option C, [R3-POLICY-01-C1](#r3-policy-01-c1-shared-packagekit-state-option-c))
currently refuses even if a policy hash matches; this code does not disable that hook, stop a sixth service,
or exempt packagekitd from foreign-writer checks. Only the literal `False` passes the
gate. The D-Bus socket has one reader, `r3_policy_capture.socket_record` (`/run/dbus`
opened without following links, the socket lstat'd and required to be a socket),
shared by the installer and the collector (PR-C0, PR-C1). Needrestart, update-notifier,
dpkg-preconfigure and other effective hooks need explicit review as well. Historical
B omits effective hook/path-exclusion bodies and must be extended/reviewed in a new
private packet before claiming those facts. Do not silently rebind old B.

`r3_maintenance.py` only enters isolation. It records an exclusive intent, original
unit state and any precisely identified shutdown helper. That identity permits a
normal service stop, never an exemption during installation. It persistently masks
only the five enumerated package-manager units, stops their timers, then rechecks
jobs/processes/locks and full inventory immediately before stopping services.
Actual/pending package work refuses before service stop. A final observation must
show all five masked/inactive with no writer/job, idle native locks and unchanged
inventory. Commands and callback budgets share the deadline; completion after
expiry is refused. No lock deletion, forced writer kill, package repair, unrelated
service change or automatic unmask is performed. A failed stop may leave a systemd
job pending; retain masks/journal and inspect, never infer cancellation from the
local systemctl process ending. Blocking proc reads remain a qualification limit,
not a hard real-time guarantee.

The original workflow mode is unchanged when both optional inputs are empty.
For the new mode, `installation_policy` is exact **public fixture-only JSON** and
`installation_policy_sha256` is the SHA256 of those exact UTF-8 bytes (including
any newline). These are public dispatch fields, not a channel for target secrets
or private configuration bodies. The policy is checked before runner mutation,
carried on the read-only ISO, and bound by manifest purpose
`FIXTURE_MAINTENANCE_ONLY`. Raw observations remain inside owner encryption.
Required private members add policy/facts/cache records, maintenance intent,
pre-stop/final/completion records and all command streams/argv/exit records. The
controller rechecks policy bindings, isolation, exact maintenance argv, inventories,
lock-probe correspondence, trigger chronology and cache deltas. A result remains
`DIAGNOSTIC_PASS_REVIEW_REQUIRED`, `target_qualified=false`, `qa_ready=false`.
Neither JSON checks nor cache-local observations prove global filesystem confinement.
Independent review of actual script behavior and other effects remains mandatory.

Target installation is explicit opt-in: `r3_transfer.py --policy <private-file>`
adds a separate `maintenance-policy.json` member beside the verified `r3/` bundle
and proposes `r3_install.py ... --policy /var/lib/tonyai-r3/maintenance-policy.json`.
The transfer proposal remains `NOT_EXECUTABLE_APPROVAL`. Format-3 approval changes
the action to `r02-maintenance-toolchain-install`, binds `policy_sha256` and the
six additional helper byte hashes (`r3_install_policy.py`, `r3_packagekit_state.py`,
`r3_policy_capture.py`, `r3_maintenance.py`, `r3_noble_common.py`, `r3_noble_identity.py`;
every module the policy path imports), besides all existing source/contract
bindings. Format-2 approval cannot select this path. The receipt is format 3 and
retains policy/config/cache/isolation evidence. Five additions and final holds,
unchanged pre-existing final inventory and clean audits are still required.

This package implements isolation entry and policy/evidence enforcement. It does
not implement or authorize the separate release/unmask/reboot stage, nor qualify
it from local mocks. Before target execution, qualify that lifecycle together with
native transaction, Engine/Compose/store, dependencies, empty-store registry-denied
image transport, nine services, private DB stable-session regression, Realtime
source/GCM, installed source/modes/identity and custody. All retained P3 findings,
CL-P2-3 and the delivery order remain; bootstrap is
`NOT_READY_FOR_BOOTSTRAP_APPROVAL`. Never dispatch the unchanged old A just to
rediscover helper identity, and never interpret this development decision as a
new execution approval.

### R3-POLICY-01-C1: shared PackageKit state (option C)

Option C (owner decision 2026-10-25) keeps the hook and the writer guard and instead
requires a separately approved, persistent `systemctl mask packagekit.service` plus a
proof-bound non-activation predicate. PR-C1 adds only the predicate side,
`infra/scripts/r3_packagekit_state.py`; the mask step is PR-C2.

- **One domain.** `observe()` returns raw sections in the collector's shape: no-follow
  reads plus exactly three fixed commands (`systemctl show` of the seven PackageKit and
  D-Bus units, `systemctl show --property=UnitPath,Version`, one `dpkg-query -W`). It never
  contacts `org.freedesktop.PackageKit`, never opens or connects a socket and never runs
  gdbus, busctl, pkcon or systemd-run (`systemctl show` itself queries PID1). `normalize()`
  keeps boot-invariant values and derived booleans and `evaluate()` is the only predicate:
  the validator (`raw_from_sections`) computes `evaluate(normalize(raw))`, and the installer
  and A guest (`r3_install_policy.facts_state`) normalize the same raw and will evaluate it at
  the gate once PR-C2 wires it. `volatile()` holds a first
  part of the continuity baseline (the PackageKit unit's invocation data, dbus' PID and start,
  the listener and socket identity, the boot time); PR-C2 completes design03 2.6's list and
  adds the controller's re-check of retained raw.
- **Result.** `False` only when every conjunct C1-C16 holds against `REVIEWED`; `True`
  when the registration is present and a conjunct fails; `None` otherwise, including an
  absent registration (NOT_C_BASELINE, D2) and an undischarged obligation (O10's gdbus
  half, an O13 mode other than the ctime rule), which forces `None` even when a conjunct
  fails (G7). `False` is proof-bound non-activation, never a claim that activation is
  impossible.
- **Reviewed values** are compile-time literals in the module, bound by its hash in every
  approval; a policy, facts or review hash cannot supply or widen them. Source facts are
  global; everything derived from a host's packages is per target (QA M2): a host uses the
  one profile whose code identity (its dpkg rows without kernel images, and systemd's
  Version) equals its own, `pk_core` names it, and a host without a reviewed profile is
  collected `DISCOVERY_ONLY`. Profiles have exact key sets, a kernel row naming their kernel and
  pairwise distinct code identities; targets that share one code identity share one profile
  with their reviewed allowances merged (`profile_errors`). The validator decides
  `DISCOVERY_ONLY` from its own selection over the document's package and manager sections,
  never from the document's declared mode alone. As shipped `o10_ok` is false and no profile
  exists.
- **Not wired to the gate.** `r3_install_policy.PACKAGEKIT_GATE_WIRED` is `False`: the
  installer's facts carry `None` on every host whatever the reviewed values say, so a filled
  `REVIEWED` (PR-C1b) cannot pass preflight before PR-C2's mask-record, continuity and
  phase checks exist. **PR-C1 makes no host eligible; hosts the legacy predicate admitted
  (no registration, or a registration but no bus socket) now refuse.** The gate itself is
  unchanged (`is not False`).
- **Facts** are files, directories, the predicate and `packagekit` = `pk_core`,
  `c13_verdict`, `unit_universe_digest` and `proof_id`. The digest covers the stable admin
  and package unit roots only; `/run` roots and snap-generated units are left out (QA M1),
  while the C13 verdict covers every root. Legacy facts lack `packagekit` and never
  hash-equal C facts. `mask_invariants_v1` is built from its own literals and pinned by a
  golden digest; a record is checked through `MASK_INVARIANTS[format]`.
- **Recorded deviations from design03, for review** (each fail-closed or stricter):
  - C5 permits the package's own `/usr/lib/systemd/system/packagekit.service` as a regular
    file (the `/etc` mask shadows it, O14) and C13 binds its bytes; C5 and C14 also name the
    template, alias and type-level drop-in candidates (O14 gaps), C7 checks `dbus.service.d`
    at every root, C14 requires the three trigger units `not-found`, and C16 also checks
    `/etc/system-update`.
  - An absent bus socket gives `None`, not `True`.
  - C12 binds the dpkg rows of `dbus*`, `libdbus-1-3*`, `systemd`, `systemd-sysv`,
    `libsystemd-shared`, `libsystemd0*`, `libglib2.0*`, `packagekit*`,
    `init-system-helpers` and `needrestart`, and only the running kernel's
    `linux-image-<release>` row and release (security H2); other installed kernels are
    not code identity.
  - C15 uses only the ctime rule (O13 proved `reload_on_lookup` fails for this build), also
    against dbus.service's recorded `ExecMainStartTimestamp` (H2, hence `--timestamp=unix`),
    and its path set includes the parents `/usr/share/dbus-1`, `/etc/dbus-1`,
    `/usr/local/share/dbus-1` and `/usr/lib/dbus-1`.
  - C13: a symlink must resolve to a classified in-root entry or a reviewed literal (H1);
    a target containing `..` resolves only as `../<name>` from a scanned directory, since
    systemd follows links before `..`. Packaged units are bound by SHA256 where the index has
    it and by dpkg MD5 otherwise (H4). A non-packaged unit is an activator if its body or its
    name contains `packagekit` (any case; stricter than `Exec*=`/`BusName=` only), and not
    classifiable if an `Exec*=` value uses specifiers, variables, globs or a shell `-c` flag
    (alone or combined, such as `-ec`); quotes are dropped before the name scan. Every member
    body of the service and configuration directories is read (not only reviewed ones), and
    the scan adds `/run/user/0/dbus-1/services` and `/var/lib/snapd/desktop/systemd/user`.
  - Per-section caps replace design03 4.1's 512-record collector counter.
- **Open design items before PR-C1b** (owner or security decision): a packaged,
  PackageKit-named symlink such as an offline-update `system-update.target.wants` link
  always gives C13 `True` (design03 C13(b)), so a stock host could never be `False` if the
  package ships one (to be checked against the packagekit .deb); `pk-mask-record` arrives
  with PR-C2 as evidence document format 4, and format 3 stays frozen; PR-C2 replaces the
  installer's and guest's plain `facts() == policy_facts` re-checks with the baseline-aware,
  phase-aware compare and retains each phase's full projected universe (QA M3), because the
  isolation masks, the Docker masks and the pinned unit files all change the stable-root
  digest.
- **Named residuals:** C13 scans names and literal programs, so a packagekitd started under
  another name or through an indirection the scan cannot see stays with the C11 process scan
  (O11); the C10 listener rows come from dbus' own network namespace (O16); md5sums lines
  outside the reviewed set are ignored and a missing one gives `None`.
- **Unchanged and still forbidden.** Nothing here creates, alters or removes a PackageKit
  mask: no mask step, no stop, no unmask; the installer and `r3_maintenance` never touch
  `packagekit.service`. MANAGERS, UNITS, FIXED and `r3_maintenance` are unchanged. The mask
  helper and purposes, approval format 4, the gate wiring, continuity sampling, the
  phase-aware (R1) re-evaluation, the completion-record check, `pk-mask-record` and the H5
  run-history binding are PR-C2.


## Collection-only policy evidence (A and B)

`R3_POLICY_EVIDENCE_COLLECTION` closes the tooling gap before installation-policy
construction. It does not modify R3-POLICY-01 or manufacture a reviewed policy.
The maintenance guest still preflights before isolation; callers must not guess
policy hashes to collect a baseline. Historical A approvals remain consumed and
historical B remains prepared/unapproved/unexecuted at its original source.

### Shared bounded contract

`r3_policy_evidence.py` collects a format-3 private document (formats 1 and 2 remain
valid for older evidence; see the snap alias paragraph and option C below) with exact purpose,
binding, sections, and explicit false qualification/installation/policy flags.
`r3_policy_validate.py` independently checks every section, fixed argv, stream
length/hash, file metadata/body hash, directory membership, cache structure and
source/purpose binding. JSON duplicate keys, unknown fields/sections, unsafe paths,
oversized records and incomplete correspondences cannot pass. Every section is
`ok`, `error`, or `not_reached`; command failure and dirty audit are partial.
Known directory members disappearing between listing and read are errors. The
collector checkpoints before deciding completeness; errors retain prior sections.
A validator rejection preserves the captured bytes privately for diagnosis.

The fixed commands are full dpkg inventory/audit, architecture,
effective `apt-config dump`, five-unit `systemctl cat`, and five-unit fragment/path
queries before/after. Public OS release is a bounded direct file record. There is no arbitrary command/path input. The fixed files
match current installation-policy facts; extra native hook executables are separate
review evidence and do not alter the canonical policy facts hash. Exact names
observed in historical fixture A informed the read allowlist, including the
fixture's kernel trigger filename. This is read-scope review, not fresh evidence
or acceptance of hook effects. Unknown names remain `UNREVIEWED_PATH`; extending
the scope requires code review, never automatic discovery of credential files.
One reviewed pattern exists (owner decision 2026-10-25): in
`/var/lib/dpkg/triggers`, `linux-update-<version>` (an exact
`major.minor.patch-abi-flavour` version) is read only when the same document's
inventory records `linux-image-<version>` as `install ok installed`; a failed or
malformed inventory reviews no kernel. The collector and the validator share
`reviewed_member`, so a read record for any other kernel is refused as a forgery.
This keeps a target's own kernel trigger-interest file in scope across kernel
updates without accepting any other name.

Raw bodies are limited to 128 KiB each for fixed native config/scripts and reviewed
directory members. Binary guard files are hashed within an 8 MiB limit. Directory
membership is bounded to 256 entries; man cache is bounded to 4096 entries and
32 MiB of hashed file bytes. Command streams are bounded to 2 MiB each and 30
seconds, collection to a 240-second budget with an outer 300-second deadline.
The document cap is 24 MiB. Descriptor-relative reads reject symlinks, hardlinks,
non-regular files, changed metadata/content and oversized input. The D-Bus socket
is only inspected, never opened. The PackageKit predicate is reported as true, false or
unknown; anything but false remains an installer eligibility blocker. No hook
suppression, sixth-service stop or writer exemption is added.

Format 3 (option C, [R3-POLICY-01-C1](#r3-policy-01-c1-shared-packagekit-state-option-c))
adds the shared PackageKit sections - `pk-units`, `manager`, `pk-package-metadata`,
`link:` (the mask path, `/var/run`, `/lib`), `dir-meta:/var`, `device:/dev/null`,
`dbus-socket`, `unit-candidates`, `unit-universe`, `dpkg-md5sums`, `pk-fragments`,
`dbus-service-dirs`, `dbus-config`, `dbus-daemon-proc`, `pk-binaries`, `pk-processes` -
plus `pk-units-after` (the unit block read again and compared field by field) and
`pk-dpkg-index` (a discovery index, never a read list or a completeness input). Each
file-backed section is re-read for drift; `dbus-daemon-proc` compares only its process
identity. Caps are module literals (unit roots: 2048 entries each, 128 bodies of at most
64 KiB and 8 MiB in all, 4096 packaged hashes, depth 1; md5sums 16 MiB and 512 files);
an overflow is an error section, never truncation. Without a reviewed packaged-unit
index the unit universe holds names, types, sizes and link targets only and the
validator reports `DISCOVERY_ONLY`: a complete, sealed run (the guest and controllers
exit 0) that never yields policy-input hashes. The validator reports
`predicate_contract`: `option-c` for format 3, `legacy` for formats 1 and 2, which keep
their status, hashes and registration-and-socket predicate. The 240-second budget is
unchanged until measured (D22).

Before native APT configuration is queried, the collector checks the exact
reviewed files/membership and refuses include directives or configuration-root
redirection, including quoted, percent-encoded and comment-split forms and the
APT config-index directive. Three conservative views are checked: raw normalized
bytes, the original quote-aware C/C++ view, and the physical-line preprocessing in
[APT 2.8.2 configuration.cc](https://github.com/Debian/apt/blob/39d24618587e28b2dd2cae04ed2393056869f771/apt-pkg/contrib/configuration.cc#L865).
The third view resets quote parity on each physical line, completes any pending
block comment, strips `//` then non-magic `#` comments, then strips block comments.
Only block-comment state persists between lines. It preserves the case-sensitive
`#clear`, `#include`, and `#x-apt-configure-index` prefix exceptions before the
conservative redirection scan. This is a read-scope filter, not a complete APT
parser or semantic approval. Harmless literal shell hash comments remain readable.
Unit dump paths must identify exactly the five known fragments in
fixed system directories; unreviewed drop-ins or alternate paths refuse that
section. Both path queries must return exactly `Id`, `FragmentPath`, `DropInPaths`
and `NeedDaemonReload=no` for each unit. Nonempty stderr from either path query,
`systemctl cat` or `apt-config dump` makes evidence partial with no aggregate hashes.
The first path-query warning prevents the unit dump. This follows
[systemd 255's reload predicate](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/core/unit.c#L3909)
and its [successful cat command with a stderr warning](https://github.com/systemd/systemd/blob/db11bab38ccf1ed257f310d29070843d4c58ea01/src/systemctl/systemctl-edit.c#L82).
Reload detection compares observed paths and mtimes; it does not prove an atomic
snapshot or absence of every privileged content rewrite. Before/after scope correspondence and exact unit body correspondence
are independently checked. This preserves actual native command bytes instead
of substituting a staged configuration. These observations are not a filesystem
snapshot and do not contain a concurrent privileged swap-and-restore attack.
No private keys, APT auth files, token stores or general environment dumps are
collection inputs. Effective APT and unit output can still contain sensitive
configuration, so all raw bytes remain in private/encrypted custody.

**Snap alias (evidence format 2, owner decision 2026-10-25).** Ubuntu 24.04's
`/usr/bin/snap` is a relative symbolic link to `../lib/snapd/snapd`, so the
shared no-follow file read ends in ELOOP. Format 2 evidence no longer reads it
as a `file:` section; `r3_policy_snap.py` writes a `snap:/usr/bin/snap` section
instead. It lstats the alias without opening it and records one of three kinds:
`absent`, `regular` or `known-alias`. Section format 2 (owner decision
2026-10-25) streams a regular alias (older snapd can ship the binary itself; the
Azure target's snapd 2.76.3 is inferred to, not proven) under the same 64 MiB, single-link, no-follow rules
as the link target, refusing `REGULAR_UNSAFE` or `REGULAR_LIMIT`; the opened file
must be the one the lstat named. Format 1 records, which read a regular alias with
the shared 8 MiB reader, stay valid under that limit. Drift is recorded as
`CHANGED` rather than the bare class name `ValueError`.

Retained evidence validates under the source it is bound to: the B03 document
(source `24ef46a`) recorded the installed kernel's trigger file as
`UNREVIEWED_PATH`, which the `24ef46a` validator reports PARTIAL; this source's
validator refuses that record for an installed kernel as inconsistent, by design.
Only when the link bytes are exactly `../lib/snapd/snapd` does it open the fixed
`/usr/lib/snapd/snapd` path on its own, again with O_NOFOLLOW, and stream it into
a SHA-256: a regular single-link file of at most 64 MiB, stable across
fstat/path-stat, with a deadline check per chunk. After the target is read, both
parent chains are reopened by path and must still name the held directories
(device and inode, so a rename swap is refused), with unchanged owner and mode;
the target is re-stated and the alias re-read through the reopened chain. A
regular alias's parent is reopened the same way. Any difference is refused.
This narrows, not removes, the sampling limit: a privileged swap-and-restore
between reads remains undetectable. No link is ever followed generally and no binary body is exported. Any
other link (`UNEXPECTED_ALIAS`), file type (`UNSUPPORTED_TYPE`), unsafe target
(`TARGET_UNSAFE`) or oversize target (`TARGET_LIMIT`) is a fixed refusal with no
hash. The late re-sample covers the section; drift is `CHANGED` with `prior`.
A section is complete only under root-owned parents that neither group nor
others can write. It never enters `facts_sha256` or any other policy-input hash:
collection completeness stays separate from installer acceptance, and no package
(`snapd.list`/`md5sums`) corroboration is claimed. The fixed snap leaf
diagnostic below stays separate and unchanged.

A snap-section `OSError` may include strict optional `context`: format 2, a fixed
syscall-stage enum, numeric errno (or null), and up to four cleanup-stage/errno
records (a reopened chain, the file, the target parent and the alias parent). No exception message, filename,
link target or extra metadata is collected. Missing paths and timeouts keep their
classifications; a cleanup failure cannot turn absence into success or replace a
primary error. Format 1 documents stay valid unchanged, including the format 1
context that was allowed only on an initial `file:/usr/bin/snap` error. A format 2
document must carry the snap section and never `file:/usr/bin/snap`. The same
source/run/attempt/image binding, three-member guest frame, 240-second
collection budget, 300-second guest alarm and encrypted export apply. New A or B
collection still needs its own published source and exact approval; historical
attempts are never rebound.

`COLLECTED_REVIEW_REQUIRED` means structurally complete collection only.
`PARTIAL_REVIEW_REQUIRED` never supplies the aggregate policy-input hashes.
Neither status proves global write/read confinement, installation effects or
semantic hook closure. A substantive independent script/config/effect review and
exact permitted-effect map remain required; hashing a review file is insufficient.
A cache baseline cannot prove post-install effects. Sampling, blocking reads,
lifecycle/writer/content/detached-child and other retained P3 questions remain open.

### A: explicit fixture purpose

The workflow's default `purpose=diagnostic` retains strict/optional-maintenance
behavior. Select `purpose=policy-collection` only with a separate exact-source,
recipient and single-attempt execution approval; installation-policy inputs must
be empty. Its ISO manifest is `FIXTURE_POLICY_COLLECTION_ONLY`. Guest dispatch
enters a separate collection function before the installation function, including
cleanup. It cannot reach maintenance isolation, simulation, installation, holds,
unmask, repair or daemon-start. The existing disposable QEMU identity, no NIC/no
host sharing, source/run/attempt binding and encrypted export are preserved.
Runner-tool preparation remains the existing hosted-runner setup.

The private guest frame has exactly `manifest.json`, `policy-evidence.json` and
`result.json`. Command evidence is embedded in the shared document. The controller
uses the collection validator and never treats this frame as an installation
receipt. A process refusal is not needed to collect policy evidence. Incomplete
transport stays a refusal/partial capture, never an automatic retry.

### Fixed snap leaf diagnostic

Select `purpose=snap-leaf-diagnostic` only under a new exact published-source,
recipient and single-attempt dispatch approval. Both installation-policy inputs
must be empty. The input manifest purpose is `FIXTURE_SNAP_LEAF_DIAGNOSTIC`.
This route reuses signed image/input verification, the existing pinned runner
package setup and public Docker artifact staging, isolated QEMU lifecycle and
age custody. Those runner downloads/installations remain part of the separately
reviewed dispatch scope. The guest never invokes collection, package simulation,
installation, maintenance isolation, service changes or target repair.

After bounded input verification (120 seconds), a separate ten-second cooperative
observation budget covers a fixed descriptor-relative no-follow walk through
`/`, `usr`, `bin`. The guest records leaf and parent metadata before/after and
reopens the parent chain to compare the observed directory identity. Only a
symlink permits `readlink`; at most4096 uninterpreted bytes are retained as
Base64, length and hash. There is no target resolution, content open, recursive
scan or arbitrary path parameter. A regular or absent leaf records metadata or
explicit absence; unsupported types, drift, errors or cleanup failures remain
partial. A sixty-second framing grace and the existing controller lifecycle
bounds remain; these do not guarantee cancellation of uninterruptible I/O.

The exact private frame is `manifest.json`, `snap-leaf.json`, `result.json`.
The diagnostic report is capped16KiB and binds full source by canonical hash,
published SHA, run/attempt, image hash and fixture UUID. The controller validates
its schema, recomputes checks and forbids this frame in other purposes. Only a
valid stable observation plus sealed custody permits the diagnostic exit0;
all policy/installation/qualification flags stay false. Link bytes and metadata
remain encrypted, not in public summaries.

Matching before/after samples cannot exclude privileged swap-and-restore. A new
observation cannot prove the historical A run's exact leaf state or retroactively
change its ELOOP failure. The shared no-follow/content checks are unchanged; the
format 2 snap section (above) records the alias without relaxing them. PackageKit eligibility, hook/effect closure, P3 and lifecycle/sampling/
writer/content/detached-child questions remain open. Do not retry a consumed
attempt or infer an accepted installation policy from this diagnostic.

### B: separate packet, receiver and validator

Offline preparation (no guest or cloud access):

```sh
python3 -I -B infra/scripts/r3_policy_packet.py --destination /private/tmp/new-policy-packet
```

This creates new files exclusively: `proposal.json`, `guest.py`, and `packet.json`.
The draft binds the exact collector/receiver/helper/toolchain source hash map and
verified base commit only when the tree is clean and all mapped Git blobs match.
Otherwise `base_sha` is null, explicitly marking an unverified development draft.
`published_sha`, target and custody are deliberately null; the draft
cannot execute. After separate publication and fresh target/custody preparation,
use `--proposal <new-complete-proposal.json>` with another fresh destination to
render that exact proposal. No historical packet is edited or rebound.

The complete proposal retains false `execution_authorized` and
`historical_B_rebound` flags: authorization is a separate owner record. Source
binds base/published commit, exact files and canonical source-map SHA256. Target
binds selected IMDS fields (`resourceId`, `vmId`, `location`, `subscriptionId`,
`publisher`, `offer`, `sku`, `version`), connection host/user, and the complete
private control-plane identity/image/disks/network record. The region is pinned
twice and exactly: the guest IMDS `location` must be `SwedenCentral` (the
spelling #218's identity diagnostic observed) and the ARM control-plane
`location` must be `swedencentral`; no casefolded or other spelling passes
either side. Custody binds exact
local public known-hosts, SSH public identity and age tool paths/hashes, plus the
public encryption recipient/hash. SSH uses only that public identity with the
existing signing agent; the receiver never reads a private key. Paths reject
OpenSSH expansion/whitespace syntax. Guest modules are delivered through stdin
and loaded in memory; no source upload or package installation is performed.

`r3_policy_receive.py` requires `--packet`, `--approval`,
`--approval-sha256`, and `--execute`. The exact owner authorization record must
bind action `ONE_POLICY_EVIDENCE_COLLECTION`, one attempt, proposal SHA256 and
an owner authorization reference and `packet_path`, the canonical absolute path of
the new packet directory. A copied packet cannot reuse that approval at another
path; its exclusive local attempt marker still prevents repetition in place.
This is not global replay prevention across deleted/restored state or other hosts.
It also binds a private control-plane/host-key
readback observed within 15 minutes. Its `host_key_fingerprint` is the OpenSSH
`SHA256:` fingerprint of the decoded public key, separate from the custody file
hash. The known-hosts file must contain exactly one ordinary, marker-free
`ssh-ed25519` key line for the exact connection host: no CA, wildcard, alias,
comment or extra line. The receiver verifies current source against
published Git blobs (including hidden working-tree edits), exact rendered payload,
all helper hashes, target/custody and approval before consuming an exclusive
attempt marker. Git runs with a fixed environment, global/system config disabled,
`--no-replace-objects`, `GIT_NO_REPLACE_OBJECTS=1`, and `core.fsmonitor=false`
so status queries cannot invoke a repository-local filesystem-monitor hook. Ignored files under
`infra/scripts` and `infra/selfhost` also refuse execution. Before status/object
reads, a local key-name query with `--no-includes` refuses `filter.*`, `include.*`,
`includeIf.*`, `diff.*`, `extensions.worktreeConfig`, `extensions.partialClone`,
`remote.*.promisor` and `core.worktree`; nonempty, symlinked or nonregular Git
`info/attributes` also refuses. `GIT_NO_LAZY_FETCH=1` disables implicit missing-object
fetches. Both index and HEAD tree metadata are checked for mode `160000` gitlinks
before status: a child repository has independent config and is outside this
source-verification scope. These conservative configuration restrictions avoid repository-defined
program execution during source validation. They are preflight observations,
not protection against concurrent replacement of Git metadata or the interpreter.
The documented direct
`python3 -I -B` CLI establishes an empty private bytecode-cache prefix before local
imports; `-B` alone does not prevent loading stale/unchecked bytecode. None of
these files is an authorizer by itself.

The receiver probes encryption locally before SSH, then uses fixed strict host-key
checking with explicit `UpdateHostKeys=no`, `CheckHostIP=no`, no forwarding or
remote shell expansion of supplied values. The
selected fixed IMDS endpoint bypasses proxies and refuses redirects. Guest identity
and boot ID are observed before/after collection and compared independently;
control-plane/image mismatch or a reboot cannot yield complete evidence. Output
and stderr are bounded and retained at 0600 in a new 0700 private capture directory,
including failed/partial transport. The local transport deadline is 360 seconds.
SIGINT/SIGTERM are recorded and deferred to bounded child cleanup, capture/seal
and partial-summary finalization. The original transport failure and individual
cleanup errors are retained separately; streams are unbuffered. SIGKILL, host
loss and remote detached-child termination remain outside this guarantee. Local SSH exit
never proves remote child exit after a disconnect.

The receiver seals private capture with the bound age tool and recipient; only
ciphertext and the minimal collection summary are exportable. It does not publish
anything. The offline `validate_target()` function validates all shared evidence
and identity correspondence, replacing the old limited-core readback contract.
No guest invocation, new A run, SSH, Azure mutation, provisioning, deployment or
workflow dispatch is authorized by development or publication of this code.

R3 and CL-P2-3 remain OPEN; bootstrap remains
`NOT_READY_FOR_BOOTSTRAP_APPROVAL`. Delivery order remains R3 → R4 → Sweden
application foundation → API/web deployment → QA acceptance.

### Narrow SSH access recovery draft (separate from collection)

Loss of an authorized private key is not repaired by generating another key
locally. Its public counterpart would still need explicit guest authorization.
Do not replay a consumed B attempt, rebind its packet, use VMAccess implicitly,
or treat a Portal agent status as proof that a recovery delivery channel works.

`r3_access_repair_packet.py` prepares a new offline draft from retained expected
IMDS fields and an exact public-key byte hash. It never generates or reads private
keys, contacts Azure, installs a handler, or invokes either collection entry point.
The source map includes the new recovery modules and the existing identity helper
dependencies. An unpublished/dirty candidate remains unbound to a published SHA.
Draft publication, authenticated client, fresh observations, exact approvals,
actual encrypted export and post-recovery readback stay null until supplied or
observed. Implemented controllers do not make such a draft execution-ready.

The distinct guest payload is designed to refuse before writing when the target
IMDS identity differs, the existing local `tonyaiops` account/home is unexpected,
or a path is missing, linked, incorrectly owned or writable by other users. It
does not create an account or `.ssh` directory. An existing regular single-link
`authorized_keys` must have the account's owner/group and mode 0600 or 0644. A
bounded local passwd read avoids NSS lookups. No password, sudo, SSH configuration,
service, package, disk or network change is part of the payload.

The intended mutation is one append syscall, at most 4 KiB, preserving the prior
file bytes as an exact prefix and retaining its inode, owner and mode. A missing
final newline is separated before the new key. The selected key is refused if its
semantic identity already appears, including restricted entries, alternative
base64 padding or equivalent RSA mpints; no unrestricted duplicate is added.
Advisory locking and descriptor-chain verification detect some concurrent changes
but cannot exclude a hostile/uncooperative owner or prevent parent renames. The
approved effect must refer to the verified open inode as well as its path; a race
or uncertain readback is partial, not evidence of isolated execution.

The guest would retain an exclusive root-only attempt directory at
`/var/lib/tonyai-r3-access-recovery-<packet_id>`, with a private before-image,
prepared append hashes/metadata, invocation binding and pre-close result. Existing
attempt directories or evidence files are never overwritten. A short append,
deadline, changed target, failed fsync/close or uncertain path preserves partial
evidence and has no automatic retry, truncate, rollback or cleanup deletion. The
pre-close result is historical: the returned summary can still downgrade it after
cleanup. Even `KEY_APPENDED_REVIEW_REQUIRED` is not authenticated access,
collection completion, installation qualification or bootstrap approval.

Payload budgets: existing key file/local passwd at most 256 KiB each, selected
public bytes less than 4 KiB, IMDS at most 32 KiB per observation via the existing
helper, cooperative 30-second payload alarm plus 5-second finalization grace,
and at most 4 KiB summary. These are not cancellation guarantees for an Azure
handler or an uninterruptible syscall. The controller limits below do not prove remote outcome or cancellation. The private
before-image remains on the guest until a separately reviewed encrypted custody
export succeeds; a summary hash alone does not close custody.

Any Azure extension enablement, delivery installation/state/log/cache effects,
one-time approval consumption, actual guest execution, status polling, evidence
retrieval and access verification require a concrete separately reviewed packet
and owner approval. Source publication alone supplies none of this authority.
Keep the old access and collection evidence immutable and requalify changed guest
access state before considering another B collection. All R3/CL-P2-3 and
pre-bootstrap gates above remain open.

#### Managed delivery and separate approval contracts

The offline `delivery.json` binds the canonical packet directory, proposal,
repair/export payload hashes, retained target, custody, exact ARM request bodies,
client identity, and the owner's explicit Microsoft-managed-handler design choice.
The renderer never invents owner authority, fresh observations or publication.
`proposal.json` retains `execution_authorized: false`: execution authority is a
separate exact phase document, not a claim the guest can mint.

Each approval has exactly `action`, `packet_path`, `delivery_sha256`,
`fresh_sha256`, `attempts: 1`, and the actual `owner_authorization_reference`.
Actions are `ONE_EXTENSION_ENABLE`, `ONE_MANAGED_KEY_APPEND`, and
`ONE_REPAIR_EVIDENCE_FETCH`. An approval binds one canonical packet and one fresh
record, not all three phases. Each phase writes its exclusive consumed marker
before dispatch; refusal, ambiguity, interruption or partial capture consumes it.
No marker deletion, resend, rerun, automatic rollback, extension disable or
Run Command deletion is implemented.

Fresh records bind `observed_at` (timezone-aware, no future time, at most 900
seconds old), exact `target` and `client`, an owner-coordinated
`exclusive_operator_window`, `vm_etag`, canonical JSON `vm_model_sha256`, extension
and Run Command lists, and `allow_extension_operations`. Export additionally
binds the exact repair-summary hash and host-key fingerprint. Retained Portal
observations are historical expected identity, never fresh execution evidence.
Fresh observations and credentials require their own authorized acquisition;
rendering neither contacts Azure nor reads an authentication token.

1. **Enable:** `r3_access_repair_control.py --phase enable --execute` verifies the
   live VM model/etag and empty delivery lists, then sends one minimal VM PATCH
   with `If-Match`, setting only `osProfile.allowExtensionOperations=true`.
   Its readback refuses unrelated model changes. Enabling extension operations
   has a wider capability effect than the key append and needs separate approval.
2. **Repair:** the same controller with `--phase repair --execute` requires fresh
   enablement and empty extension/command lists, verifies absence of its unique
   command name, and sends one Managed Run Command PUT with the exact inline
   Python payload. No credentials, output blob or run-as override is in that
   body. The documented create-or-update PUT has no atomic absence guard: the
   exclusive operator window is an explicit residual concurrency assumption.
   A lost response is partial and must never cause another PUT.
3. **Evidence fetch:** `r3_access_repair_receive.py --execute` uses the retained
   exact host pin and public SSH identity via the owner's existing agent. It
   runs only the separate read-only export payload through noninteractive sudo,
   retrieving four fixed root-private evidence files. The append receipt binds
   the exact pre-close file hash and finalization overlay. A partial ARM result
   can be preserved by separately approved fetch, but cannot become complete
   repair evidence. No collection or installation entry point is invoked.

Both entry points require `--packet`, `--approval`, `--approval-sha256` and
`--fresh`; the fetch also requires `--repair-summary`. The concrete private
packet supplies absolute paths and exact arguments; these descriptions are not
execution commands or approval. The controllers verify current source-map and
published HEAD correspondence before I/O. A different candidate needs new source
binding and review; a consumed packet cannot be rebound.

The ARM transport accepts only an explicitly bound `OWNER_ARM_BEARER_FILE` client
(`tenant`, `principal`, canonical private `credential_path`). The owner must
provision a short-lived ARM token privately through a separately authorized
route. No login, credential discovery, token printing, package installation or
use of a browser's cached credentials is implemented. JWT claims select the
expected tenant/principal/audience/expiry; ARM verifies authentication. TLS uses
system trust, no proxies, no redirects and no request retries. Never put the
bearer file in evidence archives or share its contents in chat.

The Microsoft-managed handler can install/update binaries, state, caches and
logs. Its exact binary hash is not guaranteed by the reviewed Python hash.
Accepting this trust boundary does not prove the live handler version, its
behavior or cleanup. Existing agent panels and outbound NSG rules are not channel
proof. Retain actual delivery observations for separate review. No VMAccess,
account/sudo reset, network exception or automatic handler removal is included.

| Boundary | Limit and meaning |
| --- | --- |
| ARM phase | 180-second cooperative request-start window; at most 12 requests, including at most six status polls separated by 5 seconds. A final request can overrun the window by up to its 15-second cooperative alarm; finalization/encryption is additional. No remote cancellation guarantee. |
| ARM request | 256 KiB request body, 1 MiB response, 5-second socket timeout and 15-second cooperative total alarm; HTTP errors retain status only. No retry or redirect. |
| Managed command | `timeoutInSeconds=60`, synchronous configuration, failure treated as deployment failure; provisioning success alone is insufficient. |
| Private fetch | 30-second cooperative guest export alarm; 512 KiB semantic envelope. Existing receiver hard capture caps are 24 MiB stdout, 64 KiB stderr, 360 seconds plus 5 seconds process cleanup. Remote exit is not proven by killing local SSH. |
| Local custody | Public-recipient probe 10 seconds; age sealing 60 seconds. At most 48 capture files, 24 MiB/file and 32 MiB aggregate before tar. Private root 0700/files 0600. Failed sealing retains plaintext and partial ciphertext for review. |

SIGINT/SIGTERM defer to bounded capture/finalization, never resume dispatch.
SIGKILL, process crashes and uninterruptible syscalls cannot guarantee completed
local sealing or remote cancellation. Durable attempt markers and retained
partial files must survive for review; uncertainty never permits an automatic
retry. The before-image and invocation records stay private; public output is
limited to disposition/hash metadata. `REPAIR_EVIDENCE_VERIFIED_REVIEW_REQUIRED`
means a source-bound evidence chain was validated and sealed, not installation,
policy acceptance, bootstrap eligibility or comprehensive SSH/sudo preservation
proof. A new post-repair identity/access/configuration qualification and a new
exact B collection approval remain necessary.


#### Managed identity diagnostic after a failed repair

An identity-before refusal may precede both append and evidence-directory
creation. Preserve that consumed repair and its status evidence. Do not retry
the append or fetch guest files that the payload never created.

`r3_access_repair_packet.py --identity-diagnostic` prepares a new proposal with
purpose `R3_ACCESS_IDENTITY_DIAGNOSTIC`, a new packet ID and an empty export
payload. A separate `ONE_MANAGED_IDENTITY_DIAGNOSTIC` approval binds its exact
delivery/fresh hashes and path. `r3_access_repair_control.py --phase diagnose
--execute` uses the existing owner-held bearer client and custody machinery;
preparation does not authorize execution or owner-only authentication.

The bindings contain `prior_command`: its exact resource ID, source SHA,
canonical delivery SHA256, request body, terminal execution state `Failed`,
nonzero integer exit code, and retained `delivery` and `proposal` documents.
The validator cross-checks those documents, their hashes, original append
purpose, packet ID, target identity and script/options. These references are
preserved historical provenance, never authority to execute the old payload.

Fresh observations must include the exact extension and command list bodies'
SHA256 values (`extensions_model_sha256`, `commands_model_sha256`) and the
failed command's full instance-view body hash (`prior_command_model_sha256`).
The sole allowed existing command is that reviewed terminal failed command;
at most four explicitly observed extension IDs are allowed. The controller
rechecks the full models, failed state, exact script/options, VM model/ETag,
and identity before checking that the new `r3-identity-<packet_id>` name is
absent. Unknown delivery resources, drift or an active old command refuse.
The exclusive operator window remains necessary: Azure PUT is create-or-update,
not an atomic conditional create. No old command is updated or removed.

The bounded operation is one PUT plus at most eleven GETs, with existing
900-second freshness, 180-second request-start window, request deadlines,
durable consumption, interruption and private sealing controls. A refusal or
partial result consumes the attempt; no automatic retry or rollback follows.
Microsoft's privileged handler retains its previously disclosed installation,
log, cache and state effects. RunCommand response locations accept only ASCII
alphanumeric case variation of the expected Azure region. Guest IMDS equality
and the VM target checks remain unchanged.

The fixed Python entry point has a 30-second cooperative alarm and calls the
existing identity helper once: one bounded 32769-byte IMDS read, at most 32768
accepted bytes, and one no-follow `/proc/sys/kernel/random/boot_id` read.
Internal checkpoints retain the failing stage; only the eight already selected
IMDS identity fields and a valid boot UUID can enter the report. Each field is
classified by type/length/hash/exact comparison; mismatch values share a 1024-byte
canonical-JSON budget. No full IMDS response, exception message, account data,
key append, subprocess or guest evidence-directory write is performed by this
entry point. The overall report is bounded to 4096 bytes and stays private.

`IDENTITY_DIAGNOSTIC_REVIEW_REQUIRED` means a validated diagnostic was returned,
including a reported identity refusal. It never means SSH access was recovered:
access, qualification and installation flags remain false. Error-free reports
require all eight nonempty string fields, a valid boot ID and consistent exact
comparison. Review the observation before proposing any repair correction,
fresh collection or further execution. Historical partial records and all
R3/CL-P2-3/bootstrap gates remain unchanged.


#### Exact diagnostic-bound location amendment

`r3_access_repair_packet.py --recovery-amendment` is an offline preparation path
for the reviewed `swedencentral` / `SwedenCentral` mismatch. It requires a new
packet ID and an `amendment` binding with purpose
`R3_EXACT_LOCATION_RECOVERY_AMENDMENT`. This path is deliberately limited to the
historical repair source `cc74bd7a940c985e10d2333bd43152f895663aeb` and diagnostic
source `ff3e37ada40ea86cbfaf0f1b3bfe2a17a010f852`. Their complete source-map digests
are immutable code anchors in `r3_access_repair_history.py`; changed source needs
its own reviewed contract, not a rewritten historical packet.

The binding embeds the diagnostic delivery/proposal, bounded diagnostic report,
and failed repair summary, with their canonical SHA256 values and a
`decision_sha256` reference. That decision digest is a review reference, not
execution authority; the independent owner approval must bind the entire new
delivery and fresh observation. Historical validation checks both complete
request envelopes, exact shell/Python wrappers, embedded proposals, decoded
module hashes/closures and export payload hashes without executing historical
code. The report must show an error-free comparison, exactly seven matching
identity fields and only location differing as `SwedenCentral`, with the exact
case-only classification. The failed predecessor must have refused at
`identity-before` without append or an evidence path. Custody, public key and
all other target values stay bound to the predecessor chain.

The new guest proposal uses that exact observed IMDS value. Existing guest
before/after equality, account, key and directory guards are unchanged; this is
not a case-insensitive guest comparison. A validated historical controller view
keeps the ARM VM expectation `swedencentral`. The new Run Command request body's
location follows the exact IMDS spelling `SwedenCentral`; the existing bounded
ASCII case-only ARM response check remains in effect.

A separately approved fresh observation must bind the full VM/ETag, empty
extension-resource list, exact two predecessor command IDs and full list hashes,
and `predecessor_model_sha256` for both expanded command bodies. List order is
observed, not prescribed; duplicate, missing or extra IDs refuse. Both predecessor
models must match their full fresh hashes, exact scripts/options and outputs.
The old repair must have provider/execution state `Failed`, integer exit 2 and
the bound early-refusal summary. The diagnostic must have provider/execution
state `Succeeded`, integer exit 0 and the exact bound report. A guest exit 0 with
provider state `Creating` does not satisfy this precondition.

`ONE_MANAGED_KEY_APPEND` still authorizes only one new PUT. The controller
performs at most six precondition GETs, one PUT and five status GETs (12 requests
in total), with the existing 180-second request-start budget and per-request
deadlines. It checks the 900-second freshness at approval and immediately before
mutation; status polling can continue within the overall budget. The exclusive
operator window remains required because the absent-name check and PUT are not
atomic. No predecessor is updated/deleted, and no retry or rollback occurs.
The Microsoft-managed root handler's installation, log, cache and state effects
remain part of the separately reviewed live scope.

The later `ONE_REPAIR_EVIDENCE_FETCH` needs a separate fresh observation and
approval. Its command scope contains exactly the two predecessors plus the new
repair command, with the existing SSH agent, host-pin, source and private custody
checks. Export approval alone does not perform ARM readback: predecessor hashes
must come from that separately reviewed observation. The original strict guest
export and before/after identity evidence remain mandatory. An append response
is only `KEY_APPENDED_CUSTODY_REQUIRED`; it does not prove access, qualification,
installation or R3 completion. All historical consumption records are preserved.
