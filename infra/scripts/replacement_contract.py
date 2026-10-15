"""Exact QA generation inputs and retained resource ownership; no secret fields."""
import re
from uuid import uuid5, NAMESPACE_URL
from selfhost_contract import validate_selfhost, validate_public_key


def validate_inputs(data, phase):
    if set(data) != {'config', 'containment', 'replacement'} or phase not in ('R1', 'R2'):
        raise ValueError('Exact replacement inputs and phase required.')
    config = validate_selfhost({'config': data['config']})
    if data['containment'] is not True:
        raise ValueError('Old-host containment must remain enabled.')
    replacement = data['replacement']
    if phase == 'R1':
        if replacement is not None:
            raise ValueError('Containment must be planned separately from creation.')
    else:
        if not isinstance(replacement, dict) or set(replacement) != {'generation', 'recovery_vault_name', 'ssh_public_key'}:
            raise ValueError('Exact generation inputs required.')
        if replacement['generation'] != 'r02' or not re.fullmatch(r'tonyai-qa-r02-[a-z0-9]{8}', replacement['recovery_vault_name']):
            raise ValueError('Unreviewed generation or vault name.')
        validate_public_key(replacement['ssh_public_key'])
        if replacement['ssh_public_key'] == config['ssh_public_key']:
            raise ValueError('Replacement needs an independent SSH trust key.')
        if config['vm_size'] != 'Standard_D2as_v7':
            raise ValueError('R02 cost and capacity contract is D2as v7.')
    return config


def identities(config):
    stem = 'tonyai-staging-data'
    group = f"/subscriptions/{config['subscription_id']}/resourceGroups/{stem}"
    def resource(kind, name):
        return f'{group}/providers/{kind}/{name}'
    vault = resource('Microsoft.KeyVault/vaults', 'tonyai-qa-rec-' + config['subscription_id'][:8])
    result = {'azapi_resource.group': group,
              'azapi_resource.network': resource('Microsoft.Network/virtualNetworks', stem + '-vnet'),
              'azapi_resource.firewall': resource('Microsoft.Network/networkSecurityGroups', stem + '-nsg'),
              'azapi_resource.nic': resource('Microsoft.Network/networkInterfaces', stem + '-nic'),
              'azapi_resource.public_ip': resource('Microsoft.Network/publicIPAddresses', stem + '-ip'),
              'azapi_resource.scoped_public_ip': resource('Microsoft.Network/publicIPAddresses', stem + '-edge-ip'),
              'azapi_resource.host': resource('Microsoft.Compute/virtualMachines', stem),
              'azapi_resource.recovery_vault': vault,
              'azapi_update_resource.os_disk_export': resource('Microsoft.Compute/disks', stem + '-os')}
    for disk in ('database', 'objects'):
        result[f'azapi_resource.disk["{disk}"]'] = resource('Microsoft.Compute/disks', stem + '-' + disk)
    assignment = str(uuid5(NAMESPACE_URL, f"{vault}/{config['recovery_owner_object_id']}/secrets-officer"))
    result['azapi_resource.recovery_owner'] = vault + '/providers/Microsoft.Authorization/roleAssignments/' + assignment
    for name in ('group', 'public_ip', 'scoped_public_ip'):
        result[f'azapi_resource.delete_lock["{name}"]'] = result['azapi_resource.' + name] + '/providers/Microsoft.Authorization/locks/tonyai-retain-' + name
    return result


def state_projection(state, config):
    expected = identities(config)
    actual = {}
    for resource in state['resources']:
        if resource.get('mode') != 'managed' or resource.get('module'):
            raise ValueError('Unreviewed state ownership.')
        for instance in resource['instances']:
            if instance.get('deposed') or instance.get('status') == 'tainted':
                raise ValueError('Unsettled state.')
            import json
            suffix = '[' + json.dumps(instance['index_key']) + ']' if 'index_key' in instance else ''
            address = resource['type'] + '.' + resource['name'] + suffix
            if address in actual:
                raise ValueError('Duplicate state instance.')
            actual[address] = instance['attributes']['id']
    if actual != expected or not re.fullmatch(r'[a-f0-9-]{36}', state['lineage']) or type(state['serial']) is not int:
        raise ValueError('State is not the exact retained selfhost generation.')
    return {'lineage': state['lineage'], 'serial': state['serial'], 'resources': actual}
