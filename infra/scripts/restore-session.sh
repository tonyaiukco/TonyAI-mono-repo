# Source from Bash: source infra/scripts/restore-session.sh <subscription-id> <group>
# No shell option changes and no cloud writes. A failure returns to the caller.
_tonyai_restore_session() {
  local subscription="${1:-}" group="${2:-}" data exports
  if [[ -z "$subscription" || -z "$group" ]]; then
    printf '%s\n' 'Usage: source infra/scripts/restore-session.sh <subscription-id> <group>' >&2
    return 1
  fi
  data=$(az group show --subscription "$subscription" --name "$group" --query '{id:id,tags:tags}' -o json) || return 1
  exports=$(TONYAI_GROUP_JSON="$data" python3 - "$subscription" "$group" <<'PY'
import json, os, re, shlex, subprocess, sys
subscription, group = sys.argv[1:]
try:
    data = json.loads(os.environ['TONYAI_GROUP_JSON'])
    tags = data['tags']
    assert tags['environment'] == 'staging'
    assert re.fullmatch(r'[a-z0-9]{3,12}', tags['tonyaiPrefix'])
    assert re.fullmatch(r'[a-f0-9]{40}', tags['releaseSha'])
    assert re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', tags['githubRepository'])
    result = subprocess.run(['az', 'deployment', 'group', 'show', '--subscription', subscription,
                             '-g', group, '-n', 'lp2-foundation', '--query', 'properties.outputs', '-o', 'json'],
                            capture_output=True, text=True, check=True)
    outputs = json.loads(result.stdout)
    env = {'AZURE_SUBSCRIPTION_ID': subscription, 'RESOURCE_GROUP': group, 'GROUP_ID': data['id'],
           'PREFIX': tags['tonyaiPrefix'], 'RELEASE_SHA': tags['releaseSha'],
           'GITHUB_REPOSITORY': tags['githubRepository']}
    for var, name in {'ACR_NAME':'registryName','ACR_HOST':'registryHost','VAULT_NAME':'vaultName',
                      'WEB_ORIGIN':'webOrigin','API_ORIGIN':'apiOrigin'}.items():
        env[var] = outputs[name]['value']
        assert env[var]
    account = subprocess.run(['az','account','show','--subscription',subscription,'--query','tenantId','-o','tsv'],capture_output=True,text=True,check=True)
    env['AZURE_TENANT_ID'] = account.stdout.strip()
    project = tags.get('supabaseProjectRef', '')
    assert not project or re.fullmatch(r'[a-z]{20}', project)
    env.update(SUPABASE_PROJECT_REF=project, SUPABASE_URL='https://' + project + '.supabase.co' if project else '')
    for var, tag in {'AZURE_CLIENT_ID':'githubClientId', 'DEPLOYER_OBJECT_ID':'githubPrincipalId',
                     'API_DIGEST':'apiDigest','WEB_DIGEST':'webDigest',
                     'DATABASE_SECRET_VERSION':'databaseSecretVersion','BACKEND_SECRET_VERSION':'backendSecretVersion'}.items():
        env[var] = tags.get(tag, '')
    for var, value in env.items():
        print('export ' + var + '=' + shlex.quote(value))
except Exception:
    print('FAIL: session metadata/foundation missing; restore initial setup first.', file=sys.stderr)
    sys.exit(1)
PY
  ) || return 1
  az account set --subscription "$subscription" || return 1
  eval "$exports"
  printf '%s\n' 'PASS: staging session restored. Empty optional IDs mean their setup step is still pending.'
}
foundation_output() {
  az deployment group show --subscription "$AZURE_SUBSCRIPTION_ID" -g "$RESOURCE_GROUP" -n lp2-foundation --query "properties.outputs.$1.value" -o tsv
}
_tonyai_restore_session "$@"
