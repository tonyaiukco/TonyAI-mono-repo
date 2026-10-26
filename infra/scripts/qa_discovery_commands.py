"""Fixed nonsecret read projections. Produces argv only; never executes Azure CLI."""
from qa_contract import SUBSCRIPTION, fields, match, require
from qa_foundation_expected import DATA_GROUP, VM, VNET
from qa_foundation_inputs import UUID

SUB = '/subscriptions/' + SUBSCRIPTION
ARM = 'https://management.azure.com'
RULE = '{name:name,priority:properties.priority,direction:properties.direction,access:properties.access,protocol:properties.protocol,source_ports:(properties.sourcePortRanges || `[]`),source_port:properties.sourcePortRange,destination_ports:(properties.destinationPortRanges || `[]`),destination_port:properties.destinationPortRange,sources:(properties.sourceAddressPrefixes || `[]`),source:properties.sourceAddressPrefix,destinations:(properties.destinationAddressPrefixes || `[]`),destination:properties.destinationAddressPrefix,source_groups:(properties.sourceApplicationSecurityGroups[].id || `[]`),destination_groups:(properties.destinationApplicationSecurityGroups[].id || `[]`)}'


def request_contract(request):
    fields(request, 'source_sha tenant_id backend_account backend_group dns_zones')
    match(r'[a-f0-9]{40}', request['source_sha'])
    match(UUID, request['tenant_id'])
    match(r'[a-z0-9]{3,24}', request['backend_account'])
    match(r'[A-Za-z0-9_-]{1,90}', request['backend_group'])
    require(isinstance(request['dns_zones'], list) and len(request['dns_zones']) <= 100)
    for zone in request['dns_zones']:
        fields(zone, 'group name')
        match(r'[A-Za-z0-9_-]{1,90}', zone['group'])
        match(r'[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]', zone['name'])
    require(len({(z['group'].lower(), z['name']) for z in request['dns_zones']}) == len(request['dns_zones']))
    return request


def zone_ids(request):
    return [SUB + '/resourceGroups/' + zone['group'] + '/providers/Microsoft.Network/privateDnsZones/' + zone['name']
            for zone in sorted(request['dns_zones'], key=lambda z: (z['group'], z['name']))]


def commands(request):
    request_contract(request)
    result = {}

    def rest(key, path, version, query, paged=False):
        url = ARM + path + '?api-version=' + version
        query = '{items:value[].' + query + ',next_link:nextLink}' if paged else query
        result[key] = {'argv': ['az', 'rest', '--method', 'GET', '--url', url, '--query', query,
                                '--subscription', SUBSCRIPTION, '--only-show-errors', '--output', 'json'],
                       'pagination': 'arm' if paged else 'single'}

    result['account'] = {'argv': ['az', 'account', 'show', '--subscription', SUBSCRIPTION,
        '--query', '{subscription_id:id,tenant_id:tenantId}', '--only-show-errors', '--output', 'json'], 'pagination': 'single'}
    rest('resources', SUB + '/resources', '2021-04-01', '{id:id,type:type,location:location}', True)
    rest('environments', SUB + '/providers/Microsoft.App/managedEnvironments', '2025-01-01',
         '{id:id,location:location,subnet_id:properties.vnetConfiguration.infrastructureSubnetId}', True)
    rest('host', VM, '2024-03-01', '{id:id,location:location,vm_id:properties.vmId,provisioning_state:properties.provisioningState,nic_ids:properties.networkProfile.networkInterfaces[].id,os_disk_id:properties.storageProfile.osDisk.managedDisk.id,data_disks:properties.storageProfile.dataDisks[].{id:managedDisk.id,lun:lun},image:properties.storageProfile.imageReference.{publisher:publisher,offer:offer,sku:sku,version:version,exact_version:exactVersion,id:id}}')
    rest('nic', DATA_GROUP + '/providers/Microsoft.Network/networkInterfaces/tonyai-staging-data-r02-nic', '2024-05-01',
         '{id:id,location:location,nsg_id:properties.networkSecurityGroup.id,forwarding:properties.enableIPForwarding,ip_configurations:properties.ipConfigurations[].{private_ip:properties.privateIPAddress,allocation:properties.privateIPAllocationMethod,subnet_id:properties.subnet.id,public_ip_id:properties.publicIPAddress.id}}')
    rest('disks', SUB + '/providers/Microsoft.Compute/disks', '2024-03-02',
         '{id:id,location:location,managed_by:managedBy,unique_id:properties.uniqueId,size:properties.diskSizeGB,encryption:properties.encryption.type,network_access:properties.networkAccessPolicy,public_network:properties.publicNetworkAccess}', True)
    rest('network', VNET, '2024-05-01',
         '{id:id,location:location,prefixes:properties.addressSpace.addressPrefixes,dns_servers:(properties.dhcpOptions.dnsServers || `[]`),peerings:(properties.virtualNetworkPeerings || `[]`)[].{id:id,remote_vnet:properties.remoteVirtualNetwork.id,forwarded:properties.allowForwardedTraffic,gateway_transit:properties.allowGatewayTransit,remote_gateways:properties.useRemoteGateways,access:properties.allowVirtualNetworkAccess},subnets:properties.subnets[].{id:id,prefix:properties.addressPrefix,prefixes:(properties.addressPrefixes || `[]`),delegations:(properties.delegations[].properties.serviceName || `[]`),ip_configuration_count:length(properties.ipConfigurations || `[]`),association_count:length(properties.serviceAssociationLinks || `[]`),resource_navigation_count:length(properties.resourceNavigationLinks || `[]`),nsg_id:properties.networkSecurityGroup.id,route_table_id:properties.routeTable.id,default_outbound_access:properties.defaultOutboundAccess}}')
    rest('nsgs', SUB + '/providers/Microsoft.Network/networkSecurityGroups', '2024-05-01',
         '{id:id,location:location,rules:properties.securityRules[].' + RULE + ',defaults:properties.defaultSecurityRules[].' + RULE + '}', True)
    rest('routes', SUB + '/providers/Microsoft.Network/routeTables', '2024-05-01',
         '{id:id,location:location,disable_bgp:properties.disableBgpRoutePropagation,routes:properties.routes[].{name:name,prefix:properties.addressPrefix,next_hop:properties.nextHopType,next_hop_ip:properties.nextHopIpAddress}}', True)
    rest('zones', SUB + '/providers/Microsoft.Network/privateDnsZones', '2024-06-01', '{id:id,location:location}', True)
    for index, zone_id in enumerate(zone_ids(request)):
        rest(f'dns_links_{index}', zone_id + '/virtualNetworkLinks', '2024-06-01',
             '{id:id,vnet_id:properties.virtualNetwork.id,registration:properties.registrationEnabled}', True)
        rest(f'dns_a_{index}', zone_id + '/A', '2024-06-01',
             '{id:id,ttl:properties.ttl,addresses:properties.aRecords[].ipv4Address}', True)
    backend = SUB + '/resourceGroups/' + request['backend_group'] + '/providers/Microsoft.Storage/storageAccounts/' + request['backend_account']
    rest('backend', backend, '2023-05-01',
         '{id:id,location:location,shared_key:properties.allowSharedKeyAccess,https_only:properties.supportsHttpsTrafficOnly,tls:properties.minimumTlsVersion,public_network:properties.publicNetworkAccess,default_action:properties.networkAcls.defaultAction}')
    rest('containers', backend + '/blobServices/default/containers', '2023-05-01',
         '{id:id,name:name,public_access:properties.publicAccess}', True)
    for name in ('foundation', 'application'):
        result['blobs_' + name] = {'argv': ['az', 'storage', 'blob', 'list', '--auth-mode', 'login',
            '--account-name', request['backend_account'], '--container-name', name, '--num-results', '*',
            '--subscription', SUBSCRIPTION, '--query', '[].{name:name,etag:properties.etag,last_modified:properties.lastModified,size:properties.contentLength,lease:properties.lease.state}',
            '--only-show-errors', '--output', 'json'], 'pagination': 'sdk-all'}
    return result
