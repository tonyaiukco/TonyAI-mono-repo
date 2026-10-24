"""One separately approved ARM phase, durable consumption and bounded status reads."""
import argparse
import copy
import os
from pathlib import Path
import sys
import time

if __name__ == '__main__':
    import tempfile
    _cache = tempfile.TemporaryDirectory(prefix='r3-access-control-cache-')
    sys.pycache_prefix = _cache.name
    sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from r3_access_repair import require, sha256
from r3_access_repair_contract import approve, durable, freshness, load, private_path, vm_target
from r3_noble_common import encoded, read
from r3_access_repair_transport import ArmBearerClient, RequestDeadline
from r3_access_repair_custody import probe, seal, validate_summary
from r3_policy_receive import capture_signals


def model_without_transition(model):
    result = copy.deepcopy(model)
    result.pop('etag', None)
    props = result['properties']
    props.pop('provisioningState', None)
    props['osProfile'].pop('allowExtensionOperations', None)
    return result


def completed_command(body, plan, proposal):
    expected = plan['requests']['repair_body']
    vm = proposal['target_imds']['resourceId']
    require(body['id'].lower() == (vm + '/runCommands/r3-key-' + proposal['packet_id']).lower(), 'COMMAND_ID')
    props = body['properties']
    require(body['location'] == expected['location'] and
            all(encoded(props.get(k)) == encoded(v) for k, v in expected['properties'].items()), 'COMMAND_SOURCE')
    allowed = set(expected['properties']) | {'provisioningState', 'instanceView'}
    require(all(v in (None, '', []) for k, v in props.items() if k not in allowed), 'UNEXPECTED_COMMAND_OPTIONS')
    view = props.get('instanceView', {})
    state = view.get('executionState')
    if state in ('Pending', 'Running', 'Unknown', None):
        return None
    require(state == 'Succeeded' and type(view.get('exitCode')) is int and view['exitCode'] == 0 and
            not view.get('error'), 'COMMAND_FAILED')
    output = view.get('output', '').encode()
    require(0 < len(output) <= 4096, 'SUMMARY_SIZE')
    summary = load(output)
    validate_summary(summary, proposal)
    return summary


def perform(packet, plan, proposal, fresh, phase, approval_hash, adapter, sleep=time.sleep, interrupted=None):
    """Internal orchestration seam. Public entry validates actual source/approval first."""
    require(phase in ('enable', 'repair') and adapter.identity == plan['client'], 'PHASE_CLIENT')
    packet = Path(packet)
    root_identity = private_path(packet, True)
    durable(packet / (phase + '-consumed.json'), {'approval_sha256': approval_hash,
            'delivery_sha256': sha256(read(packet / 'delivery.json')), 'fresh': fresh,
            'attempts': 1, 'phase': phase})
    output = packet / (phase + '-capture')
    output.mkdir(mode=0o700)
    result = {'status': 'PARTIAL_REVIEW_REQUIRED', 'failure': None, 'phase': phase,
              'qualification': False, 'installation_success': False, 'access_verified': False,
              'remote_exit_proven': False, 'guest_summary': None}
    deadline, number = time.monotonic() + 180, 0
    interrupted = [] if interrupted is None else interrupted
    def request(method, url, body=None, headers=None):
        nonlocal number
        require(not interrupted and time.monotonic() < deadline and private_path(packet, True) == root_identity, 'INTERRUPTED_DEADLINE_OR_PATH')
        number += 1
        require(number <= 12, 'REQUEST_COUNT')
        if method in ('PATCH', 'PUT'):
            freshness(fresh)
        durable(output / f'{number:02d}-intent.json', {'method': method, 'url': url,
                'body_sha256': sha256(encoded(body)) if body is not None else None, 'headers': headers})
        response = adapter.request_once(method, url, body, headers)
        # Round-trip strict JSON rejects an invalid adapter response before use.
        response = load(encoded(response))
        durable(output / f'{number:02d}-response.json', response)
        return response
    try:
        probe(plan['custody'], output)
        req = plan['requests']
        vm = request('GET', req['vm'])
        require(vm['status'] == 200 and sha256(encoded(vm['body'])) == fresh['vm_model_sha256'] and
                (vm['etag'] or vm['body'].get('etag')) == fresh['vm_etag'], 'VM_CHANGED')
        vm_target(vm['body'], plan['target'])
        props = vm['body']['properties']
        require(vm['body']['id'].lower() == proposal['target_imds']['resourceId'].lower() and
                props['vmId'] == proposal['target_imds']['vmId'] and
                props['osProfile']['allowExtensionOperations'] is (phase == 'repair'), 'VM_IDENTITY')
        for key in ('extensions', 'commands'):
            response = request('GET', req[key])
            require(response['status'] == 200 and response['body'] == {'value': []}, 'OCCUPIED_DELIVERY')
        if phase == 'enable':
            response = request('PATCH', req['vm'], req['enable_body'], {'If-Match': fresh['vm_etag']})
            require(response['status'] == 200, 'ENABLE_RESPONSE')
        else:
            # The documented PUT is create-or-update; absence + an owner-bound
            # exclusive operator window is NOT an atomic conditional create.
            response = request('GET', req['command'])
            require(response['status'] == 404, 'COMMAND_EXISTS')
            response = request('PUT', req['command'], req['repair_body'])
            require(response['status'] in (200, 201), 'DELIVERY_RESPONSE')
        for _ in range(6):
            require(not interrupted, 'INTERRUPTED')
            sleep(5)
            response = request('GET', req['vm'] if phase == 'enable' else req['status'])
            require(response['status'] == 200, 'STATUS_RESPONSE')
            if phase == 'enable':
                after = response['body']
                require(encoded(model_without_transition(after)) == encoded(model_without_transition(vm['body'])), 'UNEXPECTED_VM_CHANGE')
                if (after['properties']['osProfile']['allowExtensionOperations'] is True and
                        after['properties'].get('provisioningState') == 'Succeeded'):
                    result['status'] = 'EXTENSIONS_ENABLED_REVIEW_REQUIRED'
                    break
            else:
                summary = completed_command(response['body'], plan, proposal)
                if summary is not None:
                    result.update(status='KEY_APPENDED_CUSTODY_REQUIRED', guest_summary=summary)
                    break
    except (Exception, RequestDeadline) as exc:
        result['failure'] = type(exc).__name__
    finally:
        result['request_count'] = number
        if interrupted:
            result.update(status='PARTIAL_REVIEW_REQUIRED', interruption=interrupted[0])
        durable(output / 'result.json', result)
        result['custody'] = seal(plan['custody'], output, packet / (phase + '-capture.tar.age'))
        if not result['custody']['sealed']:
            result['status'] = 'PARTIAL_REVIEW_REQUIRED'
        if interrupted:
            result.update(status='PARTIAL_REVIEW_REQUIRED', interruption=interrupted[0])
        durable(packet / (phase + '-summary.json'), result)
    return result


def execute(packet, approval_raw, approval_hash, fresh_raw, phase):
    os.umask(0o077)
    plan, proposal, fresh = approve(packet, approval_raw, approval_hash, fresh_raw, phase)
    require(phase in ('enable', 'repair'), 'ARM_PHASE')
    with capture_signals() as interrupted:
        return perform(packet, plan, proposal, fresh, phase, approval_hash, ArmBearerClient(plan['client']), interrupted=interrupted)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--packet', type=Path, required=True)
    parser.add_argument('--approval', type=Path, required=True)
    parser.add_argument('--approval-sha256', required=True)
    parser.add_argument('--fresh', type=Path, required=True)
    parser.add_argument('--phase', choices=('enable', 'repair'), required=True)
    parser.add_argument('--execute', action='store_true', required=True)
    args = parser.parse_args()
    value = execute(args.packet, read(args.approval), args.approval_sha256, read(args.fresh), args.phase)
    print(value['status'])
    raise SystemExit(0 if value['status'] != 'PARTIAL_REVIEW_REQUIRED' else 2)
