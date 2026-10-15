"""Fail-closed R1/R2 plan policy. Values are private; callers print status only."""
from copy import deepcopy
from replacement_contract import identities

NEW = {'replacement_firewall', 'replacement_host', 'replacement_nic', 'replacement_public_ip',
       'replacement_recovery_vault', 'replacement_recovery_owner', 'replacement_ip_lock'}
CREATE = {f'azapi_resource.{name}["r02"]' for name in NEW} | {
    'azapi_resource.replacement_disk["database"]', 'azapi_resource.replacement_disk["objects"]',
    'azapi_update_resource.replacement_os_disk_export["r02"]'}


def rules(operator, ip):
    def rule(name, priority, direction, access, protocol, port, source, destination):
        return {'name': name, 'properties': dict(priority=priority, direction=direction, access=access,
                protocol=protocol, sourcePortRange='*', destinationPortRange=port,
                sourceAddressPrefix=source, destinationAddressPrefix=destination)}
    return [rule('owner-ssh', 100, 'Inbound', 'Allow', 'Tcp', '22', operator, ip),
            rule('deny-other-inbound', 4000, 'Inbound', 'Deny', '*', '*', '*', '*'),
            rule('deny-outbound', 4000, 'Outbound', 'Deny', '*', '*', '*', '*')]


def has_unknown(value):
    if isinstance(value, dict):
        return any(has_unknown(v) for v in value.values())
    if isinstance(value, list):
        return any(has_unknown(v) for v in value)
    return value is True


def validate_plan(plan, inputs, phase):
    if plan.get('errored') or plan.get('complete') is not True or plan.get('deferred_changes') or plan.get('resource_drift'):
        raise ValueError('Incomplete or drifting plan.')
    if plan.get('terraform_version') != '1.13.3':
        raise ValueError('Unpinned Terraform plan.')
    validate_outputs(plan.get('output_changes', {}), inputs, phase)
    expected_old = identities(inputs['config'])
    changes = plan['resource_changes']
    addresses = [item['address'] for item in changes]
    if len(set(addresses)) != len(addresses) or set(addresses) != set(expected_old) | (CREATE if phase == 'R2' else set()):
        raise ValueError('Unexpected or missing resource address.')
    changed = []
    for item in changes:
        change = item['change']; address = item['address']
        if item.get('previous_address') or change.get('importing') or change.get('generated_config'):
            raise ValueError('Imports and moves are prohibited.')
        actions = change['actions']
        if address in expected_old and actions == ['no-op']:
            if phase == 'R2' and address == 'azapi_resource.firewall' and change['after']['body']['properties']['securityRules'] != rules(inputs['config']['operator_ipv4'], '10.80.0.4'):
                raise ValueError('R2 requires already-applied old-host containment.')
            continue
        allowed_update = 'azapi_resource.firewall' if phase == 'R1' else 'azapi_resource.network'
        if address == allowed_update and actions == ['update']:
            validate_update(change, inputs, phase)
        elif phase == 'R2' and address in CREATE and actions == ['create'] and change.get('before') is None:
            validate_create(address, change, inputs)
        else:
            raise ValueError('Destructive or unrelated action refused.')
        changed.append({'address': address, 'actions': actions, 'after': change['after']})
    if len(changed) != (1 if phase == 'R1' else len(CREATE) + 1):
        raise ValueError('Expected full separate phase, not partial/replayed work.')
    return changed


def validate_outputs(outputs, inputs, phase):
    if not {'selfhost_contract'} <= set(outputs) <= {'selfhost_contract', 'replacement_contract'}:
        raise ValueError('Unexpected output contract.')
    old = outputs['selfhost_contract']
    if old['actions'] != ['no-op'] or old['before'] != old['after'] or has_unknown(old.get('after_unknown', False)):
        raise ValueError('The active legacy contract must remain unchanged.')
    new = outputs.get('replacement_contract')
    if phase == 'R1':
        if new and (new['actions'] != ['no-op'] or new.get('before') is not None or new.get('after') is not None or has_unknown(new.get('after_unknown', False))):
            raise ValueError('Containment cannot publish a replacement contract.')
        return
    if not new or new['actions'] != ['create'] or new.get('before') is not None:
        raise ValueError('R2 must publish a separate replacement contract.')
    group = identities(inputs['config'])['azapi_resource.group']
    expected = dict(generation='r02', vm_id=group+'/providers/Microsoft.Compute/virtualMachines/tonyai-staging-data-r02',
        private_ip='10.80.1.4', recovery_vault_url='https://'+inputs['replacement']['recovery_vault_name']+'.vault.azure.net',
        apps_subnet_id=identities(inputs['config'])['azapi_resource.network']+'/subnets/container-apps')
    after=deepcopy(new['after']); unknown=deepcopy(new.get('after_unknown', {}))
    if unknown is False:
        unknown = {}
    if not isinstance(unknown, dict):
        raise ValueError('Unreviewed replacement output.')
    for field in ('public_ip','public_hostname'):
        if not unknown.pop(field, False) and not isinstance(after.get(field), str):
            raise ValueError('Missing Azure public endpoint output.')
        after.pop(field, None)
    if after != expected or has_unknown(unknown):
        raise ValueError('Replacement output differs from the approved generation.')


def validate_update(change, inputs, phase):
    if has_unknown(request_fields(change.get('after_unknown', {}))):
        raise ValueError('Unknown update boundary.')
    expected = request_fields(change['before'])
    if phase == 'R1':
        expected['body']['properties']['securityRules'] = rules(inputs['config']['operator_ipv4'], '10.80.0.4')
    else:
        properties = expected['body']['properties']
        subnets = properties['subnets']
        if len(subnets) != 2 or [s['name'] for s in subnets] != ['supabase', 'container-apps']:
            raise ValueError('Unexpected existing subnet ownership.')
        group = identities(inputs['config'])['azapi_resource.group']
        subnets.append({'name': 'supabase-r02', 'properties': {'addressPrefix': '10.80.1.0/24',
            'defaultOutboundAccess': False, 'networkSecurityGroup': {'id': group + '/providers/Microsoft.Network/networkSecurityGroups/tonyai-staging-data-r02-nsg'}}})
    if request_fields(change['after']) != expected:
        raise ValueError('Only the exact containment or subnet append is allowed.')


def expected_create(address, inputs):
    import json
    from pathlib import Path
    from uuid import uuid5, NAMESPACE_URL
    values = {**inputs['config'], **inputs['replacement']}
    group = identities(inputs['config'])['azapi_resource.group']
    vault = group + '/providers/Microsoft.KeyVault/vaults/' + values['recovery_vault_name']
    values['subscription_prefix'] = values['subscription_id'][:8]
    values['recovery_assignment_id'] = str(uuid5(NAMESPACE_URL, vault + '/' + values['recovery_owner_object_id'] + '/secrets-officer'))
    policy = json.loads((Path(__file__).resolve().parents[1] / 'selfhost/replacement-resource-policy.json').read_text())
    def render(value):
        if isinstance(value, dict):
            return {k: render(v) for k, v in value.items()}
        if isinstance(value, list):
            return [render(v) for v in value]
        if isinstance(value, str):
            for key, content in values.items():
                value = value.replace('${' + key + '}', str(content))
            if '${' in value:
                raise ValueError('Unresolved resource policy input.')
        return value
    return render(policy[address])


def request_fields(value):
    value = deepcopy(value)
    for key in ('id', 'output'):
        value.pop(key, None)
    if isinstance(value.get('identity'), list):
        for identity in value['identity']:
            for key in ('principal_id', 'tenant_id'):
                identity.pop(key, None)
    return value


def validate_create(address, change, inputs):
    unknown = request_fields(change.get('after_unknown', {}))
    nonregional = address in {'azapi_resource.replacement_recovery_owner["r02"]', 'azapi_resource.replacement_ip_lock["r02"]'}
    if nonregional:
        for field in ('location', 'tags'):
            unknown.pop(field, None)
    if address.startswith('azapi_update_resource.'):
        for field in ('name', 'parent_id'):
            unknown.pop(field, None)
    if has_unknown(unknown):
        raise ValueError('Unknown creation request field.')
    actual = request_fields(change['after'])
    expected = expected_create(address, inputs)
    if nonregional:
        for field in ('location', 'tags'):
            if actual.get(field) not in (None, '', {}):
                raise ValueError('Nonregional resources cannot carry location or tags.')
            actual.pop(field, None)
            expected.pop(field, None)
    if address.startswith('azapi_update_resource.'):
        derived = {'name': expected['resource_id'].rsplit('/', 1)[1], 'parent_id': expected['resource_id'].rsplit('/providers/', 1)[0]}
        for field, value in derived.items():
            if field in actual and actual[field] != value:
                raise ValueError('Update resource derived identity differs.')
            actual.pop(field, None)
    if actual != expected:
        raise ValueError('Creation differs from the exact reviewed resource policy.')
