"""The evidence assistant's release parameters (inc29-evidence-assistant, design D8, C2).

Two plain values, never secrets: the emergency switch (INC-2.9 §5: the assistant is
on at go-live and switched off only if it misbehaves) and the tolerance (§7: one
setting). Absent from a release, the API's defaults apply (on, 1%) and no setting
reaches it; present, both are always emitted so the readback compares exact values.
"""
from decimal import Decimal, InvalidOperation
import re
from pooler import SafeFailure

EVIDENCE_ASSISTANT_ENV = {'EVIDENCE_ASSISTANT', 'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT'}
FIELDS = {'enabled', 'tolerance_percent'}
# The shape the API accepts (TOLERANCE in apps/api/src/evidence-assistant/
# evidence-assistant-config.ts): any other value stops the API at boot.
# test_evidence_assistant_settings holds the two expressions equal, and the
# Terraform validation is the same expression.
TOLERANCE_PATTERN = r'(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)'


def tolerance_text(value):
    """The tolerance as written for the API: a number from 0 to 100, at most two decimals, in its shortest form.

    The same text Terraform's `tostring()` writes (1 → "1", 1.10 → "1.1"), so a
    release, its plan and the live API name one value one way.
    """
    if type(value) not in (int, float):
        raise SafeFailure('The evidence assistant tolerance must be a number.')
    try:
        number = Decimal(repr(value))
    except InvalidOperation:
        raise SafeFailure('The evidence assistant tolerance must be a number.') from None
    if not number.is_finite():
        raise SafeFailure('The evidence assistant tolerance must be a number.')
    text = format(number.normalize(), 'f')
    if not re.fullmatch(TOLERANCE_PATTERN, text):
        raise SafeFailure('The evidence assistant tolerance must be from 0 to 100 with at most two decimals.')
    return text


def validate_evidence_assistant(release):
    """The optional block: exactly the switch and the tolerance."""
    if 'evidence_assistant' not in release:
        return None
    block = release['evidence_assistant']
    if not isinstance(block, dict) or set(block) != FIELDS:
        raise SafeFailure('The evidence assistant block needs exactly its switch and its tolerance.')
    if type(block['enabled']) is not bool:
        raise SafeFailure('The evidence assistant switch must be a boolean.')
    tolerance_text(block['tolerance_percent'])
    return block


def evidence_assistant_environment(release):
    block = validate_evidence_assistant(release)
    if block is None:
        return {}
    return {'EVIDENCE_ASSISTANT': {'value': 'on' if block['enabled'] else 'off'},
            'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT': {'value': tolerance_text(block['tolerance_percent'])}}


def same_setting(name, live, expected):
    """The switch exactly; the tolerance by value, in any form the API accepts (`1.10` is the release's 1.1)."""
    if name != 'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT':
        return live == expected
    return isinstance(live, str) and re.fullmatch(TOLERANCE_PATTERN, live) is not None and Decimal(live) == Decimal(expected)


def verify_evidence_assistant_environment(items, release, kind):
    """The live app holds exactly the release's settings: none it does not name, none on the web."""
    expected = evidence_assistant_environment(release) if kind == 'api' else {}
    actual = [item for item in items if item.get('name') in EVIDENCE_ASSISTANT_ENV]
    if len(actual) != len(expected) or {item['name'] for item in actual} != set(expected):
        raise SafeFailure('Unexpected, duplicate or missing evidence assistant environment settings.')
    for item in actual:
        if not same_setting(item['name'], item.get('value'), expected[item['name']]['value']) or item.get('secretRef') not in (None, ''):
            raise SafeFailure('Evidence assistant environment differs from the reviewed release.')


def live_evidence_assistant(env):
    """The release block from the live API's settings by name, or None when it holds neither.

    Refused when only one is held, when either is not a plain value, or when a
    value is one the API would refuse at boot. A tolerance the API accepts in
    another form (`1.10`, `100.0`) is carried as its number — the manifest, the
    export and the API share one domain (`specs/qa-release-operations`; review
    of PR B, fourth round).
    """
    present = EVIDENCE_ASSISTANT_ENV & set(env)
    if not present:
        return None
    if present != EVIDENCE_ASSISTANT_ENV:
        raise SafeFailure('Live evidence assistant settings are incomplete; refused.')
    switch, tolerance = env['EVIDENCE_ASSISTANT'], env['EVIDENCE_ASSISTANT_TOLERANCE_PERCENT']
    if any(item.get('secretRef') not in (None, '') for item in (switch, tolerance)):
        raise SafeFailure('Live evidence assistant settings must be plain values; refused.')
    if switch.get('value') not in ('on', 'off'):
        raise SafeFailure('Live evidence assistant switch is malformed.')
    text = tolerance.get('value')
    if not isinstance(text, str) or not re.fullmatch(TOLERANCE_PATTERN, text):
        raise SafeFailure('Live evidence assistant tolerance is malformed.')
    number = Decimal(text)
    # At most two decimals: the double nearest the text writes back as the same decimal.
    value = int(number) if number == number.to_integral_value() else float(text)
    return {'enabled': switch['value'] == 'on', 'tolerance_percent': value}
