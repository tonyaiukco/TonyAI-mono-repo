"""Reject unprojected metadata and credential-bearing extra fields at every depth."""
from qa_contract import require

RULE = dict(name='str', priority='int', direction='str', access='str', protocol='str',
            source_ports=['str'], source_port='?str', destination_ports=['str'], destination_port='?str',
            sources=['str'], source='?str', destinations=['str'], destination='?str',
            source_groups=['str'], destination_groups=['str'])
SHAPES = {
    'account': dict(subscription_id='str', tenant_id='str'),
    'resources': [dict(id='str', type='str', location='?str')],
    'environments': [dict(id='str', location='str', subnet_id='?str')],
    'host': dict(id='str', location='str', vm_id='str', provisioning_state='str', nic_ids=['str'], os_disk_id='str',
                 data_disks=[dict(id='str', lun='int')], image=dict(publisher='?str', offer='?str', sku='?str', version='?str', exact_version='?str', id='?str')),
    'nic': dict(id='str', location='str', nsg_id='?str', forwarding='bool', ip_configurations=[dict(private_ip='str', allocation='str', subnet_id='str', public_ip_id='?str')]),
    'disks': [dict(id='str', location='str', managed_by='?str', unique_id='str', size='int', encryption='str', network_access='str', public_network='str')],
    'network': dict(id='str', location='str', prefixes=['str'], dns_servers=['str'],
        peerings=[dict(id='str', remote_vnet='str', forwarded='bool', gateway_transit='bool', remote_gateways='bool', access='bool')],
        subnets=[dict(id='str', prefix='str', prefixes=['str'], delegations=['str'], ip_configuration_count='int',
            association_count='int', resource_navigation_count='int', nsg_id='?str', route_table_id='?str', default_outbound_access='?bool')]),
    'nsgs': [dict(id='str', location='str', rules=[RULE], defaults=[RULE])],
    'routes': [dict(id='str', location='str', disable_bgp='bool', routes=[dict(name='str', prefix='str', next_hop='str', next_hop_ip='?str')])],
    'zones': [dict(id='str', location='str')],
    'backend': dict(id='str', location='str', shared_key='bool', https_only='bool', tls='str', public_network='str', default_action='str'),
    'containers': [dict(id='str', name='str', public_access='str')],
    'blobs_foundation': [dict(name='str', etag='str', last_modified='str', size='int', lease='str')],
    'blobs_application': [dict(name='str', etag='str', last_modified='str', size='int', lease='str')],
}


def shape_for(key):
    if key.startswith('dns_links_'):
        return [dict(id='str', vnet_id='str', registration='bool')]
    if key.startswith('dns_a_'):
        return [dict(id='str', ttl='int', addresses=['str'])]
    return SHAPES[key]


def validate_shape(value, shape):
    if isinstance(shape, dict):
        require(isinstance(value, dict) and set(value) == set(shape))
        for key, child in shape.items():
            validate_shape(value[key], child)
    elif isinstance(shape, list):
        # Nullable ARM arrays are normalized by the projection query, not here.
        require(isinstance(value, list) and len(value) <= 10000)
        for row in value:
            validate_shape(row, shape[0])
        if value and isinstance(value[0], dict):
            key = 'id' if 'id' in value[0] else 'name' if 'name' in value[0] else None
            if key:
                require(len({v[key].lower() for v in value}) == len(value))
    else:
        if shape.startswith('?') and value is None:
            return
        kind = {'str': str, 'int': int, 'bool': bool}[shape.lstrip('?')]
        require(type(value) is kind)
        if kind is str:
            require(len(value) <= 4096 and not any(ord(c) < 32 for c in value))
        if kind is int:
            require(value >= 0)
