"""The evidence assistant's release block, its ARM readback and its live form, without a cloud account.

inc29-evidence-assistant task 10.2; `specs/qa-release-operations` (local OpenSpec).
"""
import contextlib
import copy
import io
import json
from pathlib import Path
import re
import unittest
from test_deploy_versions import inputs, app
from deploy_apps import verify
from terraform_run import validate_release
from evidence_assistant_settings import (EVIDENCE_ASSISTANT_ENV, TOLERANCE_PATTERN, evidence_assistant_environment,
                                         live_evidence_assistant, tolerance_text, verify_evidence_assistant_environment)
from pooler import SafeFailure

ROOT = Path(__file__).resolve().parents[2]


def block(enabled=False, tolerance=1.25):
    return {'enabled': enabled, 'tolerance_percent': tolerance}


def release(enabled=False, tolerance=1.25):
    value = inputs()
    value['release']['evidence_assistant'] = block(enabled, tolerance)
    return value


class EvidenceAssistantReleaseTests(unittest.TestCase):
    def test_absent_block_changes_nothing_and_a_complete_one_is_accepted(self):
        plain = inputs()
        self.assertEqual(validate_release(copy.deepcopy(plain)), (plain['foundation'], plain['release']))
        self.assertEqual(evidence_assistant_environment(plain['release']), {})
        for enabled, tolerance, text in ((False, 1.25, '1.25'), (True, 1, '1'), (False, 0, '0'), (True, 100, '100'),
                                         (True, 99.99, '99.99'), (False, 1.0, '1'), (True, 1.10, '1.1'), (True, 0.5, '0.5')):
            value = release(enabled, tolerance)
            with self.subTest(enabled=enabled, tolerance=tolerance):
                validate_release(value)
                self.assertEqual(evidence_assistant_environment(value['release']), {
                    'EVIDENCE_ASSISTANT': {'value': 'on' if enabled else 'off'},
                    'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT': {'value': text}})

    def test_tolerance_precision_and_range_are_the_apis(self):
        # The spec's scenario: 1.255 is refused before any binding, 1.25 is valid.
        self.assertEqual(tolerance_text(1.25), '1.25')
        for bad in (1.255, 100.01, 100.5, 101, -1, -0.5, 0.001, 1e20, float('nan'), float('inf'), True, False, '1', '1.25', None, [1]):
            value = release(tolerance=bad)
            with self.subTest(bad=bad), self.assertRaises(SafeFailure):
                validate_release(value)

    def test_block_needs_its_exact_fields(self):
        for field in block():
            value = release(); del value['release']['evidence_assistant'][field]
            with self.subTest(missing=field), self.assertRaises(SafeFailure): validate_release(value)
        for bad in ('true', 1, 0, None, 'on'):
            value = release(); value['release']['evidence_assistant']['enabled'] = bad
            with self.subTest(enabled=bad), self.assertRaises(SafeFailure): validate_release(value)
        for bad in (None, {}, [], 'off', False, {**block(), 'extra': 1}, {**block(), 'EVIDENCE_ASSISTANT': 'off'}):
            value = inputs(); value['release']['evidence_assistant'] = bad
            with self.subTest(bad=bad), self.assertRaises(SafeFailure): validate_release(value)
        # An unknown top-level key is still refused: the block did not loosen the manifest.
        value = inputs(); value['release']['evidence_assistant_enabled'] = False
        with self.assertRaises(SafeFailure): validate_release(value)

    def test_tolerance_shape_is_the_one_the_api_and_terraform_accept(self):
        source = (ROOT / 'apps/api/src/evidence-assistant/evidence-assistant-config.ts').read_text()
        declared = re.search(r'^const TOLERANCE = /\^(.+)\$/;$', source, re.M)
        self.assertIsNotNone(declared, 'TOLERANCE moved or changed form in evidence-assistant-config.ts')
        self.assertEqual(declared.group(1), TOLERANCE_PATTERN)
        terraform = (ROOT / 'infra/terraform/application/variables.tf').read_text()
        written = re.search(r'can\(regex\("\^(.+)\$", tostring\(var\.release\.evidence_assistant\.tolerance_percent\)\)\)', terraform)
        self.assertIsNotNone(written, 'the Terraform tolerance validation moved or changed form')
        self.assertEqual(written.group(1).replace('\\\\', '\\'), TOLERANCE_PATTERN.replace(r'\d', '[0-9]'))

    def test_every_env_missing_changed_secret_or_duplicate_and_web_refused(self):
        for enabled in (True, False):
            value = release(enabled)
            r = value['release']
            good = [{'name': k, **v} for k, v in evidence_assistant_environment(r).items()]
            self.assertEqual({item['name'] for item in good}, EVIDENCE_ASSISTANT_ENV)
            verify_evidence_assistant_environment(good, r, 'api')
            for i, item in enumerate(good):
                for defect in ('missing', 'wrong', 'secret', 'duplicate'):
                    bad = copy.deepcopy(good)
                    if defect == 'missing': bad.pop(i)
                    if defect == 'wrong': bad[i]['value'] = 'wrong'
                    if defect == 'secret': bad[i]['secretRef'] = 'database-url'
                    if defect == 'duplicate': bad.append(item)
                    with self.subTest(enabled=enabled, item=item['name'], defect=defect), self.assertRaises(SafeFailure):
                        verify_evidence_assistant_environment(bad, r, 'api')
            # The switch is held to its exact released value: a hand flip fails the readback.
            flipped = copy.deepcopy(good)
            next(e for e in flipped if e['name'] == 'EVIDENCE_ASSISTANT')['value'] = 'off' if enabled else 'on'
            with self.assertRaises(SafeFailure): verify_evidence_assistant_environment(flipped, r, 'api')
            # Never on the web app, and never on an API whose release names no block.
            for kind, rel in [('web', r), ('api', inputs()['release'])]:
                with self.subTest(kind=kind), self.assertRaises(SafeFailure): verify_evidence_assistant_environment(good, rel, kind)
        plain = inputs()
        for kind in ('api', 'web'):
            verify_evidence_assistant_environment([{'name': 'PORT', 'value': '3001'}], plain['release'], kind)

    def live(self, value, defect='none'):
        state = {kind: app(kind, value) for kind in ('api', 'web')}
        env = state['api']['properties']['template']['containers'][0]['env']
        if 'evidence_assistant' in value['release'] or defect == 'unreleased':
            source = value if 'evidence_assistant' in value['release'] else release()
            env += [{'name': k, **v} for k, v in evidence_assistant_environment(source['release']).items()]
        if defect == 'switch': next(e for e in env if e['name'] == 'EVIDENCE_ASSISTANT')['value'] = 'on'
        if defect == 'tolerance': next(e for e in env if e['name'] == 'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT')['value'] = '1.250'
        if defect == 'missing': env[:] = [e for e in env if e['name'] != 'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT']
        if defect == 'web-env':
            state['web']['properties']['template']['containers'][0]['env'].append({'name': 'EVIDENCE_ASSISTANT', 'value': 'off'})
        def read(*args):
            if args[:3] == ('containerapp', 'revision', 'list'): return [{'name': 'tonyai-staging-api--r001', 'properties': {'active': True}}]
            return state['api' if args[-1].endswith('-api') else 'web']
        return read

    def test_arm_readback_holds_the_live_api_to_the_release(self):
        value = release()
        for defect in ('none', 'switch', 'tolerance', 'missing', 'web-env'):
            with self.subTest(defect=defect), contextlib.redirect_stdout(io.StringIO()):
                if defect == 'none': verify(value, self.live(value))
                else:
                    with self.assertRaises(SafeFailure): verify(value, self.live(value, defect))
        # The spec's scenario: an unreleased switch on the live API fails the readback.
        plain = inputs()
        with contextlib.redirect_stdout(io.StringIO()):
            verify(plain, self.live(plain))
            with self.assertRaises(SafeFailure): verify(plain, self.live(plain, 'unreleased'))

    def test_live_form_round_trips_and_refuses_what_a_release_would_not_write(self):
        self.assertIsNone(live_evidence_assistant({'PORT': {'name': 'PORT', 'value': '3001'}}))
        for enabled, tolerance in ((False, 1.25), (True, 1), (False, 0), (True, 100), (True, 0.5)):
            env = {k: {'name': k, **v} for k, v in evidence_assistant_environment(release(enabled, tolerance)['release']).items()}
            with self.subTest(enabled=enabled, tolerance=tolerance):
                live = live_evidence_assistant(env)
                self.assertEqual(live, block(enabled, tolerance))
                self.assertIs(type(live['tolerance_percent']), type(tolerance))
        good = {'EVIDENCE_ASSISTANT': {'value': 'off'}, 'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT': {'value': '1.25'}}
        cases = {
            'only the switch': ({'EVIDENCE_ASSISTANT': {'value': 'off'}}, 'incomplete'),
            'only the tolerance': ({'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT': {'value': '1'}}, 'incomplete'),
            'a secret switch': ({**good, 'EVIDENCE_ASSISTANT': {'secretRef': 'database-url'}}, 'plain values'),
            'a secret tolerance': ({**good, 'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT': {'value': '1', 'secretRef': 'x'}}, 'plain values'),
            'a word switch': ({**good, 'EVIDENCE_ASSISTANT': {'value': 'false'}}, 'switch is malformed'),
            'an empty switch': ({**good, 'EVIDENCE_ASSISTANT': {'value': ''}}, 'switch is malformed'),
            'three decimals': ({**good, 'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT': {'value': '1.255'}}, 'tolerance is malformed'),
            'a comma': ({**good, 'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT': {'value': '1,5'}}, 'tolerance is malformed'),
            'above 100': ({**good, 'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT': {'value': '100.5'}}, 'tolerance is malformed'),
            'negative': ({**good, 'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT': {'value': '-1'}}, 'tolerance is malformed'),
            'no value': ({**good, 'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT': {}}, 'tolerance is malformed'),
            'a trailing zero': ({**good, 'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT': {'value': '1.10'}}, 'release form'),
            'a whole number with decimals': ({**good, 'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT': {'value': '100.0'}}, 'release form'),
            'a leading zero': ({**good, 'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT': {'value': '01'}}, 'release form'),
        }
        for name, (env, message) in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(SafeFailure) as caught: live_evidence_assistant(env)
                self.assertIn(message, str(caught.exception))

    def test_example_manifest_names_the_block_in_the_shape_a_release_accepts(self):
        example = json.loads((ROOT / 'infra/config/application.example.json').read_text())
        self.assertEqual(set(example['release']['evidence_assistant']), {'enabled', 'tolerance_percent'})
        value = inputs(); value['release']['evidence_assistant'] = example['release']['evidence_assistant']
        validate_release(value)


if __name__ == '__main__':
    unittest.main()
