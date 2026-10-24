"""Exact retained-diagnostic amendment; no I/O or guest identity normalization."""
import copy
import re

from r3_access_repair import require, sha256
from r3_noble_common import encoded

PURPOSE = 'R3_EXACT_LOCATION_RECOVERY_AMENDMENT'


def historical(amendment):
    from r3_access_identity_diagnostic import validate_proposal, validate_report
    from r3_access_repair_contract import PURPOSE as DELIVERY, validate_prior_command
    require(isinstance(amendment, dict) and set(amendment) == {
        'format', 'purpose', 'diagnostic_delivery', 'diagnostic_proposal', 'diagnostic_delivery_sha256',
        'diagnostic_report', 'diagnostic_report_sha256', 'failed_summary', 'failed_summary_sha256',
        'decision_sha256'}, 'AMENDMENT_SHAPE')
    require(type(amendment['format']) is int and amendment['format'] == 1 and
            amendment['purpose'] == PURPOSE and len(encoded(amendment)) <= 1536 * 1024, 'AMENDMENT_PURPOSE')
    for name in ('diagnostic_delivery_sha256', 'diagnostic_report_sha256', 'failed_summary_sha256', 'decision_sha256'):
        require(isinstance(amendment[name], str) and re.fullmatch('[a-f0-9]{64}', amendment[name]), 'AMENDMENT_HASH')
    delivery, proposal, report = (amendment[key] for key in
                                ('diagnostic_delivery', 'diagnostic_proposal', 'diagnostic_report'))
    validate_proposal(proposal)
    require(isinstance(delivery, dict) and delivery.get('format') == 1 and type(delivery['format']) is int and
            delivery.get('purpose') == DELIVERY and 'amendment' not in delivery and
            sha256(encoded(delivery)) == amendment['diagnostic_delivery_sha256'] and
            delivery.get('proposal_sha256') == sha256(encoded(proposal)) and
            delivery.get('target', {}).get('imds') == proposal['target_imds'], 'AMENDMENT_DIAGNOSTIC_PACKET')
    from r3_access_repair_history import validate_payload
    validate_payload(delivery, proposal, diagnostic=True)
    prior = delivery['prior_command']
    validate_prior_command(prior, proposal)
    validate_payload(prior['delivery'], prior['proposal'], diagnostic=False)
    require('amendment' not in prior['delivery'] and
            prior['delivery']['target'] == delivery['target'] and
            prior['proposal']['public_key'] == proposal['public_key'] and
            prior['proposal']['public_key_sha256'] == proposal['public_key_sha256'] and
            prior['delivery']['custody'] == delivery['custody'], 'AMENDMENT_PREDECESSOR_CHAIN')
    validate_report(report, proposal)
    require(sha256(encoded(report)) == amendment['diagnostic_report_sha256'] and report['error'] is None and
            report['stage'] == 'comparison' and report['identity_matches_expected'] is False, 'AMENDMENT_REPORT')
    fields = report['field_observations']
    require(proposal['target_imds']['location'] == delivery['target']['control_plane']['location'] == 'swedencentral' and
            fields['location']['value'] == 'SwedenCentral' and fields['location']['case_only_difference'] is True and
            fields['location']['exact_match'] is False and
            all(item['exact_match'] is True for key, item in fields.items() if key != 'location'), 'AMENDMENT_LOCATION_ONLY')
    failed = amendment['failed_summary']
    require(isinstance(failed, dict) and set(failed) == {'status', 'phase', 'failure', 'cleanup_errors',
        'access_verified', 'qualification', 'installation_success', 'evidence_path',
        'pre_close_result_sha256', 'finalization', 'identity_stable', 'append'} and
        sha256(encoded(failed)) == amendment['failed_summary_sha256'], 'AMENDMENT_FAILED_SUMMARY')
    require(failed['status'] == 'REFUSED_REVIEW_REQUIRED' and failed['phase'] == 'identity-before' and
            failed['failure'] == 'ValueError' and failed['cleanup_errors'] == [] and
            failed['finalization'] == {'status': 'REFUSED_REVIEW_REQUIRED', 'cleanup_errors': []} and
            all(failed[key] is False for key in ('access_verified', 'qualification', 'installation_success', 'identity_stable')) and
            all(failed[key] is None for key in ('append', 'evidence_path', 'pre_close_result_sha256')),
            'AMENDMENT_NOT_EARLY_REFUSAL')
    command = proposal['target_imds']['resourceId'] + '/runCommands/r3-identity-' + proposal['packet_id']
    require(delivery['requests']['command'].split('?', 1)[0] == 'https://management.azure.com' + command and
            prior['id'] != command and prior['exit_code'] == 2, 'AMENDMENT_DIAGNOSTIC_ID')
    return delivery, proposal, prior, command


def corrected_target(amendment):
    delivery, _, _, _ = historical(amendment)
    target = copy.deepcopy(delivery['target'])
    target['imds']['location'] = amendment['diagnostic_report']['field_observations']['location']['value']
    return target


def validate(plan, proposal):
    from r3_access_repair_guest import validate as validate_repair
    validate_repair(proposal)
    delivery, diagnostic, prior, command = historical(plan['amendment'])
    require(plan['target'] == corrected_target(plan['amendment']) and
            proposal['target_imds'] == plan['target']['imds'] and
            plan['custody'] == delivery['custody'] and
            proposal['public_key'] == diagnostic['public_key'] and
            proposal['public_key_sha256'] == diagnostic['public_key_sha256'], 'AMENDMENT_NEW_BINDING')
    require(proposal['packet_id'] not in (diagnostic['packet_id'], prior['proposal']['packet_id']) and
            all(plan['client'][key] == delivery['client'][key] for key in ('kind', 'tenant', 'principal')),
            'AMENDMENT_NEW_ATTEMPT')
    return delivery, diagnostic, prior, command


def legacy_view(plan, proposal):
    """Only the proven controller-plane view uses the historical spelling."""
    delivery, diagnostic, _, _ = validate(plan, proposal)
    view = dict(plan, target=delivery['target'])
    # Guest proposal and payload are never changed by this view.
    return view, dict(proposal, target_imds=diagnostic['target_imds'])


def predecessors(plan, proposal):
    delivery, diagnostic, prior, command = validate(plan, proposal)
    return [(prior['id'], prior['request_body']), (command, delivery['requests']['repair_body'])]


def check_fresh(plan, proposal, fresh, phase):
    require(phase in ('repair', 'export') and fresh['allow_extension_operations'] is True and
            fresh['extensions'] == [], 'AMENDMENT_PHASE_OR_EXTENSIONS')
    ids = [item[0] for item in predecessors(plan, proposal)]
    if phase == 'export':
        ids.append(proposal['target_imds']['resourceId'] + '/runCommands/r3-key-' + proposal['packet_id'])
    observed = fresh['run_commands']
    require(isinstance(observed, list) and all(isinstance(x, str) for x in observed) and
            len(observed) == len(set(observed)) == len(ids) and set(observed) == set(ids), 'AMENDMENT_COMMAND_LIST')
    for key in ('extensions_model_sha256', 'commands_model_sha256'):
        require(isinstance(fresh[key], str) and re.fullmatch('[a-f0-9]{64}', fresh[key]), 'AMENDMENT_LIST_HASH')
    hashes = fresh['predecessor_model_sha256']
    require(isinstance(hashes, dict) and set(hashes) == set(ids[:2]) and
            all(isinstance(v, str) and re.fullmatch('[a-f0-9]{64}', v) for v in hashes.values()), 'AMENDMENT_PRIOR_HASHES')


def check_response(response, plan, proposal, fresh, index):
    from r3_access_repair_contract import load
    from r3_access_repair_control import command_properties
    from r3_access_identity_diagnostic import validate_report
    delivery, diagnostic, prior, command = validate(plan, proposal)
    require(type(index) is int and index in (0, 1), 'AMENDMENT_PRIOR_INDEX')
    command_id, expected = predecessors(plan, proposal)[index]
    require(response['status'] == 200 and sha256(encoded(response['body'])) ==
            fresh['predecessor_model_sha256'][command_id], 'AMENDMENT_PRIOR_CHANGED')
    props = command_properties(response['body'], expected, command_id)
    view = props.get('instanceView', {})
    state, code = ('Failed', 2) if index == 0 else ('Succeeded', 0)
    require(props.get('provisioningState') == state and view.get('executionState') == state and
            type(view.get('exitCode')) is int and view['exitCode'] == code and not view.get('error'), 'AMENDMENT_PRIOR_TERMINAL')
    raw = view.get('output', '').encode()
    require(0 < len(raw) <= 4096, 'AMENDMENT_PRIOR_OUTPUT')
    value = load(raw)
    if index == 1:
        validate_report(value, diagnostic)
    require(value == plan['amendment']['failed_summary' if index == 0 else 'diagnostic_report'], 'AMENDMENT_PRIOR_RESULT')
