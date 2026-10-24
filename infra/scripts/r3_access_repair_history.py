"""Validate retained source-only payload envelopes without executing their code."""
import ast
import base64

from r3_access_repair import require, sha256
from r3_noble_common import encoded

# Reviewed immutable source-map anchors for the two shipped predecessors.
# These include controller helpers as well as the guest closure. An internally
# consistent rewritten envelope is not evidence of the published source.
PUBLISHED_CLOSURES = {
    False: ('cc74bd7a940c985e10d2333bd43152f895663aeb',
            '24e9dc15cfeb082ad7ae1b52c9e6c7a959668eade0c2d1a85eac26604bcb60d4'),
    True: ('ff3e37ada40ea86cbfaf0f1b3bfe2a17a010f852',
           '1158ade2d0ae9ebba7a009b3f1ccddded7042b346e9122a6162f3840b81622d6'),
}

# Only the two already shipped historical module closures are supported.
BASE_MODULES = {'r3_noble_common', 'r3_package_state', 'r3_apt_observer', 'r3_install_policy',
                'r3_policy_capture', 'r3_policy_scope', 'r3_policy_evidence', 'r3_policy_validate',
                'r3_policy_target', 'r3_access_repair', 'r3_access_repair_guest', 'r3_access_repair_export'}


def literal_assignment(statement, name):
    from r3_access_repair_contract import load
    require(isinstance(statement, ast.Assign) and len(statement.targets) == 1 and
            isinstance(statement.targets[0], ast.Name) and statement.targets[0].id == name, 'HISTORICAL_ASSIGNMENT')
    call = statement.value
    require(isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute) and
            isinstance(call.func.value, ast.Name) and call.func.value.id == 'json' and call.func.attr == 'loads' and
            len(call.args) == 1 and not call.keywords and isinstance(call.args[0], ast.Constant) and
            isinstance(call.args[0].value, str), 'HISTORICAL_LITERAL')
    return load(call.args[0].value.encode())


def validate_payload(delivery, proposal, *, diagnostic):
    from r3_access_repair_contract import requests
    from r3_access_repair_packet import payload, diagnostic_payload, export_payload
    source = proposal['source']
    require((source['published_sha'], sha256(encoded(source['files']))) == PUBLISHED_CLOSURES[diagnostic] and
            source['sha256'] == sha256(encoded(source['files'])), 'HISTORICAL_PUBLISHED_SOURCE')
    script = delivery['requests']['repair_body']['properties']['source']['script']
    require(isinstance(script, str) and 0 < len(script) <= 512 * 1024, 'HISTORICAL_SCRIPT_SIZE')
    delimiter = 'R3_' + delivery['guest_sha256']
    prefix = "#!/bin/sh\nset -eu\nexec /usr/bin/python3 -I -B - <<'" + delimiter + "'\n"
    suffix = '\n' + delimiter + '\n'
    require(script.startswith(prefix) and script.endswith(suffix), 'HISTORICAL_SHELL_WRAPPER')
    guest = script[len(prefix):-len(suffix)].encode('ascii')
    require(sha256(guest) == delivery['guest_sha256'] and
            requests(proposal, guest) == delivery['requests'] and
            delivery['proposal_sha256'] == sha256(encoded(proposal)), 'HISTORICAL_REQUEST_BINDING')
    tree = ast.parse(guest)
    require(len(tree.body) >= 3, 'HISTORICAL_PYTHON_WRAPPER')
    modules = literal_assignment(tree.body[1], 'modules')
    embedded = literal_assignment(tree.body[2], 'proposal')
    require(embedded == proposal and isinstance(modules, dict), 'HISTORICAL_EMBEDDED_PROPOSAL')
    expected = BASE_MODULES | {'r3_access_identity_diagnostic'} if diagnostic else BASE_MODULES
    require(set(modules) == expected or not diagnostic and set(modules) == BASE_MODULES | {'r3_access_identity_diagnostic'},
            'HISTORICAL_MODULE_CLOSURE')
    for name, value in modules.items():
        require(isinstance(value, str), 'HISTORICAL_MODULE_ENCODING')
        source = base64.b64decode(value, validate=True)
        require(sha256(source) == proposal['source']['files'].get('infra/scripts/' + name + '.py'), 'HISTORICAL_MODULE_HASH')
    factory = diagnostic_payload if diagnostic else payload
    require(factory(proposal, modules=modules) == guest, 'HISTORICAL_PYTHON_WRAPPER')
    export = b'' if diagnostic else export_payload(proposal, modules=modules)
    require(sha256(export) == delivery['export_sha256'], 'HISTORICAL_EXPORT_BINDING')
    return guest
