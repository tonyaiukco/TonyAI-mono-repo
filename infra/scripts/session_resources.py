"""Restore nonsecret settings from Azure resources, never writable deployment outputs."""
import re
import shlex
import sys
from configure_oidc import az
from pooler import SafeFailure


def restore(subscription, group):
    data = az('group', 'show', '--subscription', subscription, '-n', group)
    tags = data.get('tags') or {}
    if tags.get('environment') != 'staging':
        raise SafeFailure('Resource group is not tagged staging.')
    prefix = tags.get('tonyaiPrefix', '')
    if (not re.fullmatch(r'[a-z0-9]{3,12}', prefix)
            or not re.fullmatch(r'[a-f0-9]{40}', tags.get('releaseSha', ''))
            or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', tags.get('githubRepository', ''))):
        raise SafeFailure('Missing or invalid staging metadata.')
    group_id = '/subscriptions/' + subscription + '/resourceGroups/' + group
    if data['id'].lower() != group_id.lower():
        raise SafeFailure('Resource group identity mismatch.')
    resources = az('resource', 'list', '--subscription', subscription, '-g', group)
    def resource(kind, name=None):
        matches = [r for r in resources if r['type'].lower() == kind.lower()
                   and (name is None or r['name'] == name)]
        if len(matches) != 1:
            raise SafeFailure('Foundation resource missing or ambiguous.')
        r = matches[0]
        expected = group_id + '/providers/' + kind + '/' + r['name']
        if (r['id'].lower() != expected.lower() or r.get('location') != 'germanywestcentral'
                or any(r.get('tags', {}).get(k) != v for k, v in
                       {'application':'TonyAI', 'environment':'staging', 'task':'LP2-01'}.items())):
            raise SafeFailure('Foundation resource identity, region or tags mismatch.')
        return r
    registry = resource('Microsoft.ContainerRegistry/registries')
    vault = resource('Microsoft.KeyVault/vaults')
    environment = resource('Microsoft.App/managedEnvironments', prefix + '-staging-env')
    api_identity = resource('Microsoft.ManagedIdentity/userAssignedIdentities', prefix + '-staging-api')
    logs = resource('Microsoft.OperationalInsights/workspaces', prefix + '-staging-logs')
    registry_data = az('acr', 'show', '--ids', registry['id'])
    domain = az('containerapp', 'env', 'show', '--ids', environment['id'])['properties']['defaultDomain']
    if (registry_data['loginServer'] != registry['name'] + '.azurecr.io'
            or not re.fullmatch(r'[a-z0-9-]+\.germanywestcentral\.azurecontainerapps\.io', domain)):
        raise SafeFailure('Unexpected registry host or environment domain.')
    env = {'AZURE_SUBSCRIPTION_ID':subscription, 'RESOURCE_GROUP':group, 'GROUP_ID':data['id'],
           'PREFIX':prefix, 'RELEASE_SHA':tags['releaseSha'], 'GITHUB_REPOSITORY':tags['githubRepository'],
           'ACR_NAME':registry['name'], 'ACR_HOST':registry_data['loginServer'],
           'VAULT_NAME':vault['name'], 'VAULT_ID':vault['id'], 'API_IDENTITY_ID':api_identity['id'],
           'LOGS_NAME':logs['name'], 'ACA_DEFAULT_DOMAIN':domain,
           'WEB_ORIGIN':'https://' + prefix + '-staging-web.' + domain,
           'API_ORIGIN':'https://' + prefix + '-staging-api.' + domain,
           'AZURE_TENANT_ID':az('account', 'show', '--subscription', subscription)['tenantId']}
    project = tags.get('supabaseProjectRef', '')
    if project and not re.fullmatch(r'[a-z]{20}', project):
        raise SafeFailure('Invalid Supabase project metadata.')
    env.update(SUPABASE_PROJECT_REF=project, SUPABASE_URL='https://' + project + '.supabase.co' if project else '')
    for var, tag in {'AZURE_CLIENT_ID':'githubClientId', 'DEPLOYER_OBJECT_ID':'githubPrincipalId',
                     'API_DIGEST':'apiDigest','WEB_DIGEST':'webDigest',
                     'CANDIDATE_API_DIGEST':'candidateApiDigest','CANDIDATE_WEB_DIGEST':'candidateWebDigest',
                     'DATABASE_SECRET_VERSION':'databaseSecretVersion','BACKEND_SECRET_VERSION':'backendSecretVersion'}.items():
        env[var] = tags.get(tag, '')
    return env


if __name__ == '__main__':
    try:
        for name, value in restore(*sys.argv[1:]).items():
            print('export ' + name + '=' + shlex.quote(value))
    except SafeFailure as error:
        sys.exit('FAIL: ' + str(error))
    except Exception:
        sys.exit('FAIL: could not restore foundation resources; details withheld.')
