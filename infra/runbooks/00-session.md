# Restore an owner session

Use a **Bash** terminal (`bash` from zsh), with shell tracing and recording off.
Do not paste `set -e` into the interactive shell. Run one numbered step at a time;
on a nonzero result, stop and fix that step. Executable Bash helpers use `set -e`
inside their child process, so failures stop the helper without closing your shell.

After the foundation exists, this is the single restoration block for runbooks
02–05 and any later terminal. It reads nonsecret resource-group tags and foundation
resources from Azure (never ARM deployment outputs); it never reads Key Vault values or writes an env file:

```bash
set +x
# If your session expired, authenticate yourself first:
az login --tenant '<tenant-uuid>' --output none
source infra/scripts/restore-session.sh '<subscription-uuid>' '<staging-resource-group>'
```

Expected: `PASS: staging session restored`. This restores subscription, tenant,
group/ID, prefix, release SHA, GitHub repository, ACR name/host, vault, origins,
Supabase project/URL, Entra IDs and deployed/candidate image digests plus pinned secret versions; it defines `foundation_output`.
Optional fields are empty until their numbered setup step records them. Never
continue if restore fails; never infer an empty field is a valid target.

The initial group records `tonyaiPrefix`, `releaseSha`, `githubRepository`;
Supabase setup adds `supabaseProjectRef`; federation adds `githubClientId` and
`githubPrincipalId`; a successful image build/scan adds `candidateApiDigest`/
`candidateWebDigest`. Deployment readback records `apiDigest`/`webDigest`,
`databaseSecretVersion` and `backendSecretVersion`. Candidate builds never replace
the deployed image record used by rotation.
All are identifiers/settings, never credentials. For an older foundation without
these tags, the owner supplies the reviewed values with `az group update --set`
using the same tag names before restoring. Verify the group is staging first.

Before deploying a new reviewed release, select its clean checkout and update
only the release tag (never replace all tags):

```bash
export RELEASE_SHA="$(git rev-parse HEAD)"
# Run only for an owner-reviewed SHA. This guard also works when pasted into zsh.
if test -z "$(git status --porcelain)"; then
  az group update -n "$RESOURCE_GROUP" --set "tags.releaseSha=$RELEASE_SHA" --output none
else
  printf '%s\n' 'STOP: clean checkout required; release tag unchanged.'
fi
```

Restoring does not validate a release or create credentials. Record the selected
SHA in the PR evidence; resume at the last successful numbered step.
