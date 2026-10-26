"""Independent Unit 5 oracle. No Terraform output defines a scope or permission."""
from uuid import NAMESPACE_URL, uuid5
from qa_contract import GROUP, SUBSCRIPTION
from qa_foundation_expected import expected, resource_id as foundation_id

DEPLOYER = 'azapi_resource.deployer["enabled"]'
FEDERATION = 'azapi_resource.federation["enabled"]'
JOIN = 'azapi_resource.join_grant[0]'
ISSUER = 'https://token.actions.githubusercontent.com'
SUBJECT = 'repo:tonyaiukco/TonyAI-mono-repo:environment:staging'
AUDIENCES = ['api://AzureADTokenExchange']


def resource_id(row):
    if row['name'] is None or row['parent_id'] is None:
        return None
    if row['type'].split('@')[0] == 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials':
        return row['parent_id'] + '/federatedIdentityCredentials/' + row['name']
    return foundation_id(row)


def additions(config, principal=None):
    old = expected(config)
    identity = dict(type='Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31',
        name='tonyai-staging-release', parent_id=GROUP, location='swedencentral', tags=None,
        body={}, response_export_values=['properties.principalId', 'properties.clientId'])
    result = {DEPLOYER: identity, FEDERATION: dict(
        type='Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31',
        name='github-staging', parent_id=resource_id(identity), location=None, tags=None,
        body={'properties': dict(issuer=ISSUER, subject=SUBJECT, audiences=AUDIENCES)}, response_export_values=[])}
    specs = {'registry_push': ('registry', '8311e382-0749-4cb8-b61a-304f252e45ec'),
             'identity-api': ('identity["api"]', 'f1a07417-d97a-45cb-824c-7a7467783830'),
             'identity-web': ('identity["web"]', 'f1a07417-d97a-45cb-824c-7a7467783830'),
             'environment_read': ('environment', 'acdd72a7-3385-48ef-bd42-f606fba81ae7'),
             'join': ('environment', None)}
    for key, (target, role) in specs.items():
        scope = resource_id(old['azapi_resource.' + target])
        role_id = (f'/subscriptions/{SUBSCRIPTION}/providers/Microsoft.Authorization/roleDefinitions/{role}'
                   if role else resource_id(old['azapi_resource.join_role']))
        seed = f'{scope}/{principal}/{role}'.lower() if role else f'{scope}/{principal}/join'
        result[JOIN if key == 'join' else f'azapi_resource.grant["{key}"]'] = dict(
            type='Microsoft.Authorization/roleAssignments@2022-04-01', name=str(uuid5(NAMESPACE_URL, seed)) if principal else None,
            parent_id=scope, location=None, tags=None, response_export_values=[], body={'properties': {
                'principalId': principal, 'principalType': 'ServicePrincipal', 'roleDefinitionId': role_id}})
    return result


def role_rows(resources):
    return {resource_id(v): dict(id=resource_id(v), scope=v['parent_id'], **v['body']['properties'],
            condition=None, conditionVersion=None, delegated=None)
            for v in resources.values() if v['type'].startswith('Microsoft.Authorization/roleAssignments@')}
