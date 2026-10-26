"""Independent first-foundation request oracle, never derived from plan outputs."""
from uuid import NAMESPACE_URL, uuid5
from qa_contract import GROUP, SUBNET, SUBSCRIPTION

VNET = SUBNET.rsplit('/subnets/', 1)[0]
DATA_GROUP = f'/subscriptions/{SUBSCRIPTION}/resourceGroups/tonyai-staging-data'
VM = DATA_GROUP + '/providers/Microsoft.Compute/virtualMachines/tonyai-staging-data-r02'
STEM = 'tonyai-staging'
TAGS = dict(application='TonyAI', environment='staging', task='LP2-01')
PULL = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
OFFICER = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'


def expected(config, principals=None):
    """None denotes only a not-yet-created workload principal/derived grant name."""
    principals = principals or {}
    result = {}

    def add(key, kind, version, name, body, parent=GROUP, location=None, tags=None, exports=()):
        result['azapi_resource.' + key] = dict(type=kind + '@' + version, name=name,
            parent_id=parent, location=location, tags=tags, body=body,
            response_export_values=list(exports))
        if name is None:
            return None
        return parent + ('/' if kind == 'Microsoft.Resources/resourceGroups' else '/providers/' + kind + '/') + name

    add('group', 'Microsoft.Resources/resourceGroups', '2024-03-01', 'tonyai-staging-apps',
        {'properties': {}}, parent=f'/subscriptions/{SUBSCRIPTION}', location='swedencentral',
        tags={**TAGS, 'tonyaiPrefix': 'tonyai', 'githubRepository': config['repository'], 'releaseSha': config['release_sha']})
    registry = add('registry', 'Microsoft.ContainerRegistry/registries', '2023-07-01', config['registry_name'],
        {'sku': {'name': 'Basic'}, 'properties': {'adminUserEnabled': False, 'publicNetworkAccess': 'Enabled'}},
        location='swedencentral', tags=TAGS, exports=['properties.loginServer'])
    logs = add('logs', 'Microsoft.OperationalInsights/workspaces', '2023-09-01', STEM + '-logs',
        {'properties': {'sku': {'name': 'PerGB2018'}, 'retentionInDays': 30,
                        'features': {'enableLogAccessUsingOnlyResourcePermissions': True}}}, location='swedencentral', tags=TAGS)
    environment = add('environment', 'Microsoft.App/managedEnvironments', '2025-01-01', STEM + '-env',
        {'properties': {'vnetConfiguration': {'infrastructureSubnetId': SUBNET, 'internal': False},
                        'workloadProfiles': [{'name': 'Consumption', 'workloadProfileType': 'Consumption'}],
                        'appLogsConfiguration': {'destination': 'azure-monitor'}}},
        location='swedencentral', tags=TAGS, exports=['properties.defaultDomain'])
    add('diagnostics', 'Microsoft.Insights/diagnosticSettings', '2021-05-01-preview', 'container-logs',
        {'properties': {'workspaceId': logs, 'logAnalyticsDestinationType': 'Dedicated',
                        'logs': [{'category': c, 'enabled': True} for c in ['ContainerAppConsoleLogs', 'ContainerAppSystemLogs']]}},
        parent=environment)
    vault = add('vault', 'Microsoft.KeyVault/vaults', '2023-07-01', config['vault_name'],
        {'properties': {'tenantId': config['tenant_id'], 'sku': {'family': 'A', 'name': 'standard'},
                        'enableRbacAuthorization': True, 'enableSoftDelete': True, 'softDeleteRetentionInDays': 90,
                        'enablePurgeProtection': True, 'publicNetworkAccess': 'Enabled',
                        'networkAcls': {'bypass': 'AzureServices', 'defaultAction': 'Allow'}, 'accessPolicies': []}},
        location='swedencentral', tags=TAGS)
    for kind in ('api', 'web'):
        add(f'identity["{kind}"]', 'Microsoft.ManagedIdentity/userAssignedIdentities', '2023-01-31',
            STEM + '-' + kind, {}, location='swedencentral', tags=TAGS, exports=['properties.principalId'])
    dns = add('dns', 'Microsoft.Network/privateDnsZones', '2024-06-01', 'qa.tonyai.internal',
              {'properties': {}}, location='global')
    # Child resource IDs append their child type, unlike extension resources.
    add('dns_link', 'Microsoft.Network/privateDnsZones/virtualNetworkLinks', '2024-06-01', 'qa-data',
        {'properties': {'registrationEnabled': False, 'virtualNetwork': {'id': VNET}}}, parent=dns, location='global')
    add('db_address', 'Microsoft.Network/privateDnsZones/A', '2024-06-01', 'db',
        {'properties': {'ttl': 300, 'aRecords': [{'ipv4Address': '10.80.1.4'}]}}, parent=dns)
    add('join_role', 'Microsoft.Authorization/roleDefinitions', '2022-04-01',
        str(uuid5(NAMESPACE_URL, GROUP + '/environment-join')), {'properties': {
            'roleName': STEM + '-environment-join-' + config['registry_name'],
            'description': 'Join this existing Container Apps environment only.', 'type': 'CustomRole',
            'assignableScopes': [GROUP], 'permissions': [{'actions': ['Microsoft.App/managedEnvironments/join/action'],
                                                        'notActions': [], 'dataActions': [], 'notDataActions': []}]}})
    grants = {'owner_secrets': (vault, config['owner_object_id'], OFFICER, 'User')}
    grants.update({f'pull-{kind}': (registry, principals.get(kind), PULL, 'ServicePrincipal') for kind in ('api', 'web')})
    for key, (scope, principal, role, kind) in grants.items():
        name = str(uuid5(NAMESPACE_URL, f'{scope}/{principal}/{role}'.lower())) if principal else None
        add(f'grant["{key}"]', 'Microsoft.Authorization/roleAssignments', '2022-04-01', name,
            {'properties': {'roleDefinitionId': f'/subscriptions/{SUBSCRIPTION}/providers/Microsoft.Authorization/roleDefinitions/{role}',
                            'principalId': principal, 'principalType': kind}}, parent=scope)
    return result


def resource_id(row):
    kind = row['type'].split('@')[0]
    if kind == 'Microsoft.Resources/resourceGroups':
        return GROUP
    if kind.startswith('Microsoft.Network/privateDnsZones/'):
        return row['parent_id'] + '/' + kind.rsplit('/', 1)[1] + '/' + row['name']
    return row['parent_id'] + '/providers/' + kind + '/' + row['name']
