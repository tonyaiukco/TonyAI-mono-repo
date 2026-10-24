"""New Azure collection entry point; only invoked by a separately approved packet."""
import json
import os
import signal
import sys
from urllib.request import Request, ProxyHandler, HTTPRedirectHandler, build_opener

from r3_noble_common import digest, encoded
from r3_policy_evidence import B_PURPOSE, collect, DOCUMENT_LIMIT
from r3_policy_capture import directory
from r3_policy_validate import require, validate

IMDS_FIELDS = ('resourceId', 'vmId', 'location', 'subscriptionId', 'publisher', 'offer', 'sku', 'version')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError('IMDS redirect refused')


def identity():
    opener = build_opener(ProxyHandler({}), NoRedirect())
    request = Request('http://169.254.169.254/metadata/instance/compute?api-version=2021-02-01',
                      headers={'Metadata': 'true'})
    with opener.open(request, timeout=10) as response:
        raw = response.read(32769)
    require(len(raw) <= 32768)
    compute = json.loads(raw)
    selected = {key: compute.get(key) for key in IMDS_FIELDS}
    require(all(isinstance(v, str) and 0 < len(v) <= 2048 for v in selected.values()))
    fd = directory('/proc/sys/kernel/random')
    try:
        boot = os.open('boot_id', os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=fd)
        try:
            boot_id = os.read(boot, 129).decode().strip()
        finally:
            os.close(boot)
    finally:
        os.close(fd)
    import re
    require(re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', boot_id) is not None)
    return {'imds': selected, 'boot_id': boot_id}


def validate_target(data, proposal):
    from r3_policy_evidence import load
    value = load(data)
    require(isinstance(value, dict) and set(value) == {'format', 'purpose', 'source', 'target',
            'identity_before', 'identity_after', 'evidence', 'failure'})
    require(type(value['format']) is int and value['format'] == 1 and value['purpose'] == B_PURPOSE
            and value['source'] == proposal['source'] and value['target'] == proposal['target'])
    before, after = value['identity_before'], value['identity_after']
    for observed in (before, after):
        if observed is not None:
            import re
            require(isinstance(observed, dict) and set(observed) == {'imds', 'boot_id'})
            require(isinstance(observed['imds'], dict) and set(observed['imds']) == set(IMDS_FIELDS))
            require(all(isinstance(v, str) and 0 < len(v) <= 2048 for v in observed['imds'].values()))
            require(isinstance(observed['boot_id'], str) and re.fullmatch(
                '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', observed['boot_id']) is not None)
    require(value['failure'] in (None, 'OSError', 'ValueError', 'TimeoutError', 'RuntimeError', 'UnicodeError'))
    summary = {'status': 'PARTIAL_REVIEW_REQUIRED', 'qualification': False, 'installation_success': False,
               'policy_generated': False, 'policy_input_hashes': {}, 'packagekit_activation_possible': None}
    if value['evidence'] is not None:
        require(before is not None)
        binding = {'purpose': B_PURPOSE, 'source': proposal['source'], 'target': proposal['target'],
                   'boot_id': before['boot_id']}
        summary = validate(encoded(value['evidence']), binding)
    if (value['failure'] is not None or before is None or before != after
            or before['imds'] != proposal['target']['imds']):
        summary.update(status='PARTIAL_REVIEW_REQUIRED', policy_input_hashes={})
    return summary


def main(proposal):
    from r3_policy_evidence import error_code, CollectionDeadline, deadline_alarm
    value = {'format': 1, 'purpose': B_PURPOSE, 'source': proposal['source'], 'target': proposal['target'],
             'identity_before': None, 'identity_after': None, 'evidence': None, 'failure': None}
    def checkpoint(doc):
        data = encoded(doc)
        require(len(data) <= DOCUMENT_LIMIT - 65536)
        value['evidence'] = json.loads(data)
    signal.signal(signal.SIGALRM, deadline_alarm)
    signal.alarm(300)
    try:
        require(os.geteuid() == 0)
        value['identity_before'] = identity()
        require(value['identity_before']['imds'] == proposal['target']['imds'])
        binding = {'purpose': B_PURPOSE, 'source': proposal['source'], 'target': proposal['target'],
                   'boot_id': value['identity_before']['boot_id']}
        collect(binding, checkpoint)
        value['identity_after'] = identity()
    except (Exception, CollectionDeadline) as exc:
        value['failure'] = error_code(exc)
    finally:
        signal.alarm(30)
        sys.stdout.buffer.write(encoded(value))
        sys.stdout.buffer.flush()
        signal.alarm(0)
    return 0 if validate_target(encoded(value), proposal)['status'] == 'COLLECTED_REVIEW_REQUIRED' else 2
