"""Synthetic public QA fixtures, never owner execution inputs."""
from copy import deepcopy
from qa_contract import SUBSCRIPTION
from qa_foundation_inputs import initial_inputs
from qa_foundation_expected import DATA_GROUP, VM, VNET, expected
from qa_foundation_plan import DEFAULT_OPTIONS, EMPTY_OPTIONS
from qa_discovery import digest, manifest

TENANT = '00000000-0000-0000-0000-000000000002'
PRINCIPALS = {'api': '00000000-0000-0000-0000-000000000004', 'web': '00000000-0000-0000-0000-000000000005'}
STAMP = '2026-10-26T12:00:00Z'


def inputs():
    return {'config': dict(subscription_id=SUBSCRIPTION, tenant_id=TENANT,
        owner_object_id='00000000-0000-0000-0000-000000000003', registry_name='tonyaiqatest',
        vault_name='tonyai-qa-test', release_sha='a' * 40, oidc_enabled=False,
        runtime_secrets_ready=False, smtp_secret_ready=False, apps_ready=False)}


def plan():
    config = initial_inputs(inputs())
    changes = []
    for address, wanted in expected(config, PRINCIPALS).items():
        after = {**deepcopy(wanted), **DEFAULT_OPTIONS, **dict.fromkeys(EMPTY_OPTIONS), 'identity': []}
        if address.startswith('azapi_resource.identity['):
            kind = 'api' if '"api"' in address else 'web'
            after['output'] = {'properties': {'principalId': PRINCIPALS[kind]}}
        changes.append(dict(address=address, mode='managed', type='azapi_resource', provider_name='registry.terraform.io/azure/azapi',
            change=dict(actions=['create'], before=None, after=after, after_unknown={})))
    contract = dict(subscription_id=SUBSCRIPTION, tenant_id=TENANT, environment='staging', region='swedencentral',
        resource_group='tonyai-staging-apps', prefix='tonyai', registry_name=config['registry_name'], vault_name=config['vault_name'],
        default_domain='example.swedencentral.azurecontainerapps.io', apps_subnet_id=VNET + '/subnets/container-apps')
    return dict(terraform_version='1.13.3', format_version='1.2', complete=True, errored=False, applyable=True,
        variables={'config': {'value': config}}, resource_changes=changes,
        output_changes={'application_contract': {'actions': ['create'], 'after': contract, 'after_unknown': {}},
                        'oidc_client_id': {'actions': ['no-op'], 'after': None, 'after_unknown': False}})


def request():
    return dict(source_sha='a' * 40, tenant_id=TENANT, backend_account='syntheticqastate', backend_group='synthetic-backend', dns_zones=[])


def discovery_data():
    nic = DATA_GROUP + '/providers/Microsoft.Network/networkInterfaces/tonyai-staging-data-r02-nic'
    nsg = DATA_GROUP + '/providers/Microsoft.Network/networkSecurityGroups/tonyai-staging-data'
    backend = f'/subscriptions/{SUBSCRIPTION}/resourceGroups/synthetic-backend/providers/Microsoft.Storage/storageAccounts/syntheticqastate'
    subnets = []
    for name, prefix, suffix in [('supabase', '10.80.0.0/24', '-nsg'), ('supabase-r02', '10.80.1.0/24', '-r02-nsg'), ('container-apps', '10.80.2.0/23', '')]:
        subnets.append(dict(id=VNET + '/subnets/' + name, prefix=prefix, prefixes=[],
            delegations=['Microsoft.App/environments'] if not suffix else [], ip_configuration_count=0,
            association_count=0, resource_navigation_count=0, nsg_id=nsg + suffix if suffix else None,
            route_table_id=None, default_outbound_access=False if suffix else None))
    resources = [(VM, 'Microsoft.Compute/virtualMachines'), (nic, 'Microsoft.Network/networkInterfaces'),
                 (VNET, 'Microsoft.Network/virtualNetworks'), (backend, 'Microsoft.Storage/storageAccounts'),
                 (nsg + '-nsg', 'Microsoft.Network/networkSecurityGroups'), (nsg + '-r02-nsg', 'Microsoft.Network/networkSecurityGroups')]
    disks = [dict(id=DATA_GROUP + '/providers/Microsoft.Compute/disks/tonyai-staging-data-r02-' + name,
                  location='swedencentral', managed_by=VM, unique_id='synthetic-' + name, size=64,
                  encryption='EncryptionAtRestWithPlatformKey', network_access='DenyAll', public_network='Disabled')
             for name in ('os', 'database', 'objects')]
    resources.extend((d['id'], 'Microsoft.Compute/disks') for d in disks)
    return dict(account=dict(subscription_id=SUBSCRIPTION, tenant_id=TENANT),
        resources=[dict(id=i, type=t, location='swedencentral') for i, t in resources], environments=[],
        host=dict(id=VM, location='swedencentral', vm_id='00000000-0000-0000-0000-000000000099', provisioning_state='Succeeded', nic_ids=[nic],
                  os_disk_id=disks[0]['id'], data_disks=[dict(id=d['id'], lun=i) for i, d in enumerate(disks[1:])],
                  image=dict(publisher='Canonical', offer='ubuntu', sku='noble', version='pinned', exact_version='pinned', id=None)),
        disks=disks,
        nic=dict(id=nic, location='swedencentral', nsg_id=None, forwarding=False, ip_configurations=[dict(private_ip='10.80.1.4', allocation='Static', subnet_id=VNET + '/subnets/supabase-r02', public_ip_id=None)]),
        network=dict(id=VNET, location='swedencentral', prefixes=['10.80.0.0/16'], dns_servers=[], peerings=[], subnets=subnets),
        nsgs=[dict(id=nsg + suffix, location='swedencentral', rules=[], defaults=[]) for suffix in ('-nsg', '-r02-nsg')],
        routes=[], zones=[], backend=dict(id=backend, location='swedencentral', shared_key=False, https_only=True, tls='TLS1_2', public_network='Enabled', default_action='Allow'),
        containers=[dict(id=backend + '/blobServices/default/containers/' + n, name=n, public_access='None') for n in ('foundation', 'application')],
        blobs_foundation=[dict(name='staging-selfhost.tfstate', etag='synthetic-etag', last_modified=STAMP, size=100, lease='available')], blobs_application=[])


def record(key, spec, result):
    if spec['pagination'] == 'arm':
        result = {'items': result, 'next_link': None}
    return dict(key=key, complete=True, pages=[dict(argv_sha256=digest(spec['argv']), exit_code=0,
        started_at=STAMP, completed_at=STAMP, result=result, result_sha256=digest(result))])


def bundle():
    return make_bundle(request(), discovery_data())


def make_bundle(req, data):
    spec = manifest(req)
    return dict(schema=1, source_sha='a' * 40, manifest_sha256=digest(spec), started_at=STAMP, completed_at=STAMP,
                records=[record(k, v, data[k]) for k, v in spec['commands'].items()])
