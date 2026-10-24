"""Strict local contracts for separately approved repair phases; no network I/O."""
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import stat

from r3_access_repair import require, sha256
from r3_noble_common import encoded, read

API = '2025-04-01'
PURPOSE = 'R3_MANAGED_ACCESS_RECOVERY'
ACTIONS = {'enable': 'ONE_EXTENSION_ENABLE', 'repair': 'ONE_MANAGED_KEY_APPEND',
           'export': 'ONE_REPAIR_EVIDENCE_FETCH'}
VM_PATTERN = (r'/subscriptions/[a-f0-9-]{36}/resourceGroups/[A-Za-z0-9_.()-]{1,90}'
              r'/providers/Microsoft.Compute/virtualMachines/[A-Za-z0-9_-]{1,64}')


def load(raw):
    require(isinstance(raw, bytes) and len(raw) <= 2 * 1024 * 1024, 'DOCUMENT_SIZE')
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, 'DUPLICATE_KEY')
            value[key] = item
        return value
    def number(text):
        value = float(text)
        require(math.isfinite(value), 'NONFINITE')
        return value
    def constant(_text):
        raise ValueError('NONFINITE')
    return json.loads(raw, object_pairs_hook=pairs, parse_float=number, parse_constant=constant)


def private_path(path, directory=False):
    path = Path(path)
    require(path.is_absolute() and str(path.resolve()) == str(path), 'CANONICAL_PATH')
    info = path.lstat()
    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600), 'PRIVATE_MODE')
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'PRIVATE_TYPE')
    return info.st_dev, info.st_ino


def durable(path, value):
    """Never overwrite; an uncertain persistence outcome never permits retry."""
    data = encoded(value)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        require(os.write(fd, data) == len(data), 'SHORT_RECORD')
        os.fsync(fd)
    finally:
        os.close(fd)
    parent = os.open(Path(path).parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def freshness(fresh, now=None):
    stamp = datetime.fromisoformat(fresh['observed_at'])
    require(stamp.tzinfo is not None, 'FRESH_TIMEZONE')
    age = ((now or datetime.now(timezone.utc)) - stamp).total_seconds()
    require(0 <= age <= 900, 'STALE_READBACK')


def endpoint(vm, suffix='', expand=False):
    require(isinstance(vm, str) and re.fullmatch(VM_PATTERN, vm), 'VM_RESOURCE_ID')
    return 'https://management.azure.com' + vm + suffix + '?api-version=' + API + ('&$expand=instanceView' if expand else '')


def requests(proposal, guest):
    vm = proposal['target_imds']['resourceId']
    name = 'r3-key-' + proposal['packet_id']
    # The quoted delimiter cannot occur in the generated Python source.
    delimiter = 'R3_' + sha256(guest)
    require(delimiter.encode() not in guest and b'\0' not in guest, 'SCRIPT_DELIMITER')
    script = "#!/bin/sh\nset -eu\nexec /usr/bin/python3 -I -B - <<'" + delimiter + "'\n" + guest.decode('ascii') + '\n' + delimiter + '\n'
    body = {'location': proposal['target_imds']['location'], 'properties': {
        'source': {'script': script}, 'asyncExecution': False,
        'timeoutInSeconds': 60, 'treatFailureAsDeploymentFailure': True}}
    return {'vm': endpoint(vm), 'extensions': endpoint(vm, '/extensions'),
            'commands': endpoint(vm, '/runCommands'),
            'command': endpoint(vm, '/runCommands/' + name),
            'status': endpoint(vm, '/runCommands/' + name, True),
            'enable_body': {'properties': {'osProfile': {'allowExtensionOperations': True}}},
            'repair_body': body}


def target_custody(plan, proposal):
    from r3_access_repair_custody import custody_inputs
    from r3_policy_receive import known_host
    import ipaddress
    target = plan['target']
    require(isinstance(target, dict) and set(target) == {'imds', 'connection', 'control_plane'} and
            target['imds'] == proposal['target_imds'], 'TARGET_BINDING')
    conn, cp, imds = target['connection'], target['control_plane'], target['imds']
    require(set(conn) == {'host', 'user'} and conn['user'] == 'tonyaiops' and
            str(ipaddress.IPv4Address(conn['host'])) == conn['host'], 'CONNECTION')
    require(set(cp) == {'tenant', 'subscription', 'vm_id', 'vm_uuid', 'location', 'image', 'disks',
            'public_ip', 'private_ip', 'network'} and all(cp.values()), 'CONTROL_PLANE')
    require(cp['vm_id'] == imds['resourceId'] and cp['vm_uuid'] == imds['vmId'] and
            cp['subscription'] == imds['subscriptionId'] and cp['location'] == imds['location'] == 'swedencentral' and
            conn['host'] in (cp['public_ip'], cp['private_ip']), 'CROSS_IDENTITY')
    require(set(cp['image']) == {'publisher', 'offer', 'sku', 'version', 'exactVersion'} and
            all(cp['image'][k] == imds[k] for k in ('publisher', 'offer', 'sku')) and
            cp['image']['exactVersion'] == imds['version'], 'IMAGE_BINDING')
    require(isinstance(cp['disks'], list) and len(cp['disks']) == 3 and
            all(isinstance(disk, dict) for disk in cp['disks']) and isinstance(cp['network'], dict), 'TARGET_SHAPE')
    custody_inputs(plan['custody'])
    custody = plan['custody']
    require(custody['ssh_public_key_sha256'] == proposal['public_key_sha256'] and
            read(custody['ssh_public_key'], 16384) == proposal['public_key'].encode(), 'APPENDED_LOGIN_KEY')
    known_host(read(custody['known_hosts'], 16384), conn['host'])
    require(plan['client']['tenant'] == cp['tenant'], 'CLIENT_TENANT')


def vm_target(model, target):
    cp, imds = target['control_plane'], target['imds']
    props = model['properties']
    require(model['id'].lower() == imds['resourceId'].lower() and props['vmId'] == imds['vmId'] and
            model['location'] == imds['location'], 'VM_IDENTITY')
    storage = props['storageProfile']
    image = storage['imageReference']
    require(all(image[k] == cp['image'][k] for k in ('publisher', 'offer', 'sku', 'version')) and
            image.get('exactVersion', image['version']) == imds['version'], 'VM_IMAGE')
    observed = [(None, storage['osDisk']), *((disk['lun'], disk) for disk in storage['dataDisks'])]
    require(len(observed) == len(cp['disks']) == 3, 'VM_DISK_COUNT')
    for lun, disk in observed:
        matches = [value for value in cp['disks'] if value['lun'] == lun]
        require(len(matches) == 1 and (lun is None or type(lun) is int), 'VM_DISK_LUN')
        expected = matches[0]
        require(disk['managedDisk']['id'].lower() == expected['id'].lower() and
                type(disk['diskSizeGB']) is int and disk['diskSizeGB'] == expected['size_gb'] and
                disk['managedDisk']['storageAccountType'] == expected['sku'], 'VM_DISK_BINDING')
    nics = props['networkProfile']['networkInterfaces']
    require(len(nics) == 1 and nics[0]['id'].lower() == cp['network']['nic_id'].lower(), 'VM_NIC')


def approve(packet, approval_raw, approval_hash, fresh_raw, phase):
    """Resolve source, exact bytes, owner authority and live bindings before I/O."""
    from r3_access_repair_packet import ROOT, source_map, payload, export_payload
    from r3_policy_git import verified_head
    from r3_access_repair_guest import validate
    packet = Path(packet)
    private_path(packet, True)
    require(phase in ACTIONS and sha256(approval_raw) == approval_hash, 'APPROVAL_HASH')
    approval = load(approval_raw)
    plan_raw = read(packet / 'delivery.json')
    plan = load(plan_raw)
    proposal_raw = read(packet / 'proposal.json')
    proposal = load(proposal_raw)
    validate(proposal)
    require(plan['format'] == 1 and type(plan['format']) is int and plan['purpose'] == PURPOSE, 'PLAN_PURPOSE')
    require(plan['proposal_sha256'] == sha256(proposal_raw) and plan['packet_path'] == str(packet), 'PACKET_BINDING')
    require(plan['handler_trust'] == 'MICROSOFT_MANAGED_ACCEPTED_BY_OWNER', 'HANDLER_TRUST')
    require(isinstance(plan['design_decision_sha256'], str) and
            re.fullmatch('[a-f0-9]{64}', plan['design_decision_sha256']), 'DESIGN_DECISION')
    require(proposal['source']['files'] == source_map() and
            verified_head(ROOT, source_map()) == proposal['source']['published_sha'], 'PUBLISHED_SOURCE')
    guest, export = read(packet / 'guest.py'), read(packet / 'export.py')
    require(guest == payload(proposal) and export == export_payload(proposal) and
            plan['guest_sha256'] == sha256(guest) and plan['export_sha256'] == sha256(export), 'PAYLOAD_BINDING')
    require(plan['requests'] == requests(proposal, guest), 'REQUEST_BINDING')
    expected = {'action', 'packet_path', 'delivery_sha256', 'fresh_sha256', 'attempts', 'owner_authorization_reference'}
    require(set(approval) == expected and approval['action'] == ACTIONS[phase] and
            approval['packet_path'] == str(packet) and approval['delivery_sha256'] == sha256(plan_raw) and
            approval['fresh_sha256'] == sha256(fresh_raw) and type(approval['attempts']) is int and
            approval['attempts'] == 1 and isinstance(approval['owner_authorization_reference'], str) and
            0 < len(approval['owner_authorization_reference']) <= 2000, 'EXACT_APPROVAL')
    fresh = load(fresh_raw)
    freshness(fresh)
    require(encoded(fresh['target']) == encoded(plan['target']) and fresh['target']['imds'] == proposal['target_imds'], 'FRESH_TARGET')
    require(fresh['exclusive_operator_window'] is True, 'CONCURRENT_OPERATOR')
    require(plan['client'] is not None and fresh['client'] == plan['client'], 'CLIENT_BINDING')
    target_custody(plan, proposal)
    require(isinstance(fresh['vm_etag'], str) and re.fullmatch(r'[\x20-\x7e]{1,256}', fresh['vm_etag']), 'ETAG')
    require(isinstance(fresh['vm_model_sha256'], str) and re.fullmatch('[a-f0-9]{64}', fresh['vm_model_sha256']), 'VM_MODEL_HASH')
    if phase in ('enable', 'repair'):
        require(fresh['extensions'] == [] and fresh['run_commands'] == [], 'EXISTING_DELIVERY')
        require(fresh['allow_extension_operations'] is (phase == 'repair'), 'EXTENSION_STATE')
    else:
        require(isinstance(fresh['extensions'], list) and len(fresh['extensions']) <= 4 and
                fresh['run_commands'] == [proposal['target_imds']['resourceId'] + '/runCommands/r3-key-' + proposal['packet_id']],
                'EXPORT_DELIVERY_SCOPE')
        require(stat.S_ISSOCK(os.stat(os.environ.get('SSH_AUTH_SOCK', '')).st_mode), 'SSH_AGENT_SOCKET')
    return plan, proposal, fresh
