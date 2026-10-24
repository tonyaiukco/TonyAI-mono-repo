"""One bounded identity observation; no key append or guest evidence-directory writes."""
import hashlib
import json
import os
import re
import signal
import sys

from r3_access_repair import require
from r3_access_repair_guest import Deadline, expired, validate_envelope
from r3_policy_target import IMDS_FIELDS, identity
from r3_noble_common import digest, encoded

PURPOSE = 'R3_ACCESS_IDENTITY_DIAGNOSTIC'
STATUS = 'IDENTITY_DIAGNOSTIC_REVIEW_REQUIRED'
STAGES = ('validate', 'imds-request', 'imds-size', 'imds-json', 'imds-fields',
          'boot-parent', 'boot-open', 'boot-read', 'boot-format', 'complete', 'comparison')
KINDS = ('null', 'bool', 'number', 'object', 'array', 'string', 'oversize-string', 'invalid-utf8')


def validate_proposal(proposal):
    require(isinstance(proposal, dict) and proposal.get('purpose') == PURPOSE, 'DIAGNOSTIC_PURPOSE')
    validate_envelope(proposal, PURPOSE)


def field(value, expected, budget):
    result = {'kind': 'null', 'characters': None, 'bytes': None, 'sha256': None,
              'value': None, 'exact_match': False, 'case_only_difference': None}
    if not isinstance(value, str):
        result['kind'] = ('null' if value is None else 'bool' if isinstance(value, bool) else
                          'number' if isinstance(value, (int, float)) else 'array' if isinstance(value, list) else 'object')
        return result
    result['characters'] = len(value)
    if len(value) > 2048:
        result['kind'] = 'oversize-string'
        return result
    try:
        raw = value.encode('utf-8')
    except UnicodeError:
        result['kind'] = 'invalid-utf8'
        return result
    result.update(kind='string', bytes=len(raw), sha256=digest(raw), exact_match=value == expected)
    cost = len(encoded(value))
    if value != expected and cost <= budget[0]:
        result['value'] = value
        result['case_only_difference'] = (value.isascii() and expected.isascii() and
                                          value != expected and value.lower() == expected.lower())
        budget[0] -= cost
    return result


def main(proposal):
    validate_proposal(proposal)
    require(sys.platform == 'linux' and os.geteuid() == 0 and sys.dont_write_bytecode, 'GUEST_RUNTIME')
    require(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'EXISTING_TIMER')
    report = {'format': 1, 'purpose': PURPOSE, 'packet_id': proposal['packet_id'],
              'source_sha': proposal['source']['published_sha'], 'status': STATUS,
              'stage': 'validate', 'field_observations': {}, 'boot_id': None,
              'imds_response_bytes': None, 'identity_matches_expected': None, 'error': None,
              'access_verified': False, 'qualification': False, 'installation_success': False}
    budget = [1024]
    def observer(stage, value):
        require(stage in STAGES, 'DIAGNOSTIC_STAGE')
        report['stage'] = stage
        if stage == 'imds-size':
            report['imds_response_bytes'] = value['bytes']
        elif stage == 'imds-fields':
            report['field_observations'] = {key: field(value[key], proposal['target_imds'][key], budget)
                                            for key in IMDS_FIELDS}
        elif stage == 'boot-format':
            boot = value['boot_id']
            report['boot_id'] = boot if re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', boot) else None
    old = signal.signal(signal.SIGALRM, expired)
    signal.alarm(30)
    try:
        observed = identity(observer=observer)
        report['stage'] = 'comparison'
        report['identity_matches_expected'] = observed['imds'] == proposal['target_imds']
    except (Exception, Deadline) as exc:
        error = ('TimeoutError' if isinstance(exc, (TimeoutError, Deadline)) else
                 'OSError' if isinstance(exc, OSError) else
                 'UnicodeError' if isinstance(exc, UnicodeError) else
                 'ValueError' if isinstance(exc, ValueError) else 'OtherError')
        report['error'] = {'type': error, 'errno': exc.errno if error == 'OSError' else None}
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old)
    validate_report(report, proposal)
    return report


def validate_report(value, proposal):
    validate_proposal(proposal)
    keys = {'format', 'purpose', 'packet_id', 'source_sha', 'status', 'stage', 'field_observations',
            'boot_id', 'imds_response_bytes', 'identity_matches_expected', 'error',
            'access_verified', 'qualification', 'installation_success'}
    require(isinstance(value, dict) and set(value) == keys and len(encoded(value)) <= 4096, 'DIAGNOSTIC_REPORT')
    require(type(value['format']) is int and value['format'] == 1 and value['purpose'] == PURPOSE and
            value['packet_id'] == proposal['packet_id'] and value['source_sha'] == proposal['source']['published_sha'] and
            value['status'] == STATUS and value['stage'] in STAGES, 'DIAGNOSTIC_BINDING')
    require(all(value[k] is False for k in ('access_verified', 'qualification', 'installation_success')), 'DIAGNOSTIC_FLAGS')
    count = value['imds_response_bytes']
    require(count is None or type(count) is int and 0 <= count <= 32769, 'DIAGNOSTIC_SIZE')
    fields = value['field_observations']
    require(isinstance(fields, dict) and set(fields) in (set(), set(IMDS_FIELDS)), 'DIAGNOSTIC_FIELDS')
    budget = 0
    for name, item in fields.items():
        require(isinstance(item, dict) and set(item) == {'kind', 'characters', 'bytes', 'sha256', 'value',
                'exact_match', 'case_only_difference'} and item['kind'] in KINDS, 'DIAGNOSTIC_FIELD')
        require(type(item['exact_match']) is bool and
                (item['case_only_difference'] is None or type(item['case_only_difference']) is bool), 'DIAGNOSTIC_MATCH')
        expected = proposal['target_imds'][name]
        if item['kind'] == 'string':
            require(type(item['characters']) is int and 0 <= item['characters'] <= 2048 and
                    type(item['bytes']) is int and 0 <= item['bytes'] <= 8192 and
                    isinstance(item['sha256'], str) and re.fullmatch('[a-f0-9]{64}', item['sha256']), 'DIAGNOSTIC_STRING')
            expected_raw = expected.encode('utf-8')
            require(item['exact_match'] == (item['sha256'] == digest(expected_raw) and
                    item['bytes'] == len(expected_raw) and item['characters'] == len(expected)), 'DIAGNOSTIC_EXACT_MATCH')
            if item['value'] is not None:
                actual = item['value']
                require(isinstance(actual, str) and len(actual) == item['characters'] and
                        len(actual.encode()) == item['bytes'] and digest(actual.encode()) == item['sha256'] and
                        actual != expected, 'DIAGNOSTIC_VALUE')
                require(item['case_only_difference'] == (actual.isascii() and expected.isascii() and
                        actual.lower() == expected.lower()), 'DIAGNOSTIC_CASE')
                budget += len(encoded(actual))
            else:
                require(item['case_only_difference'] is None, 'DIAGNOSTIC_CASE')
        else:
            require(item['bytes'] is None and item['sha256'] is None and item['value'] is None and
                    item['exact_match'] is False and item['case_only_difference'] is None, 'DIAGNOSTIC_NONSTRING')
            chars = item['characters']
            require(chars is None or type(chars) is int and 0 <= chars <= 32768, 'DIAGNOSTIC_CHARACTERS')
    require(budget <= 1024, 'DIAGNOSTIC_VALUE_BUDGET')
    boot = value['boot_id']
    require(boot is None or isinstance(boot, str) and re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', boot), 'DIAGNOSTIC_BOOT')
    error = value['error']
    if error is None:
        require(value['stage'] == 'comparison' and boot is not None and set(fields) == set(IMDS_FIELDS) and
                type(count) is int and 1 <= count <= 32768 and
                all(x['kind'] == 'string' and 1 <= x['characters'] <= 2048 for x in fields.values()) and
                type(value['identity_matches_expected']) is bool and
                value['identity_matches_expected'] == all(x['exact_match'] for x in fields.values()), 'DIAGNOSTIC_COMPLETE')
    else:
        require(isinstance(error, dict) and set(error) == {'type', 'errno'} and
                error['type'] in ('TimeoutError', 'OSError', 'UnicodeError', 'ValueError', 'OtherError') and
                (error['errno'] is None or type(error['errno']) is int and 0 <= error['errno'] <= 4095) and
                (error['type'] == 'OSError' or error['errno'] is None) and
                value['identity_matches_expected'] is None, 'DIAGNOSTIC_ERROR')
    return value


if __name__ == '__main__':
    raise SystemExit('No standalone entry point; separate exact diagnostic delivery approval is required.')
