"""Independent exact Unit 8 two-grant oracle; application state remains sole writer."""
from uuid import NAMESPACE_URL, uuid5
from qa_contract import GROUP, SUBSCRIPTION
from qa_foundation_expected import expected
from qa_runtime_contract import grants as runtime_grants
from qa_oidc_expected import additions

ROLE = '358470bc-b998-42bd-ab17-a7e34c199c0f'


def grants(principal):
    result = {}
    for kind in ('api', 'web'):
        scope = GROUP + '/providers/Microsoft.App/containerApps/tonyai-staging-' + kind
        result[f'azapi_resource.grant["app-{kind}"]'] = dict(
            type='Microsoft.Authorization/roleAssignments@2022-04-01',
            name=str(uuid5(NAMESPACE_URL, f'{scope}/{principal}/{ROLE}'.lower())),
            parent_id=scope, location=None, tags=None, response_export_values=[],
            body={'properties': dict(principalId=principal, principalType='ServicePrincipal',
                roleDefinitionId=f'/subscriptions/{SUBSCRIPTION}/providers/Microsoft.Authorization/roleDefinitions/{ROLE}')})
    return result


def existing(config, principals, release_principal):
    return {**expected(config, principals), **runtime_grants(config, principals), **additions(config, release_principal)}
