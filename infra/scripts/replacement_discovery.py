"""Read-only collision checks before a create plan/apply; no resource adoption."""
from replacement_plan import CREATE, expected_create
from secure_transport import azure_token, json_request


def check_collisions(inputs):
    token = azure_token('https://management.azure.com')
    origin = 'https://management.azure.com'
    for address in sorted(CREATE):
        spec = expected_create(address, inputs)
        kind, version = spec['type'].split('@')
        resource_id = spec.get('resource_id') or spec['parent_id'] + '/providers/' + kind + '/' + spec['name']
        if json_request(origin + resource_id + '?api-version=' + version, token=token, missing_ok=True) is not None:
            raise ValueError('Replacement name already exists; never adopt it.')
    subscription = '/subscriptions/' + inputs['config']['subscription_id']
    name = inputs['replacement']['recovery_vault_name']
    vault = json_request(origin + subscription + '/providers/Microsoft.KeyVault/checkNameAvailability?api-version=2023-07-01',
                         method='POST', token=token, body={'name': name, 'type': 'Microsoft.KeyVault/vaults'})
    dns = json_request(origin + subscription + '/providers/Microsoft.Network/locations/swedencentral/checkDnsNameAvailability?api-version=2024-05-01&domainNameLabel=tonyai-staging-' + inputs['config']['subscription_id'][:8] + '-r02', token=token)
    if vault.get('nameAvailable') is not True or dns.get('available') is not True:
        raise ValueError('Global-name availability is unconfirmed.')
